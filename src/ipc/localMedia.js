// ── IPC: Local .mp4 playback via loopback HTTP (Range-aware) ─────────────────
// The player <webview> uses partition persist:player. Custom streamstein-media://
// URLs showed the player chrome but video stayed at 0:00 (nested scheme + Range).
// Chromium reliably plays http://127.0.0.1 media with byte-range seeking.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { ipcMain, app } = require("electron");

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
let _activeFfmpeg = null;
let _latestMediaRequestId = 0;

function _debug(message) {
  if (DEBUG_LOCAL_MEDIA) console.log(`[local-media] ${message}`);
}

function _makeToken(filePath, startTime = 0) {
  const token = crypto.randomBytes(16).toString("hex");
  _tokens.set(token, {
    filePath: path.resolve(filePath),
    startTime: Math.max(0, Number(startTime) || 0),
    expiresAt: Date.now() + TOKEN_TTL_MS,
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

function _activateToken(token) {
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

function _fileReady(filePath) {
  try {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return { ok: false, error: "File not found" };
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return { ok: false, error: "Not a file" };
    if (stat.size === 0) return { ok: false, error: "File is empty" };
    if (!_isMp4(resolved)) {
      return {
        ok: false,
        error: "Only local .mp4 files are supported for in-app playback",
      };
    }
    return { ok: true, resolved, size: stat.size };
  } catch (e) {
    return { ok: false, error: e.message || "Cannot read file" };
  }
}

function _candidateAppRoots() {
  const roots = [
    process.cwd(),
    path.resolve(__dirname, "..", ".."),
    typeof app.getAppPath === "function" ? app.getAppPath() : null,
    process.resourcesPath,
  ].filter(Boolean);
  return [...new Set(roots.map((p) => path.resolve(p)))];
}

function _findBundledBinary(name) {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const skipDirs = new Set([
    ".git",
    "dist",
    "node_modules",
    "local-media-cache",
    "out",
    "release",
  ]);

  const commonRelPaths = [
    exe,
    path.join("bin", exe),
    path.join("ffmpeg", exe),
    path.join("ffmpeg", "bin", exe),
    path.join("ffmpeg-master-latest-win64-gpl", "bin", exe),
    path.join("ffmpeg-master-latest-win64-lgpl", "bin", exe),
  ];

  for (const root of _candidateAppRoots()) {
    for (const rel of commonRelPaths) {
      const candidate = path.join(root, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  const visit = (dir, depth) => {
    if (depth > 4) return null;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase() === exe.toLowerCase()) {
        return path.join(dir, entry.name);
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || skipDirs.has(entry.name)) continue;
      const found = visit(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
    return null;
  };

  for (const root of _candidateAppRoots()) {
    const found = visit(root, 0);
    if (found) return found;
  }
  return null;
}

function _findBinary(name) {
  const platform = process.platform;
  const bundled = _findBundledBinary(name);
  if (bundled) return bundled;

  const candidates =
    name === "ffmpeg"
      ? platform === "win32"
        ? ["ffmpeg", "C:\\ffmpeg\\bin\\ffmpeg.exe"]
        : platform === "darwin"
          ? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"]
          : ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"]
      : platform === "win32"
        ? ["ffprobe", "C:\\ffmpeg\\bin\\ffprobe.exe"]
        : platform === "darwin"
          ? ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "ffprobe"]
          : ["/usr/bin/ffprobe", "/usr/local/bin/ffprobe", "ffprobe"];

  for (const bin of candidates) {
    try {
      const r = spawnSync(
        platform === "win32" && !path.isAbsolute(bin) ? "where" : "which",
        [bin],
        { encoding: "utf8", timeout: 1500 },
      );
      if (path.isAbsolute(bin) && fs.existsSync(bin)) return bin;
      if (r.status === 0) return bin;
    } catch {}
  }
  return null;
}

function _probeCodecs(filePath) {
  const ffprobe = _findBinary("ffprobe");
  if (!ffprobe) {
    console.warn("[local-media] ffprobe not found");
    return null;
  }
  _debug(`using ffprobe: ${ffprobe}`);
  try {
    const r = spawnSync(
      ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name",
        "-of",
        "json",
        filePath,
      ],
      { encoding: "utf8", timeout: 10000 },
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
  if (!codecs) return false;
  const videoOk = ["h264", "avc1"].includes(String(codecs.video).toLowerCase());
  const audio = String(codecs.audio || "").toLowerCase();
  const audioOk = !audio || ["aac", "mp3", "mp4a"].includes(audio);
  return videoOk && audioOk;
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
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    _activeFfmpeg = { proc, jobKey };
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    proc.on("error", (e) =>
      resolve({ ok: false, error: e.message || "ffmpeg failed" }),
    );
    proc.on("close", (code) => {
      if (_activeFfmpeg?.proc === proc) _activeFfmpeg = null;
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: stderr || `ffmpeg exited ${code}` });
    });
  });
}

async function _preparePlayableFile(filePath) {
  const codecs = _probeCodecs(filePath);
  const firstMode = _isChromiumFriendly(codecs) ? "remux" : "transcode";
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
        mode === "remux"
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
        console.warn(`[local-media] ${mode} failed: ${r.error}`);
        return { ok: false, error: r.error, mode };
      }
      fs.renameSync(tmpPath, outPath);
      return { ok: true, filePath: outPath, mode, cached: false };
    };

    let prepared = await runPrepare(firstMode);
    if (!prepared.ok && firstMode === "remux") {
      _debug("remux failed; trying full transcode");
      prepared = await runPrepare("transcode");
    }
    if (!prepared.ok) {
      console.warn(`[local-media] prepare failed; using original: ${prepared.error}`);
      return { filePath, prepared: false, mode: "original", codecs };
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
  const check = _fileReady(entry.filePath);
  if (!check.ok) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(check.error || "Not found");
    return;
  }

  const filePath = check.resolved;
  const fileSize = check.size;
  const rangeHeader = req.headers.range;
  _debug(`${req.method} /media/${token.slice(0, 8)} range=${rangeHeader || "full"}`);

  const baseHeaders = {
    "Content-Type": "video/mp4",
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

function _servePlayer(token, res) {
  const entry = _tokens.get(token);
  if (!entry || entry.expiresAt < Date.now()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  const check = _fileReady(entry.filePath);
  if (!check.ok) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(check.error || "Not found");
    return;
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
    console.warn("[local-media]", err.message);
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

async function getPlayerPageUrl(filePath, startTime = 0) {
  const requestId = ++_latestMediaRequestId;
  const check = _fileReady(filePath);
  if (!check.ok) return { ok: false, error: check.error };
  await ensureHttpServer();
  const prepared = await _preparePlayableFile(check.resolved);
  if (requestId !== _latestMediaRequestId) {
    return { ok: false, superseded: true };
  }
  const ready = _fileReady(prepared.filePath);
  if (!ready.ok) return { ok: false, error: ready.error };
  const token = _makeToken(ready.resolved, startTime);
  _activateToken(token);
  _debug(`ready ${path.basename(ready.resolved)} (${ready.size} bytes, ${prepared.mode})`);
  return {
    ok: true,
    url: _playerUrl(token),
    mediaUrl: _mediaUrl(token),
    token,
    filePath: ready.resolved,
    originalFilePath: check.resolved,
    prepared: prepared.prepared,
    prepareMode: prepared.mode,
    codecs: prepared.codecs,
  };
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
    const check = _fileReady(filePath);
    return check.ok;
  });

  ipcMain.handle("local-media-get-url", async (_, { filePath, startTime }) => {
    try {
      const r = await getPlayerPageUrl(filePath, startTime);
      if (!r.ok) return r;
      return { ok: true, url: r.mediaUrl, token: r.token };
    } catch (e) {
      return { ok: false, error: e.message || "Failed to serve file" };
    }
  });

  app.on("will-quit", shutdownHttpServer);
}

module.exports = {
  registerPrivilegedScheme,
  register,
  ensureProtocolHandler,
  ensureHttpServer,
  getPlayerPageUrl,
  shutdownHttpServer,
};
