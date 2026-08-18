// ── IPC: Downloads ────────────────────────────────────────────────────────────
// Manages the download queue, spawns the downloader binary, tracks progress,
// and handles all download-related IPC handlers.

const { app, ipcMain, shell, dialog, session } = require("electron");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const os = require("os");
const toolPaths = require("./toolPaths");
const downloadAuth = require("./downloadAuth");
const hlsSessionDownload = require("./hlsSessionDownload");

// ── Download store ────────────────────────────────────────────────────────────

let downloads = [];
let _downloadsFile = null;
const downloadsFile = () =>
  _downloadsFile ||
  (_downloadsFile = path.join(app.getPath("userData"), "downloads.json"));

// Track running child processes by download id
const activeProcs = new Map();

/** id → { lastActivity, mergeStartedAt, lastFragmentAt, completedFragments } */
const stallState = new Map();
const STALL_CHECK_MS = 15000;
const STALL_LAST_FRAGMENT_MS = 90 * 1000;
const STALL_FRAGMENT_MS = 3 * 60 * 1000;
const STALL_MERGE_MS = 3 * 60 * 1000;
const STALL_ABSOLUTE_MS = 14 * 60 * 1000;
let stallInterval = null;

// Max simultaneous downloader processes (excess jobs stay queued until a slot opens)
let maxConcurrentDownloads = 3;
/** id → spawn params while status is "queued" or awaiting JIT resolve */
const pendingSpawnJobs = new Map();

/** (resolveContext) => Promise<{ ok, url?, error? }> — set for series batch JIT links */
let _resolveStreamForDownload = null;
let _drainRunning = false;

function getActiveDownloadCount() {
  return activeProcs.size;
}

function setResolveStreamForDownload(fn) {
  _resolveStreamForDownload = typeof fn === "function" ? fn : null;
}

async function drainDownloadQueueAsync() {
  if (_drainRunning) return;
  _drainRunning = true;
  try {
    while (getActiveDownloadCount() < maxConcurrentDownloads) {
      const next = downloads.find((d) => d.status === "queued");
      if (!next) break;
      const job = pendingSpawnJobs.get(next.id);
      if (!job) {
        next.status = "error";
        next.lastMessage = "Queued job missing";
        next.completedAt = Date.now();
        sendProgress({
          id: next.id,
          status: "error",
          lastMessage: next.lastMessage,
        });
        continue;
      }

      let m3u8Url = job.m3u8Url;

      // Fresh stream URL immediately before download (avoids expired signed HLS links)
      if (job.resolveContext && _resolveStreamForDownload) {
        const idx = downloads.findIndex((d) => d.id === next.id);
        if (idx !== -1) {
          downloads[idx].status = "resolving";
          downloads[idx].lastMessage = "Fetching fresh stream link…";
          sendProgress({
            id: next.id,
            status: "resolving",
            lastMessage: downloads[idx].lastMessage,
            name: downloads[idx].name,
            season: downloads[idx].season,
            episode: downloads[idx].episode,
            tmdbId: downloads[idx].tmdbId,
          });
        }
        const resolved = await _resolveStreamForDownload(job.resolveContext);
        if (!resolved?.ok || !resolved.url) {
          pendingSpawnJobs.delete(next.id);
          if (idx !== -1) {
            const errMsg =
              resolved?.error || "Could not fetch stream link";
            downloads[idx].status = "error";
            downloads[idx].completedAt = Date.now();
            downloads[idx].lastMessage = errMsg;
            try {
              fs.appendFileSync(
                downloads[idx].logPath,
                `Resolve failed: ${new Date().toISOString()}\n${errMsg}\n${"─".repeat(60)}\n`,
                "utf8",
              );
            } catch {}
            sendProgress({
              id: next.id,
              status: "error",
              lastMessage: downloads[idx].lastMessage,
              name: downloads[idx].name,
            });
          }
          continue;
        }
        m3u8Url = resolved.url;
        if (idx !== -1) {
          downloads[idx].m3u8Url = m3u8Url;
          if (resolved.sourceId) {
            downloads[idx].sourceId = resolved.sourceId;
            job.sourceId = resolved.sourceId;
          }
          try {
            fs.appendFileSync(
              downloads[idx].logPath,
              `Resolved: ${new Date().toISOString()}\nURL: ${m3u8Url}\nSource: ${resolved.sourceId || "unknown"}\n${"─".repeat(60)}\n`,
              "utf8",
            );
          } catch {}
        }
      }

      if (!m3u8Url) {
        pendingSpawnJobs.delete(next.id);
        next.status = "error";
        next.lastMessage = "Missing stream URL";
        next.completedAt = Date.now();
        sendProgress({
          id: next.id,
          status: "error",
          lastMessage: next.lastMessage,
        });
        continue;
      }

      pendingSpawnJobs.delete(next.id);
      next.status = "downloading";
      next.lastMessage = "Starting…";
      sendProgress({
        id: next.id,
        status: "downloading",
        lastMessage: next.lastMessage,
        m3u8Url,
      });
      await spawnDownloadProcess(
        next.id,
        job.binaryPath,
        m3u8Url,
        job.name,
        job.downloadPath,
        job.sourceId,
        job.streamHeaders,
      );
    }
  } finally {
    _drainRunning = false;
  }
}

function drainDownloadQueue() {
  void drainDownloadQueueAsync();
}

// ── Trusted binary registry ───────────────────────────────────────────────────
// Maps session tokens (returned to the Renderer)
const trustedBinaryPaths = new Map(); // token (uuid) → absolute binary path

let _getMainWindow = () => null;

function sendProgress(update) {
  const mw = _getMainWindow();
  if (mw && !mw.isDestroyed()) {
    mw.webContents.send("download-progress", update);
  }
}

function loadDownloads() {
  try {
    const raw = fs.readFileSync(downloadsFile(), "utf8");
    const parsed = JSON.parse(raw);
    // Deduplicate: keep only the newest entry per (tmdbId, mediaType, season, episode)
    const seen = new Map();
    const sorted = [...parsed].sort(
      (a, b) =>
        (b.completedAt || b.startedAt || 0) -
        (a.completedAt || a.startedAt || 0),
    );
    for (const d of sorted) {
      const key =
        d.tmdbId && d.mediaType
          ? `${d.tmdbId}|${d.mediaType}|${d.season ?? ""}|${d.episode ?? ""}`
          : d.id;
      if (!seen.has(key)) seen.set(key, d);
    }
    downloads = [...seen.values()];
    let repaired = false;
    for (const d of downloads) {
      if (d.status !== "completed" || !d.filePath) continue;
      const incompleteMsg = detectIncompleteDownload(d, d.filePath);
      if (incompleteMsg) {
        d.status = "error";
        d.lastMessage = incompleteMsg;
        d.filePath = null;
        repaired = true;
      }
    }
    if (repaired) saveDownloads();
  } catch {
    downloads = [];
  }
}

function saveDownloads() {
  try {
    const toSave = downloads.filter(
      (d) =>
        d.status !== "downloading" &&
        d.status !== "queued" &&
        d.status !== "resolving",
    );
    fs.writeFileSync(downloadsFile(), JSON.stringify(toSave, null, 2));
  } catch {}
}

function touchDownloadActivity(id, extra = {}) {
  const prev = stallState.get(id) || {};
  const now = Date.now();
  const frag =
    extra.completedFragments != null
      ? extra.completedFragments
      : prev.completedFragments;
  const fragAdvanced =
    extra.completedFragments != null &&
    extra.completedFragments !== prev.completedFragments;
  stallState.set(id, {
    lastActivity: now,
    mergeStartedAt: extra.mergeStartedAt ?? prev.mergeStartedAt ?? null,
    completedFragments: frag ?? null,
    lastFragmentAt: fragAdvanced ? now : prev.lastFragmentAt ?? now,
  });
}

function findFfmpeg() {
  return toolPaths.resolveTool("ffmpeg");
}

function normalizeStem(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getSafeStem(name) {
  return (name || "video")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .trim();
}

function formatBytes(n) {
  if (n > 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n > 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n > 1e3) return (n / 1e3).toFixed(1) + " KB";
  return n + " B";
}

/** Leftover yt-dlp temps mean merge did not finish — do not treat as completed. */
function detectIncompleteDownload(dl, candidatePath) {
  if (!dl?.downloadPath) return null;
  const stem = getSafeStem(dl.name);
  const artifacts = listYtDlpPartArtifacts(dl.downloadPath, stem);
  const mainParts = artifacts.filter(
    (a) => a.fragIndex == null && /\.part$/i.test(a.name),
  );
  const fragParts = artifacts.filter((a) => a.fragIndex != null);

  if (mainParts.length > 0) {
    const names = mainParts.map((a) => a.name).join(", ");
    const sizes = mainParts.map((a) => formatBytes(a.size)).join(", ");
    return `Incomplete download — leftover file(s): ${names} (${sizes}). Remove partials and retry.`;
  }
  if (fragParts.length > 0) {
    return `Incomplete merge — ${fragParts.length} fragment file(s) remain. Retry download.`;
  }

  if (candidatePath && fs.existsSync(candidatePath)) {
    let videoSize = 0;
    try {
      videoSize = fs.statSync(candidatePath).size;
    } catch {
      return null;
    }
    const base = path.basename(candidatePath);
    const siblingPart = path.join(dl.downloadPath, `${base}.part`);
    if (fs.existsSync(siblingPart)) {
      try {
        const partSize = fs.statSync(siblingPart).size;
        if (partSize > 1024 * 1024) {
          return `Merge incomplete — ${path.basename(siblingPart)} (${formatBytes(partSize)}) is larger than ${base} (${formatBytes(videoSize)}). Retry download.`;
        }
      } catch {}
    }
  }

  return null;
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

function unlinkWithRetry(filePath, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return true;
    } catch {
      if (i < attempts - 1) sleepSync(120 * (i + 1));
    }
  }
  return false;
}

function renameWithRetry(from, to, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      if (!fs.existsSync(from)) return false;
      if (fs.existsSync(to)) unlinkWithRetry(to);
      fs.renameSync(from, to);
      return fs.existsSync(to);
    } catch {
      if (i < attempts - 1) sleepSync(120 * (i + 1));
    }
  }
  return false;
}

function copyWithRetry(from, to, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.copyFileSync(from, to);
      return fs.existsSync(to) && fs.statSync(to).size > 0;
    } catch {
      if (i < attempts - 1) sleepSync(120 * (i + 1));
    }
  }
  return false;
}

/** yt-dlp HLS temps: `Title.mp4.part-Frag507.part` and `Title.mp4.part` */
function fragIndexFromFilename(filename) {
  const m = filename.match(/\.part-Frag(\d+)\.part$/i);
  return m ? parseInt(m[1], 10) : null;
}

function fileMatchesStem(filename, baseStem) {
  if (!baseStem) return true;
  const low = filename.toLowerCase();
  const stemLow = baseStem.toLowerCase();
  if (low.startsWith(stemLow)) return true;
  const hint = normalizeStem(baseStem).slice(0, 14);
  return hint.length > 0 && normalizeStem(filename).includes(hint);
}

function listYtDlpPartArtifacts(dir, baseStem) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => {
        const low = f.toLowerCase();
        if (!fileMatchesStem(f, baseStem)) return false;
        return (
          /\.part-Frag\d+\.part$/i.test(low) ||
          (/\.part$/i.test(low) && !/frag/i.test(low))
        );
      })
      .map((f) => {
        const full = path.join(dir, f);
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {}
        return {
          path: full,
          name: f,
          size,
          fragIndex: fragIndexFromFilename(f),
        };
      });
  } catch {
    return [];
  }
}

function concatListPathForFfmpeg(filePath) {
  const normalized = path.resolve(filePath).replace(/\\/g, "/");
  return normalized.replace(/'/g, "'\\''");
}

function tryFfmpegConcat(dir, outputPath, inputFiles) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg || inputFiles.length < 1) return false;
  const listPath = path.join(
    dir,
    `_recover_${crypto.randomBytes(4).toString("hex")}.txt`,
  );
  try {
    const body = inputFiles
      .map((f) => `file '${concatListPathForFfmpeg(f)}'`)
      .join("\n");
    fs.writeFileSync(listPath, body, "utf8");
    const r = spawnSync(
      ffmpeg,
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-c",
        "copy",
        outputPath,
      ],
      { encoding: "utf8", timeout: 600000, windowsHide: true },
    );
    try {
      fs.unlinkSync(listPath);
    } catch {}
    return (
      r.status === 0 &&
      fs.existsSync(outputPath) &&
      fs.statSync(outputPath).size > 0
    );
  } catch {
    try {
      fs.unlinkSync(listPath);
    } catch {}
    return false;
  }
}

function tryBinaryConcat(outputPath, inputFiles) {
  if (!inputFiles.length) return false;
  const tmpPath = `${outputPath}.recovering`;
  try {
    if (fs.existsSync(tmpPath)) unlinkWithRetry(tmpPath);
    const out = fs.openSync(tmpPath, "w");
    try {
      for (const file of inputFiles) {
        const data = fs.readFileSync(file);
        fs.writeSync(out, data);
      }
    } finally {
      fs.closeSync(out);
    }
    if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0) return false;
    if (fs.existsSync(outputPath)) unlinkWithRetry(outputPath);
    if (!renameWithRetry(tmpPath, outputPath)) {
      return copyWithRetry(tmpPath, outputPath);
    }
    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
  } catch {
    try {
      if (fs.existsSync(tmpPath)) unlinkWithRetry(tmpPath);
    } catch {}
    return false;
  }
}

function fragmentSetUsable(fragParts, total) {
  if (fragParts.length < 2) return false;
  if (total === 0) return true;
  if (fragParts.length < Math.max(2, Math.floor(total * 0.9))) return false;
  const indices = new Set(fragParts.map((a) => a.fragIndex));
  let gaps = 0;
  for (let i = 0; i < total; i++) {
    if (!indices.has(i)) gaps++;
  }
  return gaps <= Math.max(1, Math.ceil(total * 0.05));
}

function tryRecoverPartialDownload(dl) {
  if (!dl?.downloadPath) return null;
  const dir = dl.downloadPath;
  const safeStem = getSafeStem(dl.name);
  const outPath = path.join(dir, `${safeStem}.mp4`);

  const artifacts = listYtDlpPartArtifacts(dir, safeStem);
  const fragParts = artifacts
    .filter((a) => a.fragIndex != null && a.size > 0)
    .sort((a, b) => a.fragIndex - b.fragIndex);

  const total = dl.totalFragments || 0;
  const mainPart = artifacts.find(
    (a) =>
      a.fragIndex == null &&
      /\.part$/i.test(a.name) &&
      a.size > 5 * 1024 * 1024,
  );

  let existingSize = 0;
  const existingPath =
    dl.filePath && fs.existsSync(dl.filePath)
      ? dl.filePath
      : fs.existsSync(outPath)
        ? outPath
        : null;
  if (existingPath) {
    try {
      existingSize = fs.statSync(existingPath).size;
    } catch {}
  }

  // A .part larger than the .mp4 means merge failed — prefer the .part file.
  if (mainPart && mainPart.size > existingSize * 1.02) {
    if (existingPath) unlinkWithRetry(existingPath);
    if (renameWithRetry(mainPart.path, outPath)) {
      if (fs.statSync(outPath).size > 1024 * 1024) return outPath;
    }
    if (copyWithRetry(mainPart.path, outPath)) {
      if (fs.statSync(outPath).size > 1024 * 1024) return outPath;
    }
  }

  if (fragmentSetUsable(fragParts, total)) {
    const paths = fragParts.map((a) => a.path);
    if (existingPath && existingSize > 0) unlinkWithRetry(existingPath);
    if (tryFfmpegConcat(dir, outPath, paths)) return outPath;
    if (tryBinaryConcat(outPath, paths)) return outPath;
  }

  if (mainPart && !fs.existsSync(outPath)) {
    if (renameWithRetry(mainPart.path, outPath)) {
      if (fs.statSync(outPath).size > 1024 * 1024) return outPath;
    }
    if (copyWithRetry(mainPart.path, outPath)) {
      if (fs.statSync(outPath).size > 1024 * 1024) return outPath;
    }
  }

  if (fragParts.length === 1 && fragParts[0].size > 5 * 1024 * 1024) {
    if (existingPath) unlinkWithRetry(existingPath);
    if (copyWithRetry(fragParts[0].path, outPath)) {
      if (fs.statSync(outPath).size > 1024 * 1024) return outPath;
    }
  }

  // Only accept an on-disk video when no leftover temps remain.
  if (existingPath && existingSize > 1024 * 1024) {
    if (!detectIncompleteDownload(dl, existingPath)) return existingPath;
  }

  return null;
}

function finalizeDownloadOutcome(idx, { exitCode = 0, stderrBuf = "" } = {}) {
  if (idx === -1) return;
  const dl = downloads[idx];
  let status = exitCode === 0 ? "completed" : "error";

  if (status !== "completed") {
    const recovered = tryRecoverPartialDownload(dl);
    if (recovered) {
      status = "completed";
      downloads[idx].filePath = recovered;
    }
  }

  if (status === "completed" && !downloads[idx].filePath) {
    try {
      const VIDEO_EXTS = [".mp4", ".mkv", ".webm", ".avi", ".ts", ".m4v"];
      const safeStem = getSafeStem(dl.name);
      const match = fs
        .readdirSync(dl.downloadPath)
        .filter((f) => {
          if (!VIDEO_EXTS.some((e) => f.toLowerCase().endsWith(e))) return false;
          if (f.toLowerCase().endsWith(".part")) return false;
          return fileMatchesStem(f, safeStem);
        })
        .map((f) => ({
          f,
          mtime: fs.statSync(path.join(dl.downloadPath, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime)[0];
      if (match) {
        downloads[idx].filePath = path.join(dl.downloadPath, match.f);
      }
    } catch {}
  }

  if (status === "completed" && downloads[idx].filePath) {
    try {
      const ext = path.extname(downloads[idx].filePath) || ".mp4";
      const safeName = getSafeStem(dl.name).replace(/\s+/g, " ");
      if (safeName) {
        const newPath = path.join(dl.downloadPath, safeName + ext);
        if (newPath !== downloads[idx].filePath) {
          if (renameWithRetry(downloads[idx].filePath, newPath)) {
            downloads[idx].filePath = newPath;
          }
        }
      }
    } catch {}
  }

  if (status === "completed") {
    let incompleteMsg = detectIncompleteDownload(
      downloads[idx],
      downloads[idx].filePath,
    );
    if (incompleteMsg) {
      const recovered = tryRecoverPartialDownload(downloads[idx]);
      if (recovered) {
        downloads[idx].filePath = recovered;
        incompleteMsg = detectIncompleteDownload(
          downloads[idx],
          recovered,
        );
      }
      if (incompleteMsg) {
        status = "error";
        downloads[idx].filePath = null;
        downloads[idx].progress = downloads[idx].progress || 0;
        downloads[idx].lastMessage = incompleteMsg;
      }
    }
  }

  downloads[idx].status = status;
  downloads[idx].completedAt = Date.now();

  if (status === "completed") {
    downloads[idx].progress = 100;
    const logPath = downloads[idx].logPath;
    downloads[idx].logPath = null;
    try {
      if (logPath) fs.unlinkSync(logPath);
    } catch {}
    cleanupTempFiles(downloads[idx].downloadPath, downloads[idx].name, {
      forceStemParts: true,
    });
  } else {
    try {
      if (downloads[idx].logPath) {
        fs.appendFileSync(
          downloads[idx].logPath,
          `${"─".repeat(60)}\nFailed: exit code ${exitCode}\nFinished: ${new Date().toISOString()}\n`,
          "utf8",
        );
      }
    } catch {}
    if (!downloads[idx].lastMessage) {
      const errorLine =
        stderrBuf
          .split(/\r\n|\r|\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .reverse()
          .find((l) => /error|failed|unable|cannot|denied/i.test(l)) || "";
      const prev = dl.lastMessage || "";
      const base = errorLine || prev;
      downloads[idx].lastMessage = base
        ? `${base} (exit ${exitCode})`
        : `Download failed (exit code ${exitCode})`;
    }
    cleanupTempFiles(downloads[idx].downloadPath, downloads[idx].name);
  }

  if (downloads[idx].filePath) {
    try {
      const bytes = fs.statSync(downloads[idx].filePath).size;
      downloads[idx].size = formatBytes(bytes);
    } catch {}
  } else {
    downloads[idx].size = "";
  }
}

function startSubtitleDownloads(id) {
  const idx = downloads.findIndex((d) => d.id === id);
  if (idx === -1) return;
  if (
    downloads[idx].status !== "completed" ||
    !downloads[idx].subtitles?.length ||
    !downloads[idx].filePath
  ) {
    return;
  }

  const videoBase = downloads[idx].filePath.replace(/\.[^.]+$/, "");
  const langCounter = {};
  const KNOWN_SUB_EXTS = [".vtt", ".srt", ".ass", ".ssa", ".sub", ".idx"];
  const subPromises = downloads[idx].subtitles.map(
    ({ url, lang, name: subName, file_id }) => {
      const urlClean = url.split("?")[0].split("#")[0];
      const urlExt = path
        .extname(urlClean)
        .toLowerCase()
        .replace(/[^a-z0-9.]/g, "");
      const nameExt = subName
        ? path.extname(subName).toLowerCase().replace(/[^a-z0-9.]/g, "")
        : "";
      const subExt = KNOWN_SUB_EXTS.includes(urlExt)
        ? urlExt
        : KNOWN_SUB_EXTS.includes(nameExt)
          ? nameExt
          : ".srt";
      const safeLang = (lang || "unknown").replace(/[^a-z0-9_-]/gi, "");
      const lIdx = langCounter[safeLang] ?? 0;
      langCounter[safeLang] = lIdx + 1;
      const suffix = lIdx > 0 ? `.${lIdx}` : "";
      const subDestPath = `${videoBase}.${safeLang}${suffix}${subExt}`;
      return downloadSubtitleFile(url, subDestPath).then((ok) =>
        ok
          ? {
              lang: lang || "unknown",
              path: subDestPath,
              file_id: file_id || null,
            }
          : null,
      );
    },
  );
  Promise.all(subPromises).then((results) => {
    const i2 = downloads.findIndex((d) => d.id === id);
    if (i2 === -1) return;
    downloads[i2].subtitlePaths = results.filter(Boolean);
    saveDownloads();
    sendProgress({
      id,
      subtitlePaths: downloads[i2].subtitlePaths,
    });
  });
}

/** Tell the renderer + persist after finalizeDownloadOutcome. */
function publishDownloadOutcome(id) {
  const idx = downloads.findIndex((d) => d.id === id);
  if (idx === -1) return;
  startSubtitleDownloads(id);
  sendProgress({
    id,
    name: downloads[idx].name,
    status: downloads[idx].status,
    progress: downloads[idx].progress,
    completedAt: downloads[idx].completedAt,
    filePath: downloads[idx].filePath,
    size: downloads[idx].size,
    completedFragments: downloads[idx].completedFragments,
    totalFragments: downloads[idx].totalFragments,
    lastMessage: downloads[idx].lastMessage,
    logPath: downloads[idx].logPath,
  });
  saveDownloads();
}

function failStalledDownload(id, message) {
  const proc = activeProcs.get(id);
  if (proc) {
    try {
      proc.kill("SIGKILL");
    } catch {}
    activeProcs.delete(id);
  }
  const idx = downloads.findIndex((d) => d.id === id);
  if (idx === -1) return;
  const recovered = tryRecoverPartialDownload(downloads[idx]);
  if (recovered) {
    downloads[idx].filePath = recovered;
    const incompleteMsg = detectIncompleteDownload(downloads[idx], recovered);
    if (!incompleteMsg) {
      downloads[idx].status = "completed";
      downloads[idx].progress = 100;
      downloads[idx].completedAt = Date.now();
      downloads[idx].lastMessage = "Recovered via fragment merge";
      try {
        if (downloads[idx].logPath) fs.unlinkSync(downloads[idx].logPath);
        downloads[idx].logPath = null;
      } catch {}
      try {
        const bytes = fs.statSync(recovered).size;
        downloads[idx].size = formatBytes(bytes);
      } catch {}
      cleanupTempFiles(downloads[idx].downloadPath, downloads[idx].name, {
        forceStemParts: true,
      });
      sendProgress({
        id,
        status: "completed",
        progress: 100,
        filePath: recovered,
        lastMessage: downloads[idx].lastMessage,
        completedAt: downloads[idx].completedAt,
        size: downloads[idx].size,
      });
      saveDownloads();
      stallState.delete(id);
      drainDownloadQueue();
      return;
    }
    downloads[idx].filePath = null;
    downloads[idx].lastMessage = incompleteMsg;
  }

  downloads[idx].status = "error";
  downloads[idx].completedAt = Date.now();
  if (!downloads[idx].lastMessage) downloads[idx].lastMessage = message;
  cleanupTempFiles(downloads[idx].downloadPath, downloads[idx].name);
  sendProgress({
    id,
    status: "error",
    lastMessage: downloads[idx].lastMessage,
    completedAt: downloads[idx].completedAt,
    logPath: downloads[idx].logPath,
  });
  saveDownloads();
  stallState.delete(id);
  drainDownloadQueue();
}

function checkDownloadStalls() {
  const now = Date.now();
  for (const [id] of activeProcs) {
    const idx = downloads.findIndex((d) => d.id === id);
    if (idx === -1) continue;
    const dl = downloads[idx];
    const st = stallState.get(id) || {
      lastActivity: dl.startedAt,
      lastFragmentAt: dl.startedAt,
    };
    const idle = now - (st.lastActivity || dl.startedAt);
    const fragIdle = now - (st.lastFragmentAt || st.lastActivity || dl.startedAt);
    const total = dl.totalFragments || 0;
    const current = dl.completedFragments || 0;
    const onLastFragment =
      total > 0 && current >= total - 1 && current < total;
    const allFragsReported = total > 0 && current >= total;
    const merging =
      st.mergeStartedAt != null ||
      (dl.lastMessage || "").toLowerCase().includes("merg") ||
      (dl.lastMessage || "").toLowerCase().includes("process");

    if (merging && idle > STALL_MERGE_MS) {
      failStalledDownload(
        id,
        "Merge timed out (tried recovery from .part fragments)",
      );
      continue;
    }
    if (onLastFragment && fragIdle > STALL_LAST_FRAGMENT_MS) {
      failStalledDownload(
        id,
        "Stuck on final fragment — slot freed; retry download (cleaned partial files)",
      );
      continue;
    }
    if (
      total > 0 &&
      current > 0 &&
      current < total - 1 &&
      fragIdle > STALL_FRAGMENT_MS
    ) {
      failStalledDownload(
        id,
        "Fragment download stalled — slot freed; retry download",
      );
      continue;
    }
    if (allFragsReported && !merging && idle > STALL_MERGE_MS) {
      failStalledDownload(
        id,
        "Stuck after fragments finished (tried recovery)",
      );
      continue;
    }
    if (idle > STALL_ABSOLUTE_MS) {
      failStalledDownload(id, "Download stalled (no progress)");
    }
  }
}

function ensureStallMonitor() {
  if (stallInterval) return;
  stallInterval = setInterval(checkDownloadStalls, STALL_CHECK_MS);
  if (typeof stallInterval.unref === "function") stallInterval.unref();
}

const OUTPUT_VIDEO_EXTS = [".mp4", ".mkv", ".webm", ".mov", ".m4v"];

function validateDownloaderFolder(folderPath) {
  if (
    typeof folderPath === "string" &&
    folderPath.includes("vid-dl-cli-only-2.2.1")
  ) {
    const remapped = folderPath
      .split("vid-dl-cli-only-2.2.1")
      .join("vid-dl-cli-only-v.2.3.2");
    const remappedOk = fs.existsSync(path.join(remapped, "_internal"));
    if (remappedOk) {
      folderPath = remapped;
    } else {
      const bundled = toolPaths.resolveVidDlDir();
      if (bundled) folderPath = bundled;
    }
  }
  if (!folderPath) return { ok: false, reason: "no_folder" };
  let entries;
  try {
    entries = fs.readdirSync(folderPath);
  } catch (e) {
    const reason =
      e.code === "EACCES" ? "folder_permission" : "folder_unreadable";
    return { ok: false, reason };
  }
  if (!entries.includes("_internal")) {
    return { ok: false, reason: "no_internal" };
  }
  const binary = entries.find((e) => {
    if (e === "_internal" || e.startsWith(".")) return false;
    try {
      const stat = fs.statSync(path.join(folderPath, e));
      if (!stat.isFile()) return false;
      return process.platform === "win32"
        ? e.endsWith(".exe")
        : !!(stat.mode & 0o111);
    } catch {
      return false;
    }
  });
  if (!binary) return { ok: false, reason: "no_executable" };

  const token = crypto.randomUUID();
  trustedBinaryPaths.set(token, path.join(folderPath, binary));
  return { ok: true, token, exists: true };
}

function extractM3u8FromLog(logPath) {
  if (!logPath) return null;
  try {
    if (!fs.existsSync(logPath)) return null;
    const text = fs.readFileSync(logPath, "utf8");
    let lastUrl = null;
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*URL:\s*(.+)\s*$/i);
      if (!m) continue;
      const url = m[1].trim();
      if (!url || url.startsWith("(")) continue;
      lastUrl = url;
    }
    return lastUrl;
  } catch {
    return null;
  }
}

/** Remove partials and failed outputs so a retry starts clean. */
function purgeDownloadArtifacts(dl) {
  if (!dl) return;
  const stem = getSafeStem(dl.name);

  if (dl.filePath) unlinkWithRetry(dl.filePath);

  for (const sp of dl.subtitlePaths || []) {
    try {
      if (sp?.path && fs.existsSync(sp.path)) unlinkWithRetry(sp.path);
    } catch {}
  }

  if (!dl.downloadPath) return;

  cleanupTempFiles(dl.downloadPath, dl.name, { forceStemParts: true });

  try {
    for (const entry of fs.readdirSync(dl.downloadPath)) {
      const full = path.join(dl.downloadPath, entry);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const ext = path.extname(entry).toLowerCase();
      if (!OUTPUT_VIDEO_EXTS.includes(ext)) continue;
      if (!fileMatchesStem(entry, stem)) continue;
      const incompleteMsg = detectIncompleteDownload(dl, full);
      if (incompleteMsg || dl.status === "error") unlinkWithRetry(full);
    }
  } catch {}
}

function cleanupTempFiles(downloadPath, nameStem, opts = {}) {
  if (!downloadPath) return;
  const { forceStemParts = false } = opts;
  const safeStem = getSafeStem(nameStem);
  const TEMP_PATTERNS = [
    /\.part$/,
    /\.part\.\d+$/,
    /\.part\.tmp$/,
    /\.tmp$/,
    /\.ytdl$/,
    /\.part-Frag\d+$/,
    /\.recovering$/,
    /^_recover_[a-f0-9]+\.txt$/,
  ];
  try {
    const entries = fs.readdirSync(downloadPath);
    for (const entry of entries) {
      const full = path.join(downloadPath, entry);
      const isTemp = TEMP_PATTERNS.some((p) => p.test(entry));
      const isStemPart =
        safeStem &&
        fileMatchesStem(entry, safeStem) &&
        /\.part/i.test(entry);
      if (!isTemp && !isStemPart) continue;
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        if (isStemPart && st.size > 50 * 1024 * 1024 && !forceStemParts)
          continue;
        unlinkWithRetry(full);
      } catch {}
    }
  } catch {}
}

function killAllDownloads() {
  for (const [id, proc] of activeProcs.entries()) {
    try {
      proc.kill("SIGKILL");
    } catch {}
    const idx = downloads.findIndex((d) => d.id === id);
    if (idx !== -1) {
      downloads[idx].status = "error";
      downloads[idx].lastMessage = "Cancelled on exit";
    }
    activeProcs.delete(id);
  }
  for (const d of downloads) {
    if (d.status === "queued" || d.status === "resolving") {
      d.status = "error";
      d.lastMessage = "Cancelled on exit";
      d.completedAt = Date.now();
      pendingSpawnJobs.delete(d.id);
    }
  }
  pendingSpawnJobs.clear();
  const folders = new Set(downloads.map((d) => d.downloadPath).filter(Boolean));
  for (const folder of folders) cleanupTempFiles(folder);
  saveDownloads();
}

// ── Subtitle file downloader (used during run-download completion) ─────────────

function downloadSubtitleFile(url, destPath) {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol === "file:") {
        try {
          fs.copyFileSync(decodeURIComponent(parsedUrl.pathname), destPath);
          resolve(true);
        } catch {
          resolve(false);
        }
        return;
      }
      const lib = parsedUrl.protocol === "https:" ? https : http;
      const req = lib.get(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
            Referer: parsedUrl.origin,
            Accept: "*/*",
          },
        },
        (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            const loc = res.headers.location.startsWith("http")
              ? res.headers.location
              : parsedUrl.origin + res.headers.location;
            downloadSubtitleFile(loc, destPath).then(resolve);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            resolve(false);
            return;
          }
          const file = fs.createWriteStream(destPath);
          res.pipe(file);
          file.on("finish", () => {
            file.close();
            resolve(true);
          });
          file.on("error", () => {
            try {
              fs.unlinkSync(destPath);
            } catch {}
            resolve(false);
          });
          res.on("error", () => resolve(false));
        },
      );
      req.on("error", () => resolve(false));
      req.setTimeout(20000, () => {
        req.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

// Player Origin/Referer for CDN fetches (keep in sync with src/utils/api.js).
const PLAYER_ACCESS_HEADERS = {
  videasy: {
    Origin: "https://player.videasy.to",
    Referer: "https://player.videasy.to/",
  },
  vidsrc: {
    Origin: "https://vsembed.su",
    Referer: "https://vsembed.su/",
  },
  vidking: {
    Origin: "https://www.vidking.net",
    Referer: "https://www.vidking.net/",
  },
  "2embed": {
    Origin: "https://www.vidking.net",
    Referer: "https://www.vidking.net/",
  },
};

function resolvePlayerAccessHeaders(sourceId) {
  const key = String(sourceId || "videasy").toLowerCase();
  return PLAYER_ACCESS_HEADERS[key] || PLAYER_ACCESS_HEADERS.videasy;
}

function buildVidDlSpawnEnv() {
  const env = { ...process.env };
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const prefixes = [];

  try {
    const binDir = toolPaths.getBundledBinDir?.();
    if (binDir && fs.existsSync(binDir)) prefixes.push(binDir);
  } catch {}

  try {
    const ffmpeg = toolPaths.resolveTool("ffmpeg");
    if (ffmpeg && path.isAbsolute(ffmpeg)) {
      prefixes.push(path.dirname(ffmpeg));
    }
  } catch {}

  if (prefixes.length) {
    const current = env[pathKey] || env.PATH || "";
    const ordered = [];
    for (const p of prefixes) {
      const resolved = path.resolve(p);
      if (
        !ordered.some((x) => x.toLowerCase() === resolved.toLowerCase()) &&
        !current.toLowerCase().includes(resolved.toLowerCase())
      ) {
        ordered.push(resolved);
      }
    }
    if (ordered.length) {
      env[pathKey] = `${ordered.join(path.delimiter)}${path.delimiter}${current}`;
    }
  }
  return env;
}

function buildVidDlYtdlpHeaderArgs(sourceId) {
  // Legacy sync helper — prefer buildDownloadAuthYtdlpArgs (async) at spawn time.
  const headers = resolvePlayerAccessHeaders(sourceId);
  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  return [
    `--add-header Origin:${headers.Origin}`,
    `--add-header Referer:${headers.Referer}`,
    `--add-header User-Agent:${ua}`,
  ].join(" ");
}

function uniqueOutputMp4(folder, name) {
  const stem = getSafeStem(name) || "video";
  let out = path.join(folder, `${stem}.mp4`);
  let n = 1;
  while (fs.existsSync(out)) {
    out = path.join(folder, `${stem}_${n}.mp4`);
    n += 1;
  }
  return out;
}

/**
 * Preferred path for movie/TV HLS: download through the same Chromium session
 * that already streamed the video (avoids yt-dlp generic 403 on CDN URLs).
 * @returns {Promise<boolean>} true if handled (success or cancel); false = fall back to vid-dl
 */
async function trySessionHlsDownload(
  id,
  m3u8Url,
  name,
  downloadPath,
  sourceId,
  streamHeaders,
  logPath,
) {
  if (!hlsSessionDownload.isHlsUrl(m3u8Url)) return false;

  const ffmpegPath = findFfmpeg();
  if (!ffmpegPath) {
    try {
      fs.appendFileSync(
        logPath,
        "session-hls: ffmpeg not found — falling back to vid-dl\n",
        "utf8",
      );
    } catch {}
    return false;
  }

  const abort = new AbortController();
  const killer = {
    kill() {
      try {
        abort.abort();
      } catch {}
    },
  };
  activeProcs.set(id, killer);
  touchDownloadActivity(id);
  ensureStallMonitor();

  const appendLog = (line) => {
    try {
      fs.appendFileSync(logPath, `${String(line)}\n`, "utf8");
    } catch {}
  };

  appendLog(
    "Using browser-session HLS download (same network stack as in-app playback)",
  );
  appendLog("─".repeat(60));

  const outputPath = uniqueOutputMp4(downloadPath, name);
  const playerHeaders = resolvePlayerAccessHeaders(sourceId);

  try {
    const result = await hlsSessionDownload.downloadHlsViaPlayerSession({
      m3u8Url,
      outputPath,
      streamHeaders,
      playerHeaders,
      ffmpegPath,
      signal: abort.signal,
      onLog: (msg) => {
        for (const line of String(msg).split(/\r?\n/)) {
          if (line.trim()) appendLog(line.trim());
        }
      },
      onProgress: (update) => {
        const idx = downloads.findIndex((d) => d.id === id);
        if (idx === -1) return;
        downloads[idx] = {
          ...downloads[idx],
          ...update,
          status: "downloading",
        };
        sendProgress({ id, ...update, status: "downloading" });
        touchDownloadActivity(id, {
          completedFragments: update.completedFragments,
          mergeStartedAt: update.mergeStartedAt,
        });
      },
    });

    activeProcs.delete(id);
    stallState.delete(id);

    const idx = downloads.findIndex((d) => d.id === id);
    if (idx === -1) {
      drainDownloadQueue();
      return true;
    }

    downloads[idx].filePath = result.outputPath;
    downloads[idx].lastMessage = "Download finished (browser session)";
    appendLog(`Download finished: ${result.outputPath}`);
    finalizeDownloadOutcome(idx, { exitCode: 0, stderrBuf: "" });
    publishDownloadOutcome(id);
    drainDownloadQueue();
    return true;
  } catch (e) {
    activeProcs.delete(id);
    stallState.delete(id);
    const msg = e?.message || String(e);
    appendLog(`session-hls failed: ${msg}`);
    appendLog("Falling back to vid-dl / yt-dlp…");
    appendLog("─".repeat(60));
    if (/cancel/i.test(msg) || abort.signal.aborted) {
      const idx = downloads.findIndex((d) => d.id === id);
      if (idx !== -1) {
        downloads[idx].status = "error";
        downloads[idx].completedAt = Date.now();
        downloads[idx].lastMessage = "Cancelled";
        sendProgress({ id, status: "error", lastMessage: "Cancelled" });
        saveDownloads();
      }
      drainDownloadQueue();
      return true;
    }
    return false;
  }
}

// ── Spawn downloader child process ────────────────────────────────────────────

async function spawnDownloadProcess(
  id,
  binaryPath,
  m3u8Url,
  name,
  downloadPath,
  sourceId,
  streamHeaders,
) {
  const idx0 = downloads.findIndex((d) => d.id === id);
  if (idx0 === -1) return;

  const logPath = downloads[idx0].logPath;
  const resolvedSource =
    sourceId || downloads[idx0].sourceId || "videasy";
  const headersFromCapture =
    streamHeaders || downloads[idx0].streamHeaders || {};

  // Prefer Chromium session download — same stack that can already play the stream
  const usedSession = await trySessionHlsDownload(
    id,
    m3u8Url,
    name,
    downloadPath,
    resolvedSource,
    headersFromCapture,
    logPath,
  );
  if (usedSession) return;

  let headerArgString = buildVidDlYtdlpHeaderArgs(resolvedSource);
  try {
    const auth = await downloadAuth.buildDownloadAuthYtdlpArgs({
      m3u8Url,
      sourceId: resolvedSource,
      streamHeaders: headersFromCapture,
      playerHeaders: resolvePlayerAccessHeaders(resolvedSource),
    });
    if (auth.argString) headerArgString = auth.argString;
    if (auth.notes?.length) {
      try {
        fs.appendFileSync(
          logPath,
          `Auth: ${auth.notes.join("; ")}\n${"─".repeat(60)}\n`,
          "utf8",
        );
      } catch {}
    }
  } catch (e) {
    try {
      fs.appendFileSync(
        logPath,
        `Auth setup warning: ${e.message || e}\n`,
        "utf8",
      );
    } catch {}
  }

  const args = [
    "--cli",
    m3u8Url,
    "-f",
    "mp4 (with Audio)",
    "-r",
    "best",
    "-b",
    "320",
    "-n",
    name,
    "-d",
    downloadPath,
    "--ytdlp-args",
    headerArgString,
  ];
  const proc = spawn(binaryPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: buildVidDlSpawnEnv(),
  });
  activeProcs.set(id, proc);
  touchDownloadActivity(id);
  ensureStallMonitor();

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const idx = downloads.findIndex((d) => d.id === id);
    if (idx === -1) return;

    const update = {};

    if (
      /unable to download fragment|fragment not found|got error:.*fragment/i.test(
        trimmed,
      )
    ) {
      update.lastMessage = trimmed.slice(0, 200);
      downloads[idx] = { ...downloads[idx], ...update, status: "error" };
      sendProgress({ id, status: "error", lastMessage: update.lastMessage });
      touchDownloadActivity(id);
      try {
        proc.kill("SIGKILL");
      } catch {}
      return;
    }

    const fragMatch = trimmed.match(/\(frag\s+(\d+)\/(\d+)\)/);
    if (fragMatch) {
      const currentFrag = parseInt(fragMatch[1]);
      const total = parseInt(fragMatch[2]);
      update.completedFragments = currentFrag;
      update.totalFragments = total;
      const ratio = total > 0 ? currentFrag / total : 0;
      update.progress =
        currentFrag >= total
          ? 99
          : Math.min(99, Math.round(ratio * 100));
      update.lastMessage =
        currentFrag >= total
          ? `Fragments complete (${total}/${total}) — merging…`
          : `Fragment ${currentFrag} / ${total}`;
      touchDownloadActivity(id, {
        completedFragments: currentFrag,
        mergeStartedAt:
          currentFrag >= total ? Date.now() : undefined,
      });
    }

    if (!fragMatch && !downloads[idx].totalFragments) {
      const dlPctMatch = trimmed.match(
        /^\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*(?:[KMGT]i?B|B))/i,
      );
      if (dlPctMatch) {
        const pct = parseFloat(dlPctMatch[1]);
        update.progress = Math.min(99, Math.round(pct));
        update.size = dlPctMatch[2].trim();
        const spMatch = trimmed.match(/\bat\s+([\d.]+\s*(?:[KMGT]i?B|B)\/s)/i);
        if (spMatch) update.speed = spMatch[1].trim();
        update.lastMessage = `${Math.round(pct)}% of ${update.size}`;
      }
    }

    const durationMatch = trimmed.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (durationMatch) {
      const totalSecs =
        parseInt(durationMatch[1]) * 3600 +
        parseInt(durationMatch[2]) * 60 +
        parseFloat(durationMatch[3]);
      if (totalSecs > 0) downloads[idx]._ffmpegTotalSecs = totalSecs;
      return;
    }

    const ffmpegMatch = trimmed.match(
      /size=\s*([\d.]+\s*\w+)\s+time=(\d+):(\d+):([\d.]+)/i,
    );
    if (ffmpegMatch) {
      const elapsedSecs =
        parseInt(ffmpegMatch[2]) * 3600 +
        parseInt(ffmpegMatch[3]) * 60 +
        parseFloat(ffmpegMatch[4]);
      const totalSecs = downloads[idx]._ffmpegTotalSecs || 0;
      if (totalSecs > 0) {
        update.progress = Math.min(
          99,
          Math.round((elapsedSecs / totalSecs) * 100),
        );
      }
      const rawSize = ffmpegMatch[1].trim();
      const kbMatch = rawSize.match(/([\d.]+)\s*kB/i);
      if (kbMatch) {
        const mb = parseFloat(kbMatch[1]) / 1024;
        update.size =
          mb >= 1024
            ? `${(mb / 1024).toFixed(1)} GiB`
            : `${mb.toFixed(1)} MiB`;
      } else {
        update.size = rawSize;
      }
      const speedXMatch = trimmed.match(/speed=\s*([\d.]+)x/i);
      if (speedXMatch) update.speed = `${speedXMatch[1]}x`;
      update.lastMessage = `Processing… ${update.size}${update.speed ? ` at ${update.speed}` : ""}`;
    }

    const retryMatch =
      trimmed.match(/Retrying\s+\(\d+\/\d+\)/i) ||
      trimmed.match(/Got error:.*timed?\s*out/i) ||
      trimmed.match(/Read timed? out/i);
    if (retryMatch) {
      update.speed = "0 MB/s";
      const retryNumMatch = trimmed.match(/Retrying\s+\((\d+)\/(\d+)\)/i);
      update.lastMessage = retryNumMatch
        ? `Retrying… (${retryNumMatch[1]}/${retryNumMatch[2]})`
        : "Retrying…";
      downloads[idx] = { ...downloads[idx], ...update };
      sendProgress({ id, ...update, status: downloads[idx].status });
      return;
    }

    const speedMatch = trimmed.match(/\bat\s+([\d.]+\s*(?:[KMGT]i?B|B)\/s)/i);
    if (speedMatch) update.speed = speedMatch[1].trim();

    const sizeMatch = trimmed.match(/\bof\s+~?\s*([\d.]+\s*(?:[KMGT]i?B|B))\b/i);
    if (sizeMatch) update.size = sizeMatch[1].trim();

    const fragTotalMatch = trimmed.match(/Total fragments:\s+(\d+)/);
    if (fragTotalMatch) {
      const total = parseInt(fragTotalMatch[1]);
      const u = {
        totalFragments: total,
        completedFragments: 0,
        lastMessage: `HLS: ${total} fragments`,
      };
      downloads[idx] = { ...downloads[idx], ...u };
      sendProgress({ id, ...u, status: downloads[idx].status });
      return;
    }

    const destMatch = trimmed.match(/^\[download\] Destination:\s+(.+)/);
    if (destMatch) {
      const u = {
        filePath: destMatch[1].trim(),
        lastMessage: "Downloading…",
      };
      downloads[idx] = { ...downloads[idx], ...u };
      sendProgress({ id, ...u, status: downloads[idx].status });
      return;
    }

    const mergeMatch = trimmed.match(/\[Merger\] Merging formats into "(.+)"/);
    if (mergeMatch) {
      const u = {
        filePath: mergeMatch[1].trim(),
        lastMessage: "Merging…",
        progress: 99,
      };
      touchDownloadActivity(id, { mergeStartedAt: Date.now() });
      downloads[idx] = { ...downloads[idx], ...u };
      sendProgress({ id, ...u, status: downloads[idx].status });
      return;
    }

    const SUPPRESS_PATTERNS = [
      /Sleeping\s+[\d.]+\s+seconds/i,
      /^\[yt-dlp\s+DEBUG\]/i,
      /^\[debug\]/i,
    ];
    if (Object.keys(update).length === 0) {
      const suppress =
        downloads[idx].lastMessage.startsWith("Fragment") ||
        downloads[idx].lastMessage.startsWith("Retrying") ||
        SUPPRESS_PATTERNS.some((p) => p.test(trimmed));
      if (!suppress) update.lastMessage = trimmed;
    }

    if (Object.keys(update).length > 0) {
      downloads[idx] = { ...downloads[idx], ...update };
      sendProgress({ id, ...update, status: downloads[idx].status });
      touchDownloadActivity(id);
    } else if (trimmed.length > 0) {
      touchDownloadActivity(id);
    }
  };

  let buf = "";
  let stderrBuf = "";

  const appendLog = (line) => {
    try {
      fs.appendFileSync(logPath, line + "\n", "utf8");
    } catch {}
  };

  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r\n|\r|\n/);
    buf = lines.pop();
    lines.forEach((l) => {
      appendLog(l);
      handleLine(l);
    });
  });
  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderrBuf += text;
    text.split(/\r\n|\r|\n/).forEach((l) => {
      appendLog(l);
      handleLine(l);
    });
  });

  proc.on("error", (err) => {
    activeProcs.delete(id);
    const idx = downloads.findIndex((d) => d.id === id);
    if (idx === -1) return;
    const msg =
      err.code === "EACCES"
        ? `Permission denied, binary is not executable: ${binaryPath}`
        : err.code === "ENOENT"
          ? `Binary not found: ${binaryPath}`
          : `Failed to start downloader: ${err.message}`;
    downloads[idx].status = "error";
    downloads[idx].completedAt = Date.now();
    downloads[idx].lastMessage = msg;
    appendLog(msg);
    sendProgress({ id, status: "error", lastMessage: msg });
    drainDownloadQueue();
  });

  proc.on("close", (code) => {
    activeProcs.delete(id);
    stallState.delete(id);
    if (buf.trim()) {
      appendLog(buf.trim());
      handleLine(buf.trim());
    }
    const idx = downloads.findIndex((d) => d.id === id);
    if (idx === -1) {
      drainDownloadQueue();
      return;
    }

    finalizeDownloadOutcome(idx, { exitCode: code, stderrBuf });
    publishDownloadOutcome(id);
    drainDownloadQueue();
  });
}

// ── Enqueue a download (used by IPC + series batch) ───────────────────────────

function enqueueDownload({
  token,
  m3u8Url,
  name,
  downloadPath,
  mediaId,
  mediaType,
  season,
  episode,
  posterPath,
  tmdbId,
  subtitles,
  resolveContext,
  seriesBatchId,
  sourceId,
  streamHeaders,
}) {
  const binaryPath = trustedBinaryPaths.get(token);
  if (!binaryPath) {
    return { ok: false, error: "Invalid or unknown downloader token" };
  }
  const id = crypto.randomUUID();
  const logPath = path.join(os.tmpdir(), `streamstein_dl_${id}.log`);

  if (resolveContext && !_resolveStreamForDownload) {
    return { ok: false, error: "Stream resolver not configured" };
  }
  const deferResolve = !!resolveContext;
  const resolvedSourceId =
    sourceId ||
    resolveContext?.sourceId ||
    resolveContext?.sources?.[0] ||
    "videasy";
  const normalizedStreamHeaders =
    streamHeaders && typeof streamHeaders === "object" ? streamHeaders : {};

  const entry = {
    id,
    name,
    m3u8Url: deferResolve ? null : m3u8Url,
    downloadPath,
    filePath: null,
    status: deferResolve ? "queued" : "downloading",
    progress: 0,
    speed: "",
    size: "",
    totalFragments: 0,
    completedFragments: 0,
    lastMessage: deferResolve
      ? "Queued — stream link fetched when download starts"
      : "Starting…",
    startedAt: Date.now(),
    completedAt: null,
    mediaId: mediaId || null,
    mediaType: mediaType || null,
    season: season ?? null,
    episode: episode ?? null,
    posterPath: posterPath || null,
    tmdbId: tmdbId || mediaId || null,
    subtitles: Array.isArray(subtitles) ? subtitles : [],
    subtitlePaths: [],
    logPath,
    seriesBatchId: seriesBatchId || null,
    sourceId: resolvedSourceId,
    streamHeaders: normalizedStreamHeaders,
  };

  try {
    fs.writeFileSync(
      logPath,
      `Streamstein Download Log\nName: ${name}\nURL: ${deferResolve ? "(fetched when download starts)" : m3u8Url}\nStarted: ${new Date().toISOString()}\n${"─".repeat(60)}\n`,
      "utf8",
    );
  } catch {}

  downloads.push(entry);

  const isSameMedia = (d) =>
    d.id !== id &&
    d.tmdbId &&
    d.tmdbId === entry.tmdbId &&
    d.mediaType === entry.mediaType &&
    String(d.season ?? "") === String(entry.season ?? "") &&
    String(d.episode ?? "") === String(entry.episode ?? "");
  downloads = downloads.filter((d) => !isSameMedia(d));

  const shouldQueue =
    deferResolve || getActiveDownloadCount() >= maxConcurrentDownloads;

  if (shouldQueue) {
    const waiting = downloads.filter((d) => d.status === "queued").length;
    entry.status = "queued";
    entry.lastMessage = deferResolve
      ? waiting > 0
        ? `Queued (${waiting + 1} in line) — link fetched at start`
        : "Queued — link fetched when download starts"
      : waiting > 0
        ? `Queued (${waiting + 1} in line)`
        : "Queued (waiting for a slot)";
    pendingSpawnJobs.set(id, {
      binaryPath,
      m3u8Url: deferResolve ? null : m3u8Url,
      name,
      downloadPath,
      resolveContext: deferResolve ? resolveContext : null,
      sourceId: resolvedSourceId,
      streamHeaders: normalizedStreamHeaders,
    });
    sendProgress({
      id,
      name,
      status: "queued",
      lastMessage: entry.lastMessage,
      posterPath: entry.posterPath,
      mediaType: entry.mediaType,
      season: entry.season,
      episode: entry.episode,
      tmdbId: entry.tmdbId,
    });
    drainDownloadQueue();
  } else {
    void spawnDownloadProcess(
      id,
      binaryPath,
      m3u8Url,
      name,
      downloadPath,
      resolvedSourceId,
      normalizedStreamHeaders,
    );
  }

  return { ok: true, id, queued: shouldQueue };
}

function cancelQueuedBySeriesBatch(batchId) {
  if (!batchId) return 0;
  let n = 0;
  for (const d of downloads) {
    if (
      (d.status !== "queued" && d.status !== "resolving") ||
      d.seriesBatchId !== batchId
    )
      continue;
    pendingSpawnJobs.delete(d.id);
    d.status = "error";
    d.lastMessage = "Series download cancelled";
    d.completedAt = Date.now();
    n++;
    sendProgress({
      id: d.id,
      status: "error",
      lastMessage: d.lastMessage,
    });
  }
  if (n) drainDownloadQueue();
  return n;
}

// ── IPC registration ──────────────────────────────────────────────────────────

function register(getMainWindow) {
  _getMainWindow = getMainWindow;

  // ── downloader binary detection ──────────────────────────────────────────
  ipcMain.handle("check-downloader", (_, folderPath) => {
    const result = validateDownloaderFolder(folderPath);
    if (!result.ok) {
      return { exists: false, reason: result.reason };
    }
    return { exists: true, token: result.token };
  });

  // ── start download ────────────────────────────────────────────────────────
  ipcMain.handle(
    "run-download",
    (
      _,
      {
        token,
        m3u8Url,
        name,
        downloadPath,
        mediaId,
        mediaType,
        season,
        episode,
        posterPath,
        tmdbId,
        subtitles,
        seriesBatchId,
        sourceId,
        resolveContext,
        streamHeaders,
      },
    ) => {
      try {
        return enqueueDownload({
          token,
          m3u8Url,
          name,
          downloadPath,
          mediaId,
          mediaType,
          season,
          episode,
          posterPath,
          tmdbId,
          subtitles,
          seriesBatchId,
          sourceId,
          resolveContext,
          streamHeaders,
        });
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  );

  ipcMain.handle("get-download-auth-prefs", () => {
    try {
      return { ok: true, ...downloadAuth.loadPrefs() };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("set-download-auth-prefs", (_, prefs = {}) => {
    try {
      const next = downloadAuth.savePrefs(prefs);
      return { ok: true, ...next };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("set-max-concurrent-downloads", (_, { max } = {}) => {
    const n = Math.max(1, Math.min(20, parseInt(max, 10) || 3));
    maxConcurrentDownloads = n;
    drainDownloadQueue();
    return { ok: true, max: maxConcurrentDownloads };
  });

  ipcMain.handle("get-max-concurrent-downloads", () => ({
    max: maxConcurrentDownloads,
  }));

  ipcMain.handle("get-downloads", () => downloads);

  ipcMain.handle(
    "retry-download",
    (_, { id, token, downloaderFolder } = {}) => {
      try {
        const idx = downloads.findIndex((d) => d.id === id);
        if (idx === -1) {
          return { ok: false, code: "NOT_FOUND", error: "Download not found" };
        }
        const old = downloads[idx];
        if (old.status !== "error") {
          return {
            ok: false,
            code: "NOT_ERROR",
            error: "Only failed downloads can be retried from here",
          };
        }

        let useToken = token;
        if (!useToken) {
          const dlCheck = validateDownloaderFolder(downloaderFolder);
          if (!dlCheck.ok) {
            return {
              ok: false,
              code: "NO_DOWNLOADER",
              error:
                "Downloader not configured. Set the downloader folder on a movie or TV page, or in Settings.",
            };
          }
          useToken = dlCheck.token;
        } else if (!trustedBinaryPaths.has(useToken)) {
          const dlCheck = validateDownloaderFolder(downloaderFolder);
          if (!dlCheck.ok) {
            return {
              ok: false,
              code: "NO_DOWNLOADER",
              error:
                "Downloader session expired. Open a movie or TV page to refresh the downloader, then try again.",
            };
          }
          useToken = dlCheck.token;
        }

        const m3u8Url =
          old.m3u8Url || extractM3u8FromLog(old.logPath);
        if (!m3u8Url) {
          return {
            ok: false,
            code: "NO_STREAM_URL",
            error:
              "No saved stream link for this download. Open the title, play the episode to capture a fresh link, then download again.",
          };
        }
        if (!old.downloadPath) {
          return {
            ok: false,
            code: "NO_PATH",
            error: "Download folder is missing for this entry.",
          };
        }

        purgeDownloadArtifacts(old);

        const snapshot = {
          name: old.name,
          downloadPath: old.downloadPath,
          mediaId: old.mediaId,
          mediaType: old.mediaType,
          season: old.season,
          episode: old.episode,
          posterPath: old.posterPath,
          tmdbId: old.tmdbId,
          subtitles: Array.isArray(old.subtitles) ? [...old.subtitles] : [],
          seriesBatchId: old.seriesBatchId || null,
        };

        downloads.splice(idx, 1);
        saveDownloads();

        const result = enqueueDownload({
          token: useToken,
          m3u8Url,
          ...snapshot,
          sourceId: old.sourceId || null,
          streamHeaders: old.streamHeaders || {},
        });
        if (!result.ok) {
          downloads.push({ ...old, ...snapshot, m3u8Url });
          saveDownloads();
          return result;
        }

        const entry = downloads.find((d) => d.id === result.id);
        return {
          ok: true,
          id: result.id,
          queued: !!result.queued,
          entry: entry ? { ...entry } : null,
          replacedId: id,
        };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  );

  ipcMain.handle("delete-download", (_, { id, filePath }) => {
    try {
      const dlEntry = downloads.find((d) => d.id === id);
      if (dlEntry?.status === "queued" || dlEntry?.status === "resolving") {
        pendingSpawnJobs.delete(id);
      }
      if (activeProcs.has(id)) {
        try {
          activeProcs.get(id).kill("SIGKILL");
        } catch {}
        activeProcs.delete(id);
      }
      if (filePath) {
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch {}
      }
      for (const sp of dlEntry?.subtitlePaths || []) {
        try {
          if (sp?.path && fs.existsSync(sp.path)) fs.unlinkSync(sp.path);
        } catch {}
      }
      const dlPath = dlEntry?.downloadPath;
      if (dlPath) cleanupTempFiles(dlPath, dlEntry?.name);
      downloads = downloads.filter((d) => d.id !== id);
      saveDownloads();
      drainDownloadQueue();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("delete-all-downloads", async () => {
    try {
      let deleted = 0,
        errors = 0;
      for (const dl of downloads) {
        if (dl.filePath) {
          try {
            if (fs.existsSync(dl.filePath)) {
              fs.unlinkSync(dl.filePath);
              deleted++;
            }
          } catch {
            errors++;
          }
        }
        for (const sp of dl.subtitlePaths || []) {
          try {
            if (sp?.path && fs.existsSync(sp.path)) fs.unlinkSync(sp.path);
          } catch {}
        }
      }
      downloads = [];
      saveDownloads();
      return { ok: true, deleted, errors };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("get-downloads-size", async () => {
    let bytes = 0;
    await Promise.all(
      downloads.map(async (dl) => {
        if (!dl.filePath) return;
        try {
          const stat = await fs.promises.stat(dl.filePath);
          if (stat.isFile()) bytes += stat.size;
        } catch {}
      }),
    );
    return { bytes };
  });

  ipcMain.handle("show-in-folder", (_, filePath) => {
    if (!filePath) return;
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        shell.openPath(filePath);
      } else if (fs.existsSync(filePath)) {
        shell.showItemInFolder(filePath);
      } else {
        shell.openPath(path.dirname(filePath));
      }
    } catch {
      shell.openPath(path.dirname(filePath));
    }
  });

  ipcMain.handle("file-exists", (_, filePath) => {
    try {
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  });

  ipcMain.handle("pick-folder", async () => {
    const mw = getMainWindow();
    if (!mw) return null;
    const result = await dialog.showOpenDialog(mw, {
      properties: ["openDirectory"],
      title: "Select Folder",
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("open-external", (_, url) => {
    shell.openExternal(url);
  });
  ipcMain.handle("open-path", (_, filePath) => {
    // If the path points to a file (e.g. an .asar archive or an executable),
    // open its containing folder instead so the OS file manager actually shows something
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        shell.openPath(filePath);
      } else {
        shell.showItemInFolder(filePath);
      }
    } catch {
      // Path doesn't exist or stat failed
      shell.openPath(filePath);
    }
  });
  ipcMain.handle("get-install-path", () => {
    if (process.env.APPIMAGE) {
      return path.dirname(process.env.APPIMAGE);
    }

    if (app.isPackaged) {
      return path.dirname(process.execPath);
    }

    return app.getAppPath();
  });

  ipcMain.handle("scan-directory", (_, folderPath) => {
    try {
      if (!folderPath || !fs.existsSync(folderPath)) return [];
      const VIDEO_EXTS = [
        ".mp4",
        ".mkv",
        ".webm",
        ".avi",
        ".mov",
        ".m4v",
        ".ts",
      ];
      const results = [];
      const scanDir = (dir, depth = 0) => {
        if (depth > 3) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath, depth + 1);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (VIDEO_EXTS.includes(ext)) {
              let size = "";
              try {
                const bytes = fs.statSync(fullPath).size;
                size =
                  bytes > 1e9
                    ? (bytes / 1e9).toFixed(2) + " GB"
                    : bytes > 1e6
                      ? (bytes / 1e6).toFixed(1) + " MB"
                      : bytes > 1e3
                        ? (bytes / 1e3).toFixed(1) + " KB"
                        : bytes + " B";
              } catch {}
              results.push({
                filePath: fullPath,
                name: path.basename(entry.name, ext),
                size,
                ext,
              });
            }
          }
        }
      };
      scanDir(folderPath);
      return results;
    } catch {
      return [];
    }
  });

  ipcMain.handle("clear-app-cache", async () => {
    try {
      const sessions = [
        session.defaultSession,
        session.fromPartition("persist:player"),
        session.fromPartition("persist:trailer"),
      ];
      await Promise.all(sessions.map((s) => s.clearCache()));
      await Promise.all(
        sessions.map((s) =>
          s.clearStorageData({
            storages: ["shadercache", "serviceworkers", "cachestorage"],
          }),
        ),
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("clear-watch-data", async () => {
    try {
      const vs = session.fromPartition("persist:player");
      await vs.clearStorageData();
      await vs.clearCache();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("get-cache-size", async () => {
    try {
      const sessions = [
        session.defaultSession,
        session.fromPartition("persist:player"),
        session.fromPartition("persist:trailer"),
      ];
      const sizes = await Promise.all(sessions.map((s) => s.getCacheSize()));
      return { bytes: sizes.reduce((a, b) => a + b, 0) };
    } catch {
      return { bytes: 0 };
    }
  });

  ipcMain.handle("reset-app", async () => {
    try {
      const sessions = [
        session.defaultSession,
        session.fromPartition("persist:player"),
        session.fromPartition("persist:trailer"),
      ];
      await Promise.all(sessions.map((s) => s.clearStorageData()));
      await Promise.all(sessions.map((s) => s.clearCache()));
      const dlFile = downloadsFile();
      if (fs.existsSync(dlFile)) fs.unlinkSync(dlFile);
      downloads = [];
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = {
  register,
  loadDownloads,
  saveDownloads,
  killAllDownloads,
  getDownloads: () => downloads,
  enqueueDownload,
  setResolveStreamForDownload,
  cancelQueuedBySeriesBatch,
};
