// ── Unified media tool paths (ffmpeg, ffprobe, yt-dlp, vid-dl) ───────────────
// Dev: resources/bin/<platform>-<arch>/   (populated by npm run setup-binaries)
// Packaged: <resources>/bin/              (electron-builder extraResources)

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

let _electronApp = null;

/** Call once from index.js after app is available. */
function bindElectronApp(app) {
  _electronApp = app;
}

function platformArchKey() {
  return `${process.platform}-${process.arch}`;
}

function projectRootFromModule() {
  return path.resolve(__dirname, "..", "..");
}

function exeName(tool) {
  const map = {
    ffmpeg: "ffmpeg",
    ffprobe: "ffprobe",
    "yt-dlp": "yt-dlp",
  };
  const base = map[tool] || tool;
  return process.platform === "win32" ? `${base}.exe` : base;
}

function candidateBundledBinDirs() {
  const key = platformArchKey();
  const dirs = [];

  if (process.env.STREAMSTEIN_BIN_DIR) {
    dirs.push(path.resolve(process.env.STREAMSTEIN_BIN_DIR));
  }

  if (_electronApp?.isPackaged && process.resourcesPath) {
    dirs.push(path.join(process.resourcesPath, "bin"));
  }

  const roots = new Set([
    projectRootFromModule(),
    process.cwd(),
    _electronApp?.getAppPath?.(),
    process.resourcesPath,
    path.dirname(process.execPath || ""),
  ].filter(Boolean).map((p) => path.resolve(p)));

  for (const root of roots) {
    dirs.push(path.join(root, "resources", "bin", key));
    dirs.push(path.join(root, "resources", "bin"));
    dirs.push(path.join(root, "bin"));
  }

  return [...new Set(dirs.map((d) => path.resolve(d)))];
}

function getBundledBinDir() {
  for (const dir of candidateBundledBinDirs()) {
    try {
      if (!fs.existsSync(dir)) continue;
      const probe = path.join(dir, exeName("ffmpeg"));
      if (fs.existsSync(probe)) return dir;
      const ytdlp = path.join(dir, exeName("yt-dlp"));
      if (fs.existsSync(ytdlp)) return dir;
    } catch {
      // try next
    }
  }
  return null;
}

function getManagedYtDlpPath() {
  if (!_electronApp) return null;
  return path.join(
    _electronApp.getPath("userData"),
    "tools",
    platformArchKey(),
    exeName("yt-dlp"),
  );
}

function pathExistsOnPath(command) {
  try {
    const r = spawnSync(
      process.platform === "win32" ? "where" : "which",
      [command],
      { encoding: "utf8", timeout: 5000, windowsHide: true },
    );
    if (r.status !== 0 || !r.stdout?.trim()) return null;
    return r.stdout.trim().split(/\r?\n/)[0].trim();
  } catch {
    return null;
  }
}

const SYSTEM_FALLBACKS = {
  ffmpeg:
    process.platform === "win32"
      ? ["ffmpeg", "C:\\ffmpeg\\bin\\ffmpeg.exe", path.join(require("os").homedir(), "Downloads", "ffmpeg.exe")]
      : process.platform === "darwin"
        ? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"]
        : ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"],
  ffprobe:
    process.platform === "win32"
      ? ["ffprobe", "C:\\ffmpeg\\bin\\ffprobe.exe", path.join(require("os").homedir(), "Downloads", "ffprobe.exe")]
      : process.platform === "darwin"
        ? ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "ffprobe"]
        : ["/usr/bin/ffprobe", "/usr/local/bin/ffprobe", "ffprobe"],
  "yt-dlp":
    process.platform === "win32"
      ? ["yt-dlp", path.join(require("os").homedir(), "Downloads", "yt-dlp.exe"), "C:\\ffmpeg\\bin\\yt-dlp.exe"]
      : ["yt-dlp", "/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp"],
};

/**
 * Resolve a media tool binary. Bundled copy wins, then PATH / common install paths.
 * @param {"ffmpeg"|"ffprobe"|"yt-dlp"} tool
 * @returns {string|null} absolute path or bare command name for PATH
 */
function resolveTool(tool) {
  if (tool === "yt-dlp") {
    const managed = getManagedYtDlpPath();
    if (managed && fs.existsSync(managed)) return managed;
  }

  const bundledDir = getBundledBinDir();
  if (bundledDir) {
    const bundled = path.join(bundledDir, exeName(tool));
    if (fs.existsSync(bundled)) return bundled;
  }

  for (const candidate of SYSTEM_FALLBACKS[tool] || []) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
    const onPath = pathExistsOnPath(candidate);
    if (onPath) return onPath;
  }

  return null;
}

function resolveExtensionRoot() {
  const candidates = [];
  if (process.env.STREAMSTEIN_EXTENSION_ROOT) {
    candidates.push(path.resolve(process.env.STREAMSTEIN_EXTENSION_ROOT));
  }
  if (_electronApp?.isPackaged && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "YoutubeDownloaderExtension"));
  }
  candidates.push(path.join(projectRootFromModule(), "YoutubeDownloaderExtension"));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "manifest.json"))) return dir;
  }
  return candidates[candidates.length - 1];
}

function resolveBridgeRoot() {
  const ext = resolveExtensionRoot();
  const bridge = path.join(ext, "yt-saver-bridge");
  if (fs.existsSync(path.join(bridge, "server.js"))) return bridge;
  if (process.env.STREAMSTEIN_BRIDGE_ROOT && fs.existsSync(process.env.STREAMSTEIN_BRIDGE_ROOT)) {
    return path.resolve(process.env.STREAMSTEIN_BRIDGE_ROOT);
  }
  return bridge;
}

function resolveVidDlDir() {
  const bundledDir = getBundledBinDir();
  if (bundledDir) {
    const nested = path.join(bundledDir, "vid-dl");
    if (fs.existsSync(path.join(nested, "_internal"))) return nested;
  }

  const roots = candidateBundledBinDirs();
  for (const root of roots) {
    const nested = path.join(root, "vid-dl");
    if (fs.existsSync(path.join(nested, "_internal"))) return nested;
  }

  const devBuild = path.join(projectRootFromModule(), "vid-dl-cli-only-v.2.3.2", "dist", "vid-dl");
  if (fs.existsSync(path.join(devBuild, "_internal"))) return devBuild;

  return null;
}

function getToolsStatus() {
  const bundledBinDir = getBundledBinDir();
  const ffmpeg = resolveTool("ffmpeg");
  const ffprobe = resolveTool("ffprobe");
  const ytDlp = resolveTool("yt-dlp");
  const vidDlDir = resolveVidDlDir();
  const extensionRoot = resolveExtensionRoot();
  const bridgeRoot = resolveBridgeRoot();

  return {
    platformArch: platformArchKey(),
    packaged: _electronApp?.isPackaged === true,
    bundledBinDir,
    ffmpeg,
    ffprobe,
    ytDlp,
    vidDlDir,
    extensionRoot,
    bridgeRoot,
    extensionPresent: fs.existsSync(path.join(extensionRoot, "manifest.json")),
    bridgePresent: fs.existsSync(path.join(bridgeRoot, "server.js")),
    bridgeDepsPresent: fs.existsSync(path.join(bridgeRoot, "node_modules")),
  };
}

/** Expose bundled paths to child processes (yt-saver-bridge, scripts). */
function publishBundledEnv() {
  const bundledBinDir = getBundledBinDir();
  if (bundledBinDir) {
    process.env.STREAMSTEIN_BIN_DIR = bundledBinDir;
  }
  process.env.STREAMSTEIN_EXTENSION_ROOT = resolveExtensionRoot();
  process.env.STREAMSTEIN_BRIDGE_ROOT = resolveBridgeRoot();
  process.env.STREAMSTEIN_PROJECT_ROOT = projectRootFromModule();
  return getToolsStatus();
}

function register(ipcMain) {
  ipcMain.handle("get-bundled-tools", () => {
    try {
      return { ok: true, ...getToolsStatus() };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("get-default-downloader-folder", () => {
    try {
      const vidDlDir = resolveVidDlDir();
      return { ok: true, folder: vidDlDir || null };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

module.exports = {
  bindElectronApp,
  platformArchKey,
  getBundledBinDir,
  getManagedYtDlpPath,
  resolveTool,
  resolveExtensionRoot,
  resolveBridgeRoot,
  resolveVidDlDir,
  getToolsStatus,
  publishBundledEnv,
  register,
};
