// ── HLS download via Electron persist:player session ─────────────────────────
// Playback already works in the Chromium webview. yt-dlp uses a different TLS /
// HTTP stack and often gets CDN 403 on the same m3u8. Fetching playlists +
// segments through the player session reuses the exact network identity that
// already streamed successfully, then remuxes with ffmpeg.

const { session } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function isHlsUrl(url) {
  return typeof url === "string" && /\.m3u8(\?|#|$)/i.test(url);
}

function headerGet(headers, name) {
  if (!headers) return "";
  const want = String(name).toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === want) {
      return Array.isArray(v) ? v.join("; ") : String(v || "");
    }
  }
  return "";
}

function buildFetchHeaders(streamHeaders = {}, playerHeaders = {}) {
  const origin =
    headerGet(streamHeaders, "Origin") || playerHeaders.Origin || "";
  const referer =
    headerGet(streamHeaders, "Referer") || playerHeaders.Referer || "";
  const ua = headerGet(streamHeaders, "User-Agent") || DEFAULT_UA;
  const cookie = headerGet(streamHeaders, "Cookie");
  const out = {
    "User-Agent": ua,
    Accept: "*/*",
  };
  if (origin) out.Origin = origin;
  if (referer) out.Referer = referer;
  if (cookie) out.Cookie = cookie;
  return out;
}

async function sessionFetch(url, headers, signal) {
  const ses = session.fromPartition("persist:player");
  if (typeof ses.fetch !== "function") {
    throw new Error("Electron session.fetch is unavailable");
  }
  const res = await ses.fetch(url, {
    method: "GET",
    headers,
    signal,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res;
}

async function fetchText(url, headers, signal) {
  const res = await sessionFetch(url, headers, signal);
  return await res.text();
}

async function fetchBuffer(url, headers, signal) {
  const res = await sessionFetch(url, headers, signal);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function absUrl(maybeRelative, baseUrl) {
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch {
    return maybeRelative;
  }
}

function isMasterPlaylist(text) {
  return /#EXT-X-STREAM-INF/i.test(text);
}

/** Extensions FFmpeg's HLS demuxer will actually probe (not CDN disguises like .jpg). */
const HLS_SAFE_SEG_EXTS = new Set([
  ".ts",
  ".m4s",
  ".mp4",
  ".m4v",
  ".aac",
  ".m4a",
  ".mp3",
  ".cmfv",
  ".cmfa",
]);

function playlistHasMap(text) {
  return /#EXT-X-MAP:/i.test(String(text || ""));
}

function urlPathExt(remoteUrl) {
  try {
    const ext = path.extname(new URL(remoteUrl).pathname).toLowerCase();
    return (ext.split("?")[0] || "").trim();
  } catch {
    return "";
  }
}

function localSegmentExt(remoteUrl, hasMap) {
  const ext = urlPathExt(remoteUrl);
  if (HLS_SAFE_SEG_EXTS.has(ext)) return ext;
  // Videasy/CDN obfuscation often serves MPEG-TS as .jpg/.png/.html/no-ext.
  return hasMap ? ".m4s" : ".ts";
}

function pickBestVariant(masterText, baseUrl) {
  const lines = masterText.split(/\r?\n/);
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
    const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
    const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
    const height = resMatch ? parseInt(resMatch[2], 10) : 0;
    let mediaUrl = "";
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next || next.startsWith("#")) continue;
      mediaUrl = absUrl(next, baseUrl);
      break;
    }
    if (!mediaUrl) continue;
    const score = height * 1e9 + bandwidth;
    if (!best || score > best.score) {
      best = { url: mediaUrl, score, bandwidth, height };
    }
  }
  return best?.url || null;
}

function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const assets = []; // { kind: 'seg'|'key'|'map', url, localName }
  const outLines = [];
  const hasMap = playlistHasMap(text);
  let segIndex = 0;
  let keyIndex = 0;
  let mapIndex = 0;
  let rewrittenSegs = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (line.startsWith("#EXT-X-KEY:") || line.startsWith("#EXT-X-MAP:")) {
      const kind = line.startsWith("#EXT-X-KEY:") ? "key" : "map";
      const m = line.match(/URI="([^"]+)"/i);
      if (m) {
        const remote = absUrl(m[1], baseUrl);
        const localName =
          kind === "key"
            ? `key_${keyIndex++}.key`
            : `init_${mapIndex++}.mp4`;
        assets.push({ kind, url: remote, localName });
        outLines.push(line.replace(/URI="([^"]+)"/i, `URI="${localName}"`));
      } else {
        outLines.push(raw);
      }
      continue;
    }

    if (!line || line.startsWith("#")) {
      outLines.push(raw);
      continue;
    }

    const remote = absUrl(line, baseUrl);
    const origExt = urlPathExt(remote) || "(none)";
    const ext = localSegmentExt(remote, hasMap);
    if (ext !== origExt) rewrittenSegs += 1;
    const localName = `seg_${String(segIndex++).padStart(5, "0")}${ext}`;
    assets.push({ kind: "seg", url: remote, localName });
    outLines.push(localName);
  }

  return {
    playlistText: outLines.join("\n"),
    assets,
    segmentCount: assets.filter((a) => a.kind === "seg").length,
    rewrittenSegs,
    hasMap,
  };
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) || 1 },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i], i);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

function remuxSucceeded(outputPath, code) {
  return (
    code === 0 &&
    fs.existsSync(outputPath) &&
    fs.statSync(outputPath).size > 0
  );
}

function spawnFfmpegOnce(ffmpegPath, args, cwd, onLog) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    proc.stderr.on("data", (c) => {
      const t = c.toString();
      stderr += t;
      onLog?.(t);
    });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code, stderr }));
  });
}

/**
 * Remux a local HLS playlist. Newer FFmpeg (2025+) split allowed_extensions
 * from allowed_segment_extensions and reject CDN disguises like .jpg unless
 * we either rewrite names to .ts/.m4s or pass ALL / extension_picky 0.
 */
async function runFfmpegRemux(ffmpegPath, playlistPath, outputPath, onLog) {
  const cwd = path.dirname(playlistPath);
  const playlistName = path.basename(playlistPath);
  const outAbs = path.resolve(outputPath);

  const inputOptionSets = [
    [
      "-f",
      "hls",
      "-allowed_extensions",
      "ALL",
      "-allowed_segment_extensions",
      "ALL",
      "-extension_picky",
      "0",
      "-protocol_whitelist",
      "file,crypto,data",
    ],
    [
      "-f",
      "hls",
      "-allowed_extensions",
      "ALL",
      "-allowed_segment_extensions",
      "ALL",
      "-protocol_whitelist",
      "file,crypto,data",
    ],
    [
      "-allowed_extensions",
      "ALL",
      "-protocol_whitelist",
      "file,crypto,data",
    ],
  ];
  const outputOptionSets = [
    ["-c", "copy", "-bsf:a", "aac_adtstoasc"],
    ["-c", "copy"],
  ];

  let lastErr = "";
  let lastCode = 1;

  for (const inputOpts of inputOptionSets) {
    for (const outputOpts of outputOptionSets) {
      if (fs.existsSync(outAbs)) {
        try {
          fs.unlinkSync(outAbs);
        } catch {}
      }
      const args = ["-y", ...inputOpts, "-i", playlistName, ...outputOpts, outAbs];
      const { code, stderr } = await spawnFfmpegOnce(
        ffmpegPath,
        args,
        cwd,
        onLog,
      );
      if (remuxSucceeded(outAbs, code)) return outAbs;
      lastCode = code;
      lastErr = stderr;
      if (/unrecognized option/i.test(stderr)) break;
    }
  }

  throw new Error(
    `ffmpeg remux failed (exit ${lastCode}): ${
      String(lastErr || "")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-4)
        .join(" | ")
    }`,
  );
}

/**
 * Download an HLS URL using the same Chromium session as in-app playback.
 * @returns {Promise<{ outputPath: string, segments: number }>}
 */
async function downloadHlsViaPlayerSession({
  m3u8Url,
  outputPath,
  streamHeaders = {},
  playerHeaders = {},
  ffmpegPath,
  onProgress,
  onLog,
  signal,
}) {
  if (!isHlsUrl(m3u8Url)) {
    throw new Error("Not an HLS URL");
  }
  if (!ffmpegPath) {
    throw new Error("ffmpeg not found for HLS remux");
  }
  if (ffmpegPath !== "ffmpeg" && !fs.existsSync(ffmpegPath)) {
    throw new Error("ffmpeg not found for HLS remux");
  }

  const headers = buildFetchHeaders(streamHeaders, playerHeaders);
  const workDir = path.join(
    os.tmpdir(),
    `streamstein_hls_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
  );
  fs.mkdirSync(workDir, { recursive: true });

  const log = (msg) => {
    try {
      onLog?.(msg);
    } catch {}
  };

  try {
    log(`[session-hls] Fetching playlist via persist:player…`);
    onProgress?.({
      progress: 1,
      lastMessage: "Fetching playlist (browser session)…",
    });

    let playlistUrl = m3u8Url;
    let playlistText = await fetchText(playlistUrl, headers, signal);

    if (isMasterPlaylist(playlistText)) {
      const variant = pickBestVariant(playlistText, playlistUrl);
      if (!variant) throw new Error("HLS master playlist has no variants");
      log(`[session-hls] Selected variant: ${variant}`);
      playlistUrl = variant;
      playlistText = await fetchText(playlistUrl, headers, signal);
    }

    const parsed = parseMediaPlaylist(playlistText, playlistUrl);
    if (!parsed.segmentCount) {
      throw new Error("HLS playlist has no segments");
    }

    if (parsed.rewrittenSegs) {
      log(
        `[session-hls] Rewrote ${parsed.rewrittenSegs} segment URI(s) to .ts/.m4s (CDN used a non-media extension ffmpeg rejects)`,
      );
    }
    log(
      `[session-hls] Downloading ${parsed.segmentCount} segments + keys via browser session…`,
    );
    onProgress?.({
      progress: 3,
      totalFragments: parsed.segmentCount,
      completedFragments: 0,
      lastMessage: `HLS: ${parsed.segmentCount} fragments (browser session)`,
    });

    let completedSegs = 0;
    await mapPool(parsed.assets, 6, async (asset) => {
      if (signal?.aborted) throw new Error("Cancelled");
      const buf = await fetchBuffer(asset.url, headers, signal);
      fs.writeFileSync(path.join(workDir, asset.localName), buf);
      if (asset.kind === "seg") {
        completedSegs += 1;
        const pct = Math.min(
          92,
          Math.round((completedSegs / parsed.segmentCount) * 90) + 3,
        );
        onProgress?.({
          progress: pct,
          totalFragments: parsed.segmentCount,
          completedFragments: completedSegs,
          lastMessage: `Fragment ${completedSegs} / ${parsed.segmentCount}`,
        });
      }
    });

    const localPlaylist = path.join(workDir, "index.m3u8");
    fs.writeFileSync(localPlaylist, parsed.playlistText, "utf8");

    onProgress?.({
      progress: 94,
      completedFragments: parsed.segmentCount,
      totalFragments: parsed.segmentCount,
      lastMessage: "Fragments complete — merging…",
      mergeStartedAt: Date.now(),
    });
    log(`[session-hls] Remuxing with ffmpeg…`);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (fs.existsSync(outputPath)) {
      try {
        fs.unlinkSync(outputPath);
      } catch {}
    }

    await runFfmpegRemux(ffmpegPath, localPlaylist, outputPath, (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) log(`[ffmpeg] ${line.trim()}`);
      }
    });

    onProgress?.({
      progress: 100,
      lastMessage: "Download finished (browser session)",
    });
    log(`[session-hls] Saved ${outputPath}`);

    return { outputPath, segments: parsed.segmentCount };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}

module.exports = {
  isHlsUrl,
  downloadHlsViaPlayerSession,
  buildFetchHeaders,
};
