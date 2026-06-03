// YouTube Downloader bridge sidecar — started/stopped with Streamstein.
// Uses Electron's embedded Node (ELECTRON_RUN_AS_NODE) so end users need no separate Node install.

const fs = require("fs");
const http = require("http");
const path = require("path");
const { app } = require("electron");
const { spawn, spawnSync } = require("child_process");
const toolPaths = require("./toolPaths");
const { getResolvedLibraryPaths } = require("./libraryPathsMain");

const BRIDGE_PORT = Number(process.env.STREAMSTEIN_BRIDGE_PORT || 8789);
const YOUTUBE_CATALOG_UPDATED_PREFIX = "__STREAMSTEIN_YOUTUBE_CATALOG_UPDATED__";

function bridgeSettingsFile() {
  return path.join(app.getPath("userData"), "yt-bridge-settings.json");
}

function loadBridgeSettings() {
  try {
    const raw = fs.readFileSync(bridgeSettingsFile(), "utf8");
    const parsed = JSON.parse(raw);
    return { startOnLaunch: parsed.startOnLaunch !== false };
  } catch {
    return { startOnLaunch: true };
  }
}

function saveBridgeSettings(settings) {
  fs.writeFileSync(
    bridgeSettingsFile(),
    JSON.stringify(settings, null, 2),
    "utf8",
  );
}

function shouldStartOnLaunch() {
  return loadBridgeSettings().startOnLaunch;
}

async function setStartupPreference(enabled) {
  saveBridgeSettings({ startOnLaunch: !!enabled });
  if (enabled) {
    return start();
  }
  stop();
  return getStatus();
}

function parseCatalogUpdatedLine(line) {
  if (!line?.startsWith(YOUTUBE_CATALOG_UPDATED_PREFIX)) return null;
  try {
    return JSON.parse(line.slice(YOUTUBE_CATALOG_UPDATED_PREFIX.length));
  } catch {
    return null;
  }
}

function broadcastYoutubeCatalogUpdated(detail) {
  const { BrowserWindow } = require("electron");
  for (const win of BrowserWindow.getAllWindows()) {
    if (win && !win.isDestroyed()) {
      win.webContents.send("youtube-catalog-updated", detail || {});
    }
  }
}

function handleBridgeStdoutLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return;
  const detail = parseCatalogUpdatedLine(trimmed);
  if (detail) {
    broadcastYoutubeCatalogUpdated(detail);
  }
}

let _child = null;
let _startedByUs = false;
let _status = {
  running: false,
  managed: false,
  port: BRIDGE_PORT,
  pid: null,
  url: `http://127.0.0.1:${BRIDGE_PORT}`,
  error: null,
};

function getStatus() {
  return { ..._status };
}

function pingBridge(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${BRIDGE_PORT}/api/ping`,
      { timeout: timeoutMs },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            resolve(res.statusCode === 200 && parsed?.ok === true);
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function ensureBridgeDeps(bridgeRoot) {
  const marker = path.join(bridgeRoot, "node_modules", "fastify");
  if (fs.existsSync(marker)) return true;

  console.log("[yt-bridge] Installing bridge dependencies (first run)…");
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npmCmd, ["install", "--omit=dev"], {
    cwd: bridgeRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  return r.status === 0;
}

function buildBridgeEnv() {
  const tools = toolPaths.publishBundledEnv();
  const binDir = tools.bundledBinDir || process.env.STREAMSTEIN_BIN_DIR || "";
  const libraryPaths = getResolvedLibraryPaths();
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  let envPath = process.env[pathKey] || process.env.PATH || "";
  if (binDir) {
    const prefix = path.resolve(binDir);
    if (!envPath.toLowerCase().includes(prefix.toLowerCase())) {
      envPath = `${prefix}${path.delimiter}${envPath}`;
    }
  }
  return {
    ...process.env,
    [pathKey]: envPath,
    ELECTRON_RUN_AS_NODE: "1",
    STREAMSTEIN_NODE: process.execPath,
    PORT: String(BRIDGE_PORT),
    STREAMSTEIN_BIN_DIR: binDir,
    STREAMSTEIN_EXTENSION_ROOT: process.env.STREAMSTEIN_EXTENSION_ROOT || "",
    STREAMSTEIN_BRIDGE_ROOT: process.env.STREAMSTEIN_BRIDGE_ROOT || "",
    STREAMSTEIN_PROJECT_ROOT: process.env.STREAMSTEIN_PROJECT_ROOT || "",
    STREAMSTEIN_YOUTUBE_LIBRARY: libraryPaths.youtube || "",
    STREAMSTEIN_MOVIES_LIBRARY: libraryPaths.movies || "",
  };
}

function postBridgeConfig(body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: BRIDGE_PORT,
        path: "/api/config",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: 5000,
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          resolve(res.statusCode === 200);
        });
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.write(data);
    req.end();
  });
}

async function syncBridgeToolPaths() {
  const tools = toolPaths.getToolsStatus();
  const body = {};
  if (tools.ytDlp) body.ytDlpCommand = tools.ytDlp;
  if (tools.ffmpeg) body.ffmpegPath = tools.ffmpeg;
  if (!Object.keys(body).length) return false;
  const ok = await postBridgeConfig(body);
  if (ok) {
    console.log("[yt-bridge] Synced bundled yt-dlp/ffmpeg paths to bridge config");
  }
  return ok;
}

async function syncBridgeLibraryPaths(paths) {
  const resolved = paths || getResolvedLibraryPaths();
  const body = {};
  if (resolved.youtube) body.youtubeLibraryFolder = resolved.youtube;
  if (resolved.movies) body.moviesLibraryFolder = resolved.movies;
  if (!Object.keys(body).length) return false;
  const ok = await postBridgeConfig(body);
  if (ok) {
    console.log(
      `[yt-bridge] Synced library folders (YouTube: ${resolved.youtube || "default"})`,
    );
  }
  return ok;
}

async function syncBridgeYoutubeCookies() {
  const ext =
    typeof process.env.STREAMSTEIN_EXTENSION_ROOT === "string"
      ? process.env.STREAMSTEIN_EXTENSION_ROOT.trim()
      : "";
  if (!ext) return false;
  const cookieFile = path.join(path.resolve(ext), "youtube-cookies.txt");
  if (!fs.existsSync(cookieFile)) return false;
  const ok = await postBridgeConfig({
    ytDlpCookiesFile: cookieFile,
    ytDlpCookiesFromBrowser: "",
  });
  if (ok) {
    console.log(`[yt-bridge] Using YouTube cookies file: ${cookieFile}`);
  }
  return ok;
}

function waitForReady(maxMs = 30000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      if (await pingBridge(1500)) {
        resolve(true);
        return;
      }
      if (Date.now() - started >= maxMs) {
        resolve(false);
        return;
      }
      setTimeout(tick, 400);
    };
    tick();
  });
}

async function start() {
  if (_child && !_child.killed) {
    _status.running = true;
    _status.managed = _startedByUs;
    return getStatus();
  }

  const tools = toolPaths.getToolsStatus();
  const bridgeRoot = tools.bridgeRoot;
  const serverJs = path.join(bridgeRoot, "server.js");

  if (!fs.existsSync(serverJs)) {
    _status.error = `Bridge not found: ${serverJs}`;
    console.warn(`[yt-bridge] ${_status.error}`);
    return getStatus();
  }

  if (await pingBridge()) {
    _status.running = true;
    _status.managed = false;
    _status.error = null;
    console.log(`[yt-bridge] Already running on port ${BRIDGE_PORT} (external)`);
    await syncBridgeToolPaths();
    await syncBridgeLibraryPaths();
    await syncBridgeYoutubeCookies();
    return getStatus();
  }

  if (!tools.bridgeDepsPresent && !ensureBridgeDeps(bridgeRoot)) {
    _status.error = "Bridge dependencies missing. Run npm run setup-bridge or prepare-release.";
    console.warn(`[yt-bridge] ${_status.error}`);
    return getStatus();
  }

  const env = buildBridgeEnv();
  _child = spawn(process.execPath, ["server.js"], {
    cwd: bridgeRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  _startedByUs = true;
  _status.pid = _child.pid;
  _status.managed = true;
  _status.error = null;

  _child.stdout?.on("data", (chunk) => {
    const text = String(chunk);
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      handleBridgeStdoutLine(trimmed);
      console.log(`[yt-bridge] ${trimmed}`);
    }
  });
  _child.stderr?.on("data", (chunk) => {
    const line = String(chunk).trim();
    if (line) console.warn(`[yt-bridge] ${line}`);
  });

  _child.on("exit", (code, signal) => {
    if (_startedByUs) {
      console.log(`[yt-bridge] exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    }
    _child = null;
    _startedByUs = false;
    _status.running = false;
    _status.managed = false;
    _status.pid = null;
  });

  const ready = await waitForReady();
  _status.running = ready;
  if (!ready) {
    _status.error = `Bridge did not respond on port ${BRIDGE_PORT} within 30s`;
    console.warn(`[yt-bridge] ${_status.error}`);
  } else {
    await syncBridgeToolPaths();
    await syncBridgeLibraryPaths();
    await syncBridgeYoutubeCookies();
    console.log(`[yt-bridge] Ready at http://127.0.0.1:${BRIDGE_PORT}`);
  }

  return getStatus();
}

function stop() {
  if (!_child || !_startedByUs) return;

  const pid = _child.pid;
  try {
    if (process.platform === "win32" && pid) {
      spawnSync("taskkill", ["/pid", String(pid), "/f", "/t"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else if (_child) {
      _child.kill("SIGTERM");
    }
  } catch (e) {
    console.warn(`[yt-bridge] stop failed: ${e?.message || e}`);
  }

  _child = null;
  _startedByUs = false;
  _status.running = false;
  _status.managed = false;
  _status.pid = null;
}

function register(ipcMain) {
  ipcMain.handle("get-yt-bridge-status", async () => {
    try {
      const alive = await pingBridge();
      if (alive) _status.running = true;
      else if (_startedByUs && _child) _status.running = false;
      else if (!_startedByUs) _status.running = false;
      return { ok: true, ...getStatus() };
    } catch (e) {
      return { ok: false, error: e.message || String(e), ...getStatus() };
    }
  });

  ipcMain.handle("restart-yt-bridge", async () => {
    try {
      stop();
      await new Promise((r) => setTimeout(r, 500));
      const status = await start();
      return { ok: true, ...status };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("get-yt-bridge-startup", () => {
    try {
      return { ok: true, startOnLaunch: shouldStartOnLaunch() };
    } catch (e) {
      return { ok: false, error: e.message || String(e), startOnLaunch: true };
    }
  });

  ipcMain.handle("set-yt-bridge-startup", async (_, enabled) => {
    try {
      const status = await setStartupPreference(!!enabled);
      return { ok: true, startOnLaunch: !!enabled, ...status };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

module.exports = {
  start,
  stop,
  getStatus,
  pingBridge,
  shouldStartOnLaunch,
  setStartupPreference,
  syncBridgeLibraryPaths,
  register,
};
