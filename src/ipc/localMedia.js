// ── IPC: Local .mp4 playback via loopback HTTP (Range-aware) ─────────────────
// The player <webview> uses partition persist:player. Custom streamstein-media://
// URLs showed the player chrome but video stayed at 0:00 (nested scheme + Range).
// Chromium reliably plays http://127.0.0.1 media with byte-range seeking.

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { ipcMain, app } = require("electron");
const toolPaths = require("./toolPaths");

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const HOST = "127.0.0.1";
const DEBUG_LOCAL_MEDIA = process.env.STREAMSTEIN_LOCAL_MEDIA_DEBUG === "1";

/** token -> { filePath, startTime, expiresAt } */
const _tokens = new Map();
/** token -> Set<fs.ReadStream> */
const _activeStreams = new Map();

let _server = null;
let _port = null;
let _serverReady = null;
const _prepareJobs = new Map();
/** @type {Map<string, Promise<{ok: boolean}>>} */
const _bgPrepareJobs = new Map();
let _activeFfmpeg = null;
let _latestMediaRequestId = 0;
const FFMPEG_PREPARE_TIMEOUT_MS = 45 * 60 * 1000;

function _debug(message) {
  if (DEBUG_LOCAL_MEDIA) console.log(`[local-media] ${message}`);
}

function _makeToken(filePath, startTime = 0, extra = {}) {
  const token = crypto.randomBytes(16).toString("hex");
  _tokens.set(token, {
    filePath: path.resolve(filePath),
    startTime: Math.max(0, Number(startTime) || 0),
    expiresAt: Date.now() + TOKEN_TTL_MS,
    ...extra,
  });
  return token;
}

function _destroyStreamsForToken(token) {
  const streams = _activeStreams.get(token);
  if (!streams) return;
  for (const stream of streams) {
    try {
      stream.destroy();
    } catch {}
  }
  _activeStreams.delete(token);
}

/** @param {{ exclusive?: boolean }} [options] — false for subtitle tokens so video stays valid */
function _activateToken(token, options = {}) {
  const exclusive = options.exclusive !== false;
  if (!exclusive) return;
  for (const tok of [..._tokens.keys()]) {
    if (tok === token) continue;
    _tokens.delete(tok);
    _destroyStreamsForToken(tok);
  }
}

function _trackStream(token, stream) {
  let streams = _activeStreams.get(token);
  if (!streams) {
    streams = new Set();
    _activeStreams.set(token, streams);
  }
  streams.add(stream);
  const cleanup = () => {
    streams.delete(stream);
    if (streams.size === 0) _activeStreams.delete(token);
  };
  stream.once("close", cleanup);
  stream.once("end", cleanup);
  stream.once("error", cleanup);
}

function _gcTokens() {
  const now = Date.now();
  for (const [tok, e] of _tokens) {
    if (e.expiresAt < now) {
      _tokens.delete(tok);
      _destroyStreamsForToken(tok);
    }
  }
}

setInterval(_gcTokens, 5 * 60 * 1000).unref();

function _isMp4(filePath) {
  return /\.(mp4|m4v)$/i.test(filePath || "");
}

function _isTextTrack(filePath) {
  return /\.(vtt|srt)$/i.test(filePath || "");
}

function _resolveServeFile(filePath) {
  try {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return { ok: false, error: "File not found" };
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return { ok: false, error: "Not a file" };
    if (stat.size === 0) return { ok: false, error: "File is empty" };

    if (_isMp4(resolved)) {
      return {
        ok: true,
        resolved,
        size: stat.size,
        contentType: "video/mp4",
      };
    }

    if (_isTextTrack(resolved)) {
      const ext = path.extname(resolved).toLowerCase();
      return {
        ok: true,
        resolved,
        size: stat.size,
        contentType: ext === ".vtt" ? "text/vtt" : "application/x-subrip",
      };
    }

    return {
      ok: false,
      error: "Only local .mp4/.m4v or subtitle files are supported",
    };
  } catch (e) {
    return { ok: false, error: e.message || "Cannot read file" };
  }
}

function _fileReady(filePath) {
  const check = _resolveServeFile(filePath);
  if (!check.ok) return check;
  if (!_isMp4(check.resolved)) {
    return {
      ok: false,
      error: "Only local .mp4 files are supported for in-app playback",
    };
  }
  return { ok: true, resolved: check.resolved, size: check.size };
}

function _findBinary(name) {
  return toolPaths.resolveTool(name);
}

function _probeCodecs(filePath) {
  const ffprobe = _findBinary("ffprobe");
  if (!ffprobe) {
    _debug("ffprobe not found");
    return null;
  }
  _debug(`using ffprobe: ${ffprobe}`);
  try {
    const r = spawnSync(
      ffprobe,
      [
        "-probesize",
        "32M",
        "-analyzeduration",
        "5M",
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name",
        "-of",
        "json",
        filePath,
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    if (r.status !== 0 || !r.stdout) return null;
    const parsed = JSON.parse(r.stdout);
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    return {
      video:
        streams.find((s) => s.codec_type === "video")?.codec_name || "unknown",
      audio:
        streams.find((s) => s.codec_type === "audio")?.codec_name || null,
    };
  } catch {
    return null;
  }
}

function _isChromiumFriendly(codecs) {
  if (!codecs) return null;
  const video = String(codecs.video || "").toLowerCase();
  const audio = String(codecs.audio || "").toLowerCase();
  const videoOk =
    video.includes("h264") ||
    video.includes("avc1") ||
    video.includes("avc") ||
    video.includes("hevc") ||
    video.includes("h265") ||
    video.includes("hev1");
  const audioOk =
    !audio ||
    audio.includes("aac") ||
    audio.includes("mp3") ||
    audio.includes("mp4a") ||
    audio.includes("mpeg4generic");
  return videoOk && audioOk;
}

function _isVideoCopyFriendly(codecs) {
  if (!codecs) return false;
  const video = String(codecs.video || "").toLowerCase();
  return (
    video.includes("h264") ||
    video.includes("avc1") ||
    video.includes("avc")
  );
}

/** Anything not confirmed h264+aac/mp3 needs ffmpeg (YouTube often uses opus/vp9). */
function _shouldUseLiveTranscode(codecs) {
  if (!_findBinary("ffmpeg")) return false;
  return _isChromiumFriendly(codecs) !== true;
}

function _findExistingCache(filePath) {
  for (const mode of ["faststart", "remux", "audio-remux", "transcode"]) {
    try {
      const cachedPath = _cachePathFor(filePath, mode);
      if (fs.existsSync(cachedPath) && fs.statSync(cachedPath).size > 0) {
        return { filePath: cachedPath, mode: `${mode}-cached` };
      }
    } catch {
      // try next mode
    }
  }
  return null;
}

function _buildUrlResponse({
  servePath,
  originalPath,
  startTime,
  prepareMode,
  prepared,
  codecs,
  liveTranscode = false,
}) {
  const token = _makeToken(
    servePath,
    startTime,
    liveTranscode ? { liveTranscode: true, codecs: codecs || null } : {},
  );
  _activateToken(token);
  return {
    ok: true,
    url: _playerUrl(token),
    mediaUrl: _mediaUrl(token),
    token,
    filePath: servePath,
    originalFilePath: originalPath,
    prepared: !!prepared,
    prepareMode,
    codecs: codecs || null,
  };
}

function _cachePathFor(filePath, mode) {
  const stat = fs.statSync(filePath);
  const key = crypto
    .createHash("sha1")
    .update(`${filePath}:${stat.size}:${stat.mtimeMs}:${mode}`)
    .digest("hex");
  const dir = path.join(app.getPath("userData"), "local-media-cache");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${key}.mp4`);
}

function _sanitizeFfmpegStderr(stderr) {
  return String(stderr || "")
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (/^\[libx264\b/i.test(t)) return false;
      if (/^\[ffmpeg\b/i.test(t)) return false;
      if (/^\[aac\b/i.test(t)) return false;
      if (/^\[h264\b/i.test(t)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function _runFfmpeg(args, jobKey) {
  const ffmpeg = _findBinary("ffmpeg");
  if (!ffmpeg) return Promise.resolve({ ok: false, error: "ffmpeg not found" });
  _debug(`using ffmpeg: ${ffmpeg}`);

  if (
    _activeFfmpeg?.proc &&
    !_activeFfmpeg.proc.killed &&
    _activeFfmpeg.jobKey !== jobKey
  ) {
    try {
      _activeFfmpeg.proc.kill();
    } catch {}
  }

  return new Promise((resolve) => {
    const proc = spawn(
      ffmpeg,
      ["-hide_banner", "-nostats", "-loglevel", "error", ...args],
      { windowsHide: true },
    );
    _activeFfmpeg = { proc, jobKey };
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      finish({ ok: false, error: "ffmpeg prepare timed out" });
    }, FFMPEG_PREPARE_TIMEOUT_MS);
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    proc.on("error", (e) =>
      finish({ ok: false, error: e.message || "ffmpeg failed" }),
    );
    proc.on("close", (code) => {
      if (_activeFfmpeg?.proc === proc) _activeFfmpeg = null;
      if (code === 0) finish({ ok: true });
      else {
        const clean = _sanitizeFfmpegStderr(stderr);
        finish({
          ok: false,
          error: clean || `ffmpeg exited ${code}`,
        });
      }
    });
  });
}

function _scheduleBackgroundPrepare(filePath) {
  const resolved = path.resolve(filePath);
  if (_findExistingCache(resolved)) return;
  if (_bgPrepareJobs.has(resolved)) return;
  const job = _preparePlayableFile(resolved)
    .catch((err) => {
      _debug(
        `background prepare failed: ${path.basename(resolved)} — ${err?.message || err}`,
      );
      return { ok: false };
    })
    .finally(() => {
      _bgPrepareJobs.delete(resolved);
    });
  _bgPrepareJobs.set(resolved, job);
}

async function _preparePlayableFile(filePath) {
  const codecs = _probeCodecs(filePath);
  let firstMode = "transcode";
  if (_isChromiumFriendly(codecs) === true) {
    firstMode = "remux";
  } else if (_isVideoCopyFriendly(codecs)) {
    firstMode = "audio-remux";
  }
  const key = `${filePath}:${firstMode}`;
  if (_prepareJobs.has(key)) return _prepareJobs.get(key);

  const job = (async () => {
    const runPrepare = async (mode) => {
      const outPath = _cachePathFor(filePath, mode);
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        return { ok: true, filePath: outPath, mode, cached: true };
      }

      // Keep a final .mp4 suffix and pass -f mp4; ffmpeg cannot infer format
      // from paths like ".mp4.tmp" on Windows.
      const tmpPath = `${outPath}.tmp.mp4`;
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {}

      const args =
        mode === "faststart"
          ? [
              "-y",
              "-i",
              filePath,
              "-map",
              "0:v:0",
              "-map",
              "0:a?",
              "-c",
              "copy",
              "-dn",
              "-movflags",
              "+faststart",
              "-f",
              "mp4",
              tmpPath,
            ]
          : mode === "remux"
        ? [
            "-y",
            "-i",
            filePath,
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-c",
            "copy",
            "-dn",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
            tmpPath,
          ]
        : mode === "audio-remux"
          ? [
              "-y",
              "-i",
              filePath,
              "-map",
              "0:v:0",
              "-map",
              "0:a?",
              "-c:v",
              "copy",
              "-c:a",
              "aac",
              "-b:a",
              "160k",
              "-dn",
              "-movflags",
              "+faststart",
              "-f",
              "mp4",
              tmpPath,
            ]
        : [
            "-y",
            "-i",
            filePath,
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-dn",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
            tmpPath,
          ];

      _debug(
        `preparing ${mode} for Chromium (${codecs?.video || "unknown"}/${codecs?.audio || "none"})`,
      );
      const r = await _runFfmpeg(args, key);
      if (!r.ok) {
        _debug(`${mode} failed: ${r.error}`);
        return { ok: false, error: r.error, mode };
      }
      fs.renameSync(tmpPath, outPath);
      return { ok: true, filePath: outPath, mode, cached: false };
    };

    let prepared = await runPrepare("faststart");
    if (!prepared.ok) {
      prepared = await runPrepare(firstMode);
    }
    if (!prepared.ok && firstMode === "remux") {
      _debug("remux failed; trying audio-remux");
      prepared = await runPrepare("audio-remux");
    }
    if (!prepared.ok && (firstMode === "remux" || firstMode === "audio-remux")) {
      _debug("remux/audio-remux failed; trying full transcode");
      prepared = await runPrepare("transcode");
    }
    if (!prepared.ok) {
      _debug(`prepare failed: ${prepared.error}`);
      return { ok: false, error: prepared.error || "Could not prepare file for playback" };
    }
    return {
      filePath: prepared.filePath,
      prepared: true,
      mode: prepared.cached ? `${prepared.mode}-cached` : prepared.mode,
      codecs,
    };
  })();

  _prepareJobs.set(key, job);
  try {
    return await job;
  } finally {
    _prepareJobs.delete(key);
  }
}

function _mediaUrl(token) {
  return `http://${HOST}:${_port}/media/${token}`;
}

function _playerUrl(token) {
  return `http://${HOST}:${_port}/play/${token}`;
}

function _buildPlayerHtml(mediaUrl, startTime) {
  const t = Math.floor(Math.max(0, Number(startTime) || 0));
  const safeSrc = String(mediaUrl)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden}video{width:100%;height:100%;object-fit:contain;display:block}</style>
</head><body>
<video id="v" src="${safeSrc}" controls playsinline preload="auto"></video>
<script>
(function(){
  const v=document.getElementById('v');
  const start=${t};
  function tryStart(){
    if(start>0&&isFinite(v.duration)&&v.duration>start){
      try{v.currentTime=start;}catch(e){}
    }
    v.play().catch(function(){});
  }
  v.addEventListener('loadedmetadata',tryStart,{once:true});
  v.addEventListener('canplay',function(){if(v.paused)v.play().catch(function(){});},{once:true});
  v.addEventListener('error',function(){
    console.error('[local-player] MEDIA_ERR',v.error&&v.error.code,v.error);
  });
})();
</script>
</body></html>`;
}

function _tokenFromPathname(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length).split("/")[0];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function _serveMedia(token, req, res) {
  const entry = _tokens.get(token);
  if (!entry || entry.expiresAt < Date.now()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  if (entry.liveTranscode) {
    _serveLiveTranscode(token, entry, req, res);
    return;
  }

  const check = _resolveServeFile(entry.filePath);
  if (!check.ok) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(check.error || "Not found");
    return;
  }

  const filePath = check.resolved;
  const fileSize = check.size;
  const contentType = entry.contentType || check.contentType || "video/mp4";
  const rangeHeader = req.headers.range;
  _debug(`${req.method} /media/${token.slice(0, 8)} range=${rangeHeader || "full"}`);

  const baseHeaders = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  };

  if (req.method === "HEAD") {
    res.writeHead(200, { ...baseHeaders, "Content-Length": fileSize });
    res.end();
    return;
  }

  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader);
    if (!m) {
      res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
      res.end();
      return;
    }
    let start;
    let end;
    if (!m[1] && m[2]) {
      // RFC 7233 suffix-byte-range-spec: "bytes=-500" means the final 500 bytes.
      const suffixLength = parseInt(m[2], 10);
      if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
        res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
        res.end();
        return;
      }
      start = Math.max(fileSize - suffixLength, 0);
      end = fileSize - 1;
    } else {
      start = m[1] ? parseInt(m[1], 10) : 0;
      end = m[2] ? parseInt(m[2], 10) : fileSize - 1;
      if (Number.isNaN(start)) start = 0;
      if (Number.isNaN(end) || end >= fileSize) end = fileSize - 1;
    }
    if (start > end || start >= fileSize) {
      res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
      res.end();
      return;
    }
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      ...baseHeaders,
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Content-Length": chunkSize,
    });
    const stream = fs.createReadStream(filePath, { start, end });
    _trackStream(token, stream);
    stream
      .on("error", () => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      })
      .pipe(res);
    return;
  }

  res.writeHead(200, { ...baseHeaders, "Content-Length": fileSize });
  const stream = fs.createReadStream(filePath);
  _trackStream(token, stream);
  stream
    .on("error", () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    })
    .pipe(res);
}

/** Stream a fragmented MP4 from ffmpeg stdout — instant start, no full-file prep. */
function _serveLiveTranscode(token, entry, req, res) {
  if (req.method === "HEAD") {
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "none",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end();
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method not allowed");
    return;
  }

  const ffmpeg = _findBinary("ffmpeg");
  if (!ffmpeg) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("ffmpeg not found");
    return;
  }

  const startSec = Math.max(0, Number(entry.startTime) || 0);
  const codecs = entry.codecs || _probeCodecs(entry.filePath);
  const copyVideo = _isVideoCopyFriendly(codecs);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    ...(startSec > 0 ? ["-ss", String(startSec)] : []),
    "-i",
    entry.filePath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c:v",
    copyVideo ? "copy" : "libx264",
    ...(copyVideo
      ? []
      : ["-preset", "ultrafast", "-tune", "zerolatency", "-pix_fmt", "yuv420p"]),
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-dn",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-f",
    "mp4",
    "pipe:1",
  ];

  _debug(`live transcode stream ${path.basename(entry.filePath)}`);

  const proc = spawn(ffmpeg, args, { windowsHide: true });
  proc.stderr.on("data", () => {});
  _activeFfmpeg = { proc, jobKey: `live:${token}` };

  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Transfer-Encoding": "chunked",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });

  let ended = false;
  const cleanup = () => {
    if (ended) return;
    ended = true;
    try {
      if (!proc.killed) proc.kill("SIGKILL");
    } catch {}
    if (_activeFfmpeg?.proc === proc) _activeFfmpeg = null;
  };

  proc.stdout.pipe(res);
  proc.stdout.on("error", cleanup);
  proc.on("error", () => {
    cleanup();
    if (!res.headersSent) res.writeHead(500);
    if (!res.writableEnded) res.end();
  });
  proc.on("close", (code) => {
    if (_activeFfmpeg?.proc === proc) _activeFfmpeg = null;
    if (code !== 0 && !ended) {
      _debug(`live transcode exited ${code}`);
    }
    if (!res.writableEnded) res.end();
    ended = true;
  });
  req.on("close", cleanup);
  res.on("close", cleanup);
}

function _servePlayer(token, res) {
  const entry = _tokens.get(token);
  if (!entry || entry.expiresAt < Date.now()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  if (entry.liveTranscode) {
    if (!fs.existsSync(entry.filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
  } else {
    const check = _fileReady(entry.filePath);
    if (!check.ok) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(check.error || "Not found");
      return;
    }
  }
  const mediaUrl = _mediaUrl(token);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(_buildPlayerHtml(mediaUrl, entry.startTime));
}

function _handleHttpRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${HOST}:${_port}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range",
      });
      res.end();
      return;
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(
        "Streamstein local media server is running. Video URLs are tokenized and use /media/<token>.",
      );
      return;
    }

    const mediaToken = _tokenFromPathname(url.pathname, "/media/");
    if (mediaToken && (req.method === "GET" || req.method === "HEAD")) {
      _serveMedia(mediaToken, req, res);
      return;
    }

    const playToken = _tokenFromPathname(url.pathname, "/play/");
    if (playToken && req.method === "GET") {
      _servePlayer(playToken, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    _debug(`request error: ${err.message}`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}

function ensureHttpServer() {
  if (_port != null) return Promise.resolve(_port);
  if (_serverReady) return _serverReady;

  _serverReady = new Promise((resolve, reject) => {
    _server = http.createServer(_handleHttpRequest);
    _server.on("error", (err) => {
      _serverReady = null;
      reject(err);
    });
    _server.listen(0, HOST, () => {
      _port = _server.address().port;
      _debug(`serving on http://${HOST}:${_port}`);
      resolve(_port);
    });
  });

  return _serverReady;
}

function shutdownHttpServer() {
  if (_activeFfmpeg?.proc && !_activeFfmpeg.proc.killed) {
    try {
      _activeFfmpeg.proc.kill();
    } catch {}
  }
  _activeFfmpeg = null;
  for (const token of [..._activeStreams.keys()]) {
    _destroyStreamsForToken(token);
  }
  _tokens.clear();
  if (_server) {
    try {
      _server.close();
    } catch {}
    _server = null;
    _port = null;
    _serverReady = null;
  }
}

/** Stop ffmpeg prep, HTTP streams, and invalidate in-flight get-url requests. */
function releaseLocalMediaPlayback() {
  _latestMediaRequestId++;
  if (_activeFfmpeg?.proc && !_activeFfmpeg.proc.killed) {
    try {
      _activeFfmpeg.proc.kill("SIGKILL");
    } catch {}
    _activeFfmpeg = null;
  }
  for (const tok of [..._tokens.keys()]) {
    _destroyStreamsForToken(tok);
    _tokens.delete(tok);
  }
  _debug("released local media playback");
}

async function getPlayerPageUrl(filePath, startTime = 0, options = {}) {
  const forcePrepare = !!options.forcePrepare;
  const requestId = ++_latestMediaRequestId;
  await ensureHttpServer();

  // Subtitle tracks: serve immediately (no codec probe / ffmpeg).
  if (_isTextTrack(filePath)) {
    const check = _resolveServeFile(filePath);
    if (!check.ok) return { ok: false, error: check.error };
    const token = _makeToken(check.resolved, 0, {
      contentType: check.contentType,
      isSubtitle: true,
    });
    _activateToken(token, { exclusive: false });
    return {
      ok: true,
      url: _mediaUrl(token),
      mediaUrl: _mediaUrl(token),
      token,
      filePath: check.resolved,
      originalFilePath: check.resolved,
      prepared: false,
      prepareMode: "subtitle",
    };
  }

  const check = _fileReady(filePath);
  if (!check.ok) return { ok: false, error: check.error };

  const codecs = _probeCodecs(check.resolved);

  const cached = _findExistingCache(check.resolved);
  if (cached) {
    if (requestId !== _latestMediaRequestId) {
      return { ok: false, superseded: true };
    }
    _debug(`cache hit ${path.basename(cached.filePath)} (${cached.mode})`);
    return _buildUrlResponse({
      servePath: cached.filePath,
      originalPath: check.resolved,
      startTime,
      prepareMode: cached.mode,
      prepared: true,
      codecs,
    });
  }

  // Instant open: always serve the file with byte-range HTTP (full timeline when
  // Chromium can decode it). Never block the UI on ffmpeg remux here — that left many
  // videos stuck on "Opening local playback…" for minutes. Remux runs in the background
  // and LocalVideoPlayer switches to the cached copy if direct decode fails.
  if (!forcePrepare) {
    if (requestId !== _latestMediaRequestId) {
      return { ok: false, superseded: true };
    }
    const friendly = _isChromiumFriendly(codecs) === true;
    const copyVideo = _isVideoCopyFriendly(codecs);
    const prepareMode = friendly
      ? "direct"
      : copyVideo
        ? "direct-video"
        : "direct-probe";
    if (!friendly) {
      _scheduleBackgroundPrepare(check.resolved);
    }
    _debug(
      `instant direct ${path.basename(check.resolved)} (${codecs?.video || "?"}${codecs?.audio ? `/${codecs.audio}` : ""}) mode=${prepareMode}`,
    );
    return _buildUrlResponse({
      servePath: check.resolved,
      originalPath: check.resolved,
      startTime,
      prepareMode,
      prepared: false,
      codecs,
    });
  }

  const prepared = await _preparePlayableFile(check.resolved);
  if (requestId !== _latestMediaRequestId) {
    return { ok: false, superseded: true };
  }
  if (prepared.ok === false || !prepared.filePath) {
    return {
      ok: false,
      error: prepared.error || "Could not prepare file for playback",
    };
  }
  const ready = _fileReady(prepared.filePath);
  if (!ready.ok) return { ok: false, error: ready.error };
  _debug(
    `prepared ${path.basename(ready.resolved)} (${ready.size} bytes, ${prepared.mode})`,
  );
  return _buildUrlResponse({
    servePath: ready.resolved,
    originalPath: check.resolved,
    startTime,
    prepareMode: prepared.mode,
    prepared: prepared.prepared,
    codecs: prepared.codecs || codecs,
  });
}

/** @deprecated No-op; kept so index.js boot order stays stable. */
function registerPrivilegedScheme() {}

/** Start loopback HTTP server (call from app.whenReady). */
function ensureProtocolHandler() {
  return ensureHttpServer();
}

function register() {
  ipcMain.handle("local-media-get-player-url", async (_, { filePath, startTime }) => {
    try {
      return await getPlayerPageUrl(filePath, startTime);
    } catch (e) {
      return { ok: false, error: e.message || "Failed to open local file" };
    }
  });

  ipcMain.handle("local-media-file-exists", async (_, { filePath }) => {
    const check = _resolveServeFile(filePath);
    return check.ok;
  });

  ipcMain.handle("local-media-get-url", async (_, { filePath, startTime }) => {
    try {
      const r = await getPlayerPageUrl(filePath, startTime);
      if (!r.ok) return r;
      return { ok: true, url: r.mediaUrl, token: r.token, prepareMode: r.prepareMode };
    } catch (e) {
      return { ok: false, error: e.message || "Failed to serve file" };
    }
  });

  ipcMain.handle("local-media-get-prepared-url", async (_, { filePath, startTime }) => {
    try {
      const r = await getPlayerPageUrl(filePath, startTime, { forcePrepare: true });
      if (!r.ok) return r;
      return { ok: true, url: r.mediaUrl, token: r.token, prepareMode: r.prepareMode };
    } catch (e) {
      return { ok: false, error: e.message || "Failed to prepare file" };
    }
  });

  ipcMain.handle("local-media-release", () => {
    releaseLocalMediaPlayback();
    return { ok: true };
  });

  app.on("will-quit", shutdownHttpServer);
}

module.exports = {
  registerPrivilegedScheme,
  register,
  ensureProtocolHandler,
  ensureHttpServer,
  getPlayerPageUrl,
  releaseLocalMediaPlayback,
  shutdownHttpServer,
};
