const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { app, ipcMain } = require("electron");
const toolPaths = require("./toolPaths");

const API = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const TIMEOUT = 15000;
const MAX_SIZE = 100 * 1024 * 1024;

let activeCheck = null;
let state = { checking: false, error: null };

function settingsPath() {
  return path.join(app.getPath("userData"), "yt-dlp-updater.json");
}

function defaults() {
  return {
    autoUpdate: true,
    lastCheckedAt: null,
    lastUpdatedAt: null,
    latestVersion: null,
    etag: null,
  };
}

function readSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    return {
      autoUpdate: data.autoUpdate !== false,
      lastCheckedAt: data.lastCheckedAt || null,
      lastUpdatedAt: data.lastUpdatedAt || null,
      latestVersion: data.latestVersion || null,
      etag: data.etag || null,
    };
  } catch {
    return defaults();
  }
}

function writeSettings(patch) {
  const data = { ...readSettings(), ...patch };
  const target = settingsPath();
  const temp = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
  fs.rmSync(target, { force: true });
  fs.renameSync(temp, target);
  return data;
}

function getAutoUpdate() {
  return readSettings().autoUpdate;
}

function setAutoUpdate(enabled) {
  return writeSettings({ autoUpdate: Boolean(enabled) });
}

function assetName() {
  if (process.platform === "win32") {
    if (process.arch === "arm64") return "yt-dlp_arm64.exe";
    if (process.arch === "ia32") return "yt-dlp_x86.exe";
    return "yt-dlp.exe";
  }
  if (process.platform === "darwin") return "yt-dlp_macos";
  if (process.platform === "linux" && process.arch === "x64") {
    return "yt-dlp_linux";
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return "yt-dlp_linux_aarch64";
  }
  throw new Error(`Unsupported platform: ${process.platform}-${process.arch}`);
}

function version(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

function isNewer(candidate, current) {
  if (!candidate || !current) return Boolean(candidate);
  const left = version(candidate).split(/\D+/).filter(Boolean).map(Number);
  const right = version(current).split(/\D+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const a = left[i] || 0;
    const b = right[i] || 0;
    if (a !== b) return a > b;
  }
  return false;
}

function binaryVersion(binary) {
  if (!binary) return null;
  try {
    const result = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: TIMEOUT,
      windowsHide: true,
      env: process.env,
    });
    return result.status === 0 ? version(result.stdout) : null;
  } catch {
    return null;
  }
}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  if (typeof timer.unref === "function") timer.unref();
  try {
    return await fetch(url, {
      redirect: "follow",
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Streamstein-yt-dlp-updater",
        Accept: "application/vnd.github+json",
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

async function latestRelease(settings, force) {
  const headers = {};
  if (!force && settings.etag) headers["If-None-Match"] = settings.etag;
  const response = await request(API, { headers });
  if (response.status === 304) {
    return { version: settings.latestVersion };
  }
  if (!response.ok) {
    throw new Error(`GitHub release check failed (HTTP ${response.status})`);
  }
  const release = await response.json();
  return {
    release,
    version: version(release.tag_name),
    etag: response.headers.get("etag") || null,
  };
}

async function checksum(release, asset) {
  const digestMatch = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || "");
  if (digestMatch) return digestMatch[1].toLowerCase();
  const sumsAsset = release.assets?.find((item) => item.name === "SHA2-256SUMS");
  if (!sumsAsset?.browser_download_url) {
    throw new Error("Release checksum file is missing");
  }
  const response = await request(sumsAsset.browser_download_url, {
    headers: { Accept: "application/octet-stream" },
  });
  if (!response.ok) {
    throw new Error(`Checksum download failed (HTTP ${response.status})`);
  }
  const text = await response.text();
  const escaped = asset.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `^([a-f0-9]{64})\\s+[* ]?${escaped}\\s*$`,
    "im",
  ).exec(text);
  if (!match) throw new Error(`Checksum not found for ${asset.name}`);
  return match[1].toLowerCase();
}

async function install(release, latestVersion) {
  const name = assetName();
  const asset = release.assets?.find((item) => item.name === name);
  if (!asset?.browser_download_url) {
    throw new Error(`yt-dlp ${latestVersion} has no ${name} asset`);
  }
  if (Number(asset.size) > MAX_SIZE) {
    throw new Error(`Refusing unexpectedly large ${name} asset`);
  }
  const [response, expectedHash] = await Promise.all([
    request(asset.browser_download_url, {
      headers: { Accept: "application/octet-stream" },
    }),
    checksum(release, asset),
  ]);
  if (!response.ok) {
    throw new Error(`Binary download failed (HTTP ${response.status})`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (
    data.length > MAX_SIZE ||
    (Number(asset.size) > 0 && data.length !== Number(asset.size))
  ) {
    throw new Error("Downloaded yt-dlp has an unexpected size");
  }
  const actualHash = crypto.createHash("sha256").update(data).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error("Downloaded yt-dlp failed SHA-256 verification");
  }

  const target = toolPaths.getManagedYtDlpPath();
  const temp = `${target}.download-${process.pid}`;
  const backup = `${target}.previous`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temp, data);
  if (process.platform !== "win32") fs.chmodSync(temp, 0o755);
  const downloadedVersion = binaryVersion(temp);
  if (downloadedVersion !== latestVersion) {
    fs.rmSync(temp, { force: true });
    throw new Error(
      `Downloaded yt-dlp reported ${downloadedVersion || "no version"}`,
    );
  }
  try {
    fs.rmSync(backup, { force: true });
    if (fs.existsSync(target)) fs.renameSync(target, backup);
    fs.renameSync(temp, target);
    fs.rmSync(backup, { force: true });
  } catch (error) {
    fs.rmSync(temp, { force: true });
    if (!fs.existsSync(target) && fs.existsSync(backup)) {
      fs.renameSync(backup, target);
    }
    throw error;
  }
}

async function getStatus() {
  const settings = readSettings();
  const binaryPath = toolPaths.resolveTool("yt-dlp");
  const currentVersion = binaryVersion(binaryPath);
  return {
    ok: Boolean(currentVersion),
    autoUpdate: settings.autoUpdate,
    checking: state.checking,
    currentVersion,
    latestVersion: settings.latestVersion,
    updateAvailable:
      Boolean(currentVersion && settings.latestVersion) &&
      isNewer(settings.latestVersion, currentVersion),
    lastCheckedAt: settings.lastCheckedAt,
    lastUpdatedAt: settings.lastUpdatedAt,
    binaryPath,
    managed: binaryPath === toolPaths.getManagedYtDlpPath(),
    error: state.error,
  };
}

async function checkForUpdates({ force = false, installUpdate = true } = {}) {
  if (activeCheck) return activeCheck;
  activeCheck = (async () => {
    state = { checking: true, error: null };
    try {
      let settings = readSettings();
      let currentVersion = binaryVersion(toolPaths.resolveTool("yt-dlp"));
      const checkedAt = new Date(settings.lastCheckedAt || 0).getTime();
      const recentlyChecked =
        !force &&
        Number.isFinite(checkedAt) &&
        Date.now() - checkedAt < CHECK_INTERVAL;
      let releaseInfo = { version: settings.latestVersion };
      if (!recentlyChecked || !settings.latestVersion) {
        releaseInfo = await latestRelease(settings, force);
        settings = writeSettings({
          lastCheckedAt: new Date().toISOString(),
          latestVersion: releaseInfo.version || settings.latestVersion,
          etag: releaseInfo.etag || settings.etag,
        });
      }
      const latestVersion = releaseInfo.version || settings.latestVersion;
      let updated = false;
      if (installUpdate && isNewer(latestVersion, currentVersion)) {
        let release = releaseInfo.release;
        if (!release) {
          release = (
            await latestRelease({ ...settings, etag: null }, true)
          ).release;
        }
        await install(release, latestVersion);
        currentVersion = latestVersion;
        updated = true;
        settings = writeSettings({ lastUpdatedAt: new Date().toISOString() });
      }
      state = { checking: false, error: null };
      return {
        ...(await getStatus()),
        ok: true,
        updated,
        currentVersion,
        latestVersion,
        lastUpdatedAt: settings.lastUpdatedAt,
      };
    } catch (error) {
      state = { checking: false, error: error?.message || String(error) };
      return { ...(await getStatus()), ok: false, error: state.error };
    } finally {
      activeCheck = null;
    }
  })();
  return activeCheck;
}

async function runStartupUpdate() {
  if (!getAutoUpdate()) return getStatus();
  return checkForUpdates({ force: false, installUpdate: true });
}

function register({ onUpdated } = {}) {
  ipcMain.handle("get-ytdlp-update-status", () => getStatus());
  ipcMain.handle("set-ytdlp-auto-update", (_, enabled) => {
    setAutoUpdate(enabled);
    return getStatus();
  });
  ipcMain.handle("check-ytdlp-update", async () => {
    const result = await checkForUpdates({
      force: true,
      installUpdate: true,
    });
    if (result.updated && typeof onUpdated === "function") {
      await onUpdated(result);
    }
    return result;
  });
}

module.exports = {
  checkForUpdates,
  getAutoUpdate,
  getStatus,
  register,
  runStartupUpdate,
  setAutoUpdate,
};
