// popup.js

import {
  initChatModelPicker,
  CHAT_MODEL_BY_ID,
  DEFAULT_CHAT_MODEL_ID
} from "./chat-models.js";

// =====================
// Theme handling
// =====================

const root = document.documentElement;
const themeToggleBtn = document.getElementById("theme-toggle");
const themeIconSpan = document.getElementById("theme-icon");

const THEME_STORAGE_KEY = "ytSaverTheme";
const DEFAULT_THEME = "dark";

function normalizeTheme(theme) {
  return theme === "light" ? "light" : DEFAULT_THEME;
}

function persistTheme(theme) {
  const resolved = normalizeTheme(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, resolved);
  } catch {
    // private mode / blocked storage
  }
  chrome.storage?.sync?.set?.({ [THEME_STORAGE_KEY]: resolved });
}

function applyTheme(theme) {
  const resolved = normalizeTheme(theme);
  root.setAttribute("data-theme", resolved);
  if (themeIconSpan) {
    themeIconSpan.textContent = resolved === "dark" ? "🌙" : "☀️";
  }
}

function loadTheme() {
  const applySaved = (saved) => {
    if (saved === "light" || saved === "dark") {
      applyTheme(saved);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, saved);
      } catch {
        // ignore
      }
      return;
    }
    applyTheme(DEFAULT_THEME);
    persistTheme(DEFAULT_THEME);
  };

  if (chrome.storage?.sync) {
    chrome.storage.sync.get(THEME_STORAGE_KEY, (data) => {
      applySaved(data?.[THEME_STORAGE_KEY]);
    });
    return;
  }

  try {
    applySaved(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    applyTheme(DEFAULT_THEME);
  }
}

function toggleTheme() {
  const current = root.getAttribute("data-theme") || DEFAULT_THEME;
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  persistTheme(next);
}

themeToggleBtn?.addEventListener("click", toggleTheme);
loadTheme();

// =====================
// Tab switching
// =====================

const tabButtons = Array.from(document.querySelectorAll(".tab"));
const tabPanels = Array.from(document.querySelectorAll(".tab-panel"));

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab;
    tabButtons.forEach((b) => b.classList.toggle("active", b === btn));
    tabPanels.forEach((panel) =>
      panel.classList.toggle("active", panel.id === `tab-${target}`)
    );
    onTabActivated(target);
  });
});

// =====================
// Helpers
// =====================

function getStatusIcon(type) {
  switch (type) {
    case "success":
      return "✅";
    case "error":
      return "❌";
    case "warning":
      return "⚠️";
    default:
      return "ℹ️";
  }
}

function renderStatus(message, type = "info") {
  if (!message) return "";
  const icon = getStatusIcon(type);
  return `<div class="status-line"><span class="status-icon ${type}">${icon}</span><span>${message}</span></div>`;
}

function setStatusSingleMessages(lines) {
  const box = document.getElementById("single-status");
  if (!box) return;
  const parts = (Array.isArray(lines) ? lines : [])
    .filter((line) => line && line.message)
    .map((line) => renderStatus(line.message, line.type || "info"));
  box.innerHTML = parts.join("") || "";
}

function setStatusSingle(message, type = "info") {
  setStatusSingleMessages([{ message, type }]);
}

const channelStatusState = {
  summary: null,
  log: "",
  showLog: false
};

let channelBatchFinalizeTimer = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderChannelStatusBox() {
  const box = document.getElementById("channel-status");
  if (!box) return;
  const parts = [];
  if (channelStatusState.summary?.message) {
    parts.push(
      renderStatus(
        channelStatusState.summary.message,
        channelStatusState.summary.type || "info"
      )
    );
  }
  if (channelStatusState.showLog && channelStatusState.log) {
    parts.push(
      `<div class="channel-status-log" role="log" aria-live="polite">${escapeHtml(channelStatusState.log)}</div>`
    );
  }
  box.innerHTML = parts.join("");
  box.classList.toggle("channel-status-panel", Boolean(channelStatusState.showLog));
  const logEl = box.querySelector(".channel-status-log");
  if (logEl) {
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function setStatusChannel(message, type = "info") {
  channelStatusState.summary = message ? { message, type } : null;
  channelStatusState.log = "";
  channelStatusState.showLog = false;
  renderChannelStatusBox();
}

function setChannelStatusWithLog(summaryMessage, summaryType, logText) {
  channelStatusState.summary = { message: summaryMessage, type: summaryType };
  channelStatusState.log = logText || "";
  channelStatusState.showLog = Boolean(channelStatusState.log);
  renderChannelStatusBox();
}

function appendChannelLog(line) {
  if (!line) return;
  channelStatusState.showLog = true;
  channelStatusState.log = channelStatusState.log
    ? `${channelStatusState.log}\n${line}`
    : line;
  renderChannelStatusBox();
}

async function finalizeChannelBatchUI() {
  channelBatchActive = false;
  hideProgressBar();
  try {
    await refreshGlobalLibrarySummary({ forceRescan: false });
    if (cachedChannelVideos.length) {
      await fetchChannelLibraryMatches(cachedChannelVideos);
    }
  } catch (err) {
    console.warn("[YouTube Downloader] Post-batch library refresh failed", err);
  }
  setChannelStatusWithLog(
    "Channel batch complete.\n<strong>All queued downloads finished.</strong>\nYour StreamStein YouTube library updates automatically.",
    "success",
    channelStatusState.log
  );
}

function scheduleChannelBatchFinalize() {
  if (channelBatchFinalizeTimer) {
    clearTimeout(channelBatchFinalizeTimer);
  }
  channelBatchFinalizeTimer = setTimeout(() => {
    channelBatchFinalizeTimer = null;
    finalizeChannelBatchUI();
  }, 1200);
}

function setStatusSettings(message, type = "info") {
  const box = document.getElementById("settings-status");
  if (!box) return;
  box.innerHTML = renderStatus(message, type);
}

function isYouTubeWatchUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("youtube.com") && u.hostname !== "youtu.be") {
      return false;
    }
    if (u.hostname === "youtu.be") return u.pathname.slice(1).length > 0;
    const isWatch = u.pathname.startsWith("/watch") && !!u.searchParams.get("v");
    const isShort = u.pathname.split("/").includes("shorts");
    return isWatch || isShort;
  } catch {
    return false;
  }
}

function isYouTubeChannelCandidateUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("youtube.com")) return false;
    const path = u.pathname;
    if (path.includes("/watch") || path.includes("/shorts/")) return false;
    const looksChannel =
      path.includes("/@") ||
      path.startsWith("/channel/") ||
      path.startsWith("/c/") ||
      path.startsWith("/user/");
    return looksChannel;
  } catch {
    return false;
  }
}

function isYouTubeChannelVideosUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("youtube.com")) return false;
    return u.pathname.endsWith("/videos");
  } catch {
    return false;
  }
}

function setButtonLoading(btn, isLoading, loadingText) {
  if (!btn) return;
  if (isLoading) {
    if (!btn.dataset.originalText) {
      btn.dataset.originalText = btn.textContent || "";
    }
    btn.textContent = loadingText || btn.dataset.originalText || "Working…";
    btn.disabled = true;
  } else {
    btn.disabled = false;
    if (btn.dataset.originalText != null) {
      btn.textContent = btn.dataset.originalText;
      delete btn.dataset.originalText;
    }
  }
}

// =====================
// Settings (storage + helpers)
// =====================

const DEFAULT_SETTINGS = {
  saveMode: "default", // 'default' | 'subfolder' | 'ask'
  subfolder: "YouTube",
  delaySeconds: 15,
  ffmpegPath: "",
  maxQuality: "1080", // 'best' | '2160' | '1440' | '1080' | '720' | '480' | '360'
  downloadTranscripts: true,
  ytDlpCookiesFromBrowser: "",
  ytDlpCookiesFile: "",
  ytDlpWarmupEnabled: false,
  ytDlpWarmupDelayMs: 2500,
  ytDlpWarmupCooldownMs: 15000,
  ytDlpWarmupCloseTab: true,
  ytDlpWarmupBrowserCommand: "",
  whisperCommand: ""
};

let appSettings = { ...DEFAULT_SETTINGS };

function loadSettings(callback) {
  chrome.storage?.sync?.get("ytSaverSettings", (data) => {
    const stored = data?.ytSaverSettings;
    if (stored && typeof stored === "object") {
      appSettings = {
        ...DEFAULT_SETTINGS,
        ...stored,
        delaySeconds: clampNumber(stored.delaySeconds, 0, 600, DEFAULT_SETTINGS.delaySeconds),
        ytDlpWarmupEnabled: Boolean(stored.ytDlpWarmupEnabled),
        ytDlpWarmupDelayMs: clampNumber(stored.ytDlpWarmupDelayMs, 0, 15000, DEFAULT_SETTINGS.ytDlpWarmupDelayMs),
        ytDlpWarmupCooldownMs: clampNumber(
          stored.ytDlpWarmupCooldownMs,
          0,
          600000,
          DEFAULT_SETTINGS.ytDlpWarmupCooldownMs
        ),
        ytDlpWarmupCloseTab: stored.ytDlpWarmupCloseTab !== false,
        ytDlpWarmupBrowserCommand:
          typeof stored.ytDlpWarmupBrowserCommand === "string" ? stored.ytDlpWarmupBrowserCommand : ""
      };
    } else {
      appSettings = { ...DEFAULT_SETTINGS };
    }
    callback?.(appSettings);
  });
}

function saveSettings(newSettings, callback) {
  const safe = {
    saveMode: ["default", "subfolder", "ask"].includes(newSettings.saveMode)
      ? newSettings.saveMode
      : DEFAULT_SETTINGS.saveMode,
    subfolder: sanitizePathFragment(newSettings.subfolder || DEFAULT_SETTINGS.subfolder),
    delaySeconds: clampNumber(newSettings.delaySeconds, 0, 600, DEFAULT_SETTINGS.delaySeconds),
    ffmpegPath: typeof newSettings.ffmpegPath === "string" ? newSettings.ffmpegPath.trim() : "",
    maxQuality: ["best", "2160", "1440", "1080", "720", "480", "360"].includes(
      newSettings.maxQuality
    )
      ? newSettings.maxQuality
      : DEFAULT_SETTINGS.maxQuality,
    downloadTranscripts: Boolean(newSettings.downloadTranscripts),
    ytDlpCookiesFromBrowser:
      typeof newSettings.ytDlpCookiesFromBrowser === "string"
        ? newSettings.ytDlpCookiesFromBrowser.trim()
        : "",
    ytDlpCookiesFile:
      typeof newSettings.ytDlpCookiesFile === "string"
        ? newSettings.ytDlpCookiesFile.trim()
        : "",
    ytDlpWarmupEnabled: Boolean(newSettings.ytDlpWarmupEnabled),
    ytDlpWarmupDelayMs: clampNumber(newSettings.ytDlpWarmupDelayMs, 0, 15000, DEFAULT_SETTINGS.ytDlpWarmupDelayMs),
    ytDlpWarmupCooldownMs: clampNumber(
      newSettings.ytDlpWarmupCooldownMs,
      0,
      600000,
      DEFAULT_SETTINGS.ytDlpWarmupCooldownMs
    ),
    ytDlpWarmupCloseTab: newSettings.ytDlpWarmupCloseTab !== false,
    ytDlpWarmupBrowserCommand:
      typeof newSettings.ytDlpWarmupBrowserCommand === "string"
        ? newSettings.ytDlpWarmupBrowserCommand.trim()
        : "",
    whisperCommand:
      typeof newSettings.whisperCommand === "string"
        ? newSettings.whisperCommand.trim()
        : ""
  };
  appSettings = { ...safe };
  chrome.storage?.sync?.set?.({ ytSaverSettings: safe }, () => callback?.(safe));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizePathFragment(input) {
  if (!input || typeof input !== "string") return "";
  return input
    .replace(/\\/g, "/")
    .replace(/^\/*/, "") // remove leading slashes
    .replace(/\.\./g, "") // remove parent dir refs
    .replace(/[<>:"|?*]+/g, "")
    .trim();
}

function getDownloadPathForFile(fileName) {
  const cleanFile = fileName.replace(/^\/+/, "");
  if (appSettings.saveMode === "subfolder") {
    const base = sanitizePathFragment(appSettings.subfolder || "");
    if (base) {
      return `${base}/${cleanFile}`;
    }
  }
  // default path
  return `YouTube/${cleanFile}`;
}

// Channel-aware helpers
function getChannelNameFromPlayerResponse(playerResponse) {
  const vd = playerResponse?.videoDetails || {};
  const mf = playerResponse?.microformat?.playerMicroformatRenderer || {};
  const name =
    vd.author ||
    mf.ownerChannelName ||
    mf.ownerProfileUrl ||
    "";
  return sanitizePathFragment(String(name || "").replace(/^@/, ""));
}

function getChannelIdFromPlayerResponse(playerResponse) {
  const id = playerResponse?.videoDetails?.channelId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

/** Metadata bundle for library + StreamStein youtube-catalog.json */
function buildYoutubeMediaMeta({
  videoId,
  watchUrl,
  videoTitle,
  playerResponse,
  assetType,
  source,
  quality,
  channelName
}) {
  const id =
    (typeof videoId === "string" && videoId.trim()) ||
    (watchUrl ? extractVideoId(watchUrl) : null) ||
    null;
  const watch =
    watchUrl || (id ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : null);
  const shortUrl = id ? `https://youtu.be/${encodeURIComponent(id)}` : null;
  const thumbnailUrl = id
    ? `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`
    : null;
  const title = typeof videoTitle === "string" ? videoTitle : null;
  return {
    videoId: id,
    watchUrl: watch,
    shortUrl,
    thumbnailUrl,
    title,
    normalizedTitle: title ? normalizeTitleKey(title) : null,
    channelId: playerResponse ? getChannelIdFromPlayerResponse(playerResponse) : null,
    channelName:
      channelName ||
      (playerResponse ? getChannelNameFromPlayerResponse(playerResponse) : null) ||
      null,
    assetType: assetType === "transcript" ? "transcript" : "video",
    source: typeof source === "string" ? source : null,
    quality: typeof quality === "string" ? quality : null
  };
}

function getDefaultChannelPathForFile(fileName, channelName) {
  const folder = sanitizePathFragment(channelName || "");
  const cleanFile = fileName.replace(/^\/+/, "");
  if (folder) return `YouTube/${folder}/${cleanFile}`;
  return `YouTube/${cleanFile}`;
}

function getDirectoryPart(inputPath) {
  const parts = String(inputPath || "").replace(/\\/g, "/").split("/");
  parts.pop(); // remove filename
  return parts.filter(Boolean).join("/");
}

function getLastFolderName(inputPath) {
  const dir = getDirectoryPart(inputPath);
  const parts = dir.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

// Modal confirmation for save location
const pathConfirmOverlay = document.getElementById("path-confirm-overlay");
const pathConfirmText = document.getElementById("path-confirm-text");
const pathConfirmKeepBtn = document.getElementById("path-confirm-keep");
const pathConfirmDefaultBtn = document.getElementById("path-confirm-default");

function confirmSaveDestination({ videoTitle, channelName, configuredPath, defaultPath }) {
  return new Promise((resolve) => {
    if (!pathConfirmOverlay || !pathConfirmText || !pathConfirmKeepBtn || !pathConfirmDefaultBtn) {
      resolve("configured");
      return;
    }
    const configuredFolder = getDirectoryPart(configuredPath) || "(Downloads)";
    const defaultFolder = getDirectoryPart(defaultPath) || "(Downloads)";
    const channelLabel = channelName || "this channel";
    pathConfirmText.innerHTML =
      `You're downloading <strong>${sanitizeFileName(videoTitle)}</strong> from <strong>${channelLabel}</strong>.<br/>` +
      `Your current save folder is <strong>${configuredFolder}</strong>.<br/>` +
      `Do you want to save in the channel folder instead (<strong>${defaultFolder}</strong>)?`;
    pathConfirmOverlay.style.display = "flex";
    const onKeep = () => {
      cleanup();
      resolve("configured");
    };
    const onDefault = () => {
      cleanup();
      resolve("default");
    };
    function cleanup() {
      pathConfirmOverlay.style.display = "none";
      pathConfirmKeepBtn.removeEventListener("click", onKeep);
      pathConfirmDefaultBtn.removeEventListener("click", onDefault);
    }
    pathConfirmKeepBtn.addEventListener("click", onKeep);
    pathConfirmDefaultBtn.addEventListener("click", onDefault);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBridge(path, init = {}) {
  const endpoints = ["http://127.0.0.1:8789", "http://localhost:8789"];
  for (const base of endpoints) {
    try {
      const res = await fetch(`${base}${path}`, init);
      // Return the response even if not OK so callers can read the error body.
      if (res) return res;
    } catch (_) {
      // try next endpoint
    }
  }
  return null;
}

// =====================
// StreamStein backend status (header indicator)
// =====================

const backendStatusEl = document.getElementById("backend-status");
const backendStatusLabelEl = document.getElementById("backend-status-label");
const appMainShellEl = document.getElementById("app-main-shell");
const backendUiSkeletonEl = document.getElementById("backend-ui-skeleton");
const backendSkeletonHintEl = document.getElementById("backend-skeleton-hint");
const backendOfflineShieldEl = document.getElementById("backend-offline-shield");
const backendOfflineShieldActionBtn = document.getElementById("backend-offline-shield-action");
const tabContentEl = document.querySelector(".tab-content");
const backendConnectedOverlay = document.getElementById("backend-connected-overlay");
const backendConnectedOkBtn = document.getElementById("backend-connected-ok");
const backendConnectedLibraryEl = document.getElementById("backend-connected-library-path");
const backendOfflineOverlay = document.getElementById("backend-offline-overlay");
const backendOfflineOkBtn = document.getElementById("backend-offline-ok");

const BRIDGE_ENDPOINT = "http://127.0.0.1:8789";
const backendConnectedEndpointEl = document.getElementById("backend-connected-endpoint");

const backendConnectedDetailsCache = {
  libraryFolder: "Downloads/YouTube",
  endpoint: BRIDGE_ENDPOINT
};

/** @type {"checking"|"connected"|"disconnected"} */
let bridgeBackendStatus = "checking";
let bridgeStatusPollTimer = null;
let bridgeStatusInFlight = false;

const BACKEND_STATUS_COPY = {
  checking: {
    label: "Checking",
    title: "Checking StreamStein backend…",
    className: "backend-status--checking",
    interactive: false,
  },
  connected: {
    label: "Connected",
    title: "Connected — click for connection details",
    className: "backend-status--connected",
    interactive: true,
  },
  disconnected: {
    label: "Offline",
    title: "StreamStein is not running — click for help",
    className: "backend-status--disconnected",
    interactive: true,
  },
};

function updateBackendStatusAccessibility(nextStatus) {
  if (!backendStatusEl) return;
  const copy = BACKEND_STATUS_COPY[nextStatus] || BACKEND_STATUS_COPY.checking;
  if (copy.interactive) {
    backendStatusEl.setAttribute("role", "button");
    backendStatusEl.setAttribute("tabindex", "0");
    backendStatusEl.setAttribute("aria-label", copy.title);
  } else {
    backendStatusEl.setAttribute("role", "status");
    backendStatusEl.removeAttribute("tabindex");
    backendStatusEl.removeAttribute("aria-label");
  }
}

function updateBackendUiGate(nextStatus) {
  const checking = nextStatus === "checking";
  const offline = nextStatus === "disconnected";
  const ready = nextStatus === "connected";

  if (appMainShellEl) {
    appMainShellEl.classList.toggle("is-backend-checking", checking);
    appMainShellEl.classList.toggle("is-backend-offline", offline);
    appMainShellEl.classList.toggle("is-backend-ready", ready);
    appMainShellEl.setAttribute("aria-busy", checking ? "true" : "false");
  }

  if (backendUiSkeletonEl) {
    const showSkeleton = checking || offline;
    backendUiSkeletonEl.classList.toggle("is-visible", showSkeleton);
    backendUiSkeletonEl.hidden = !showSkeleton;
    backendUiSkeletonEl.setAttribute("aria-hidden", showSkeleton ? "false" : "true");
  }

  if (backendSkeletonHintEl) {
    backendSkeletonHintEl.hidden = !checking;
  }

  if (backendOfflineShieldEl) {
    backendOfflineShieldEl.classList.toggle("is-visible", offline);
    backendOfflineShieldEl.hidden = !offline;
    backendOfflineShieldEl.setAttribute("aria-hidden", offline ? "false" : "true");
  }

  if (tabContentEl) {
    tabContentEl.setAttribute("aria-hidden", ready ? "false" : "true");
  }
}

function setBridgeBackendStatus(nextStatus) {
  bridgeBackendStatus = nextStatus;
  if (!backendStatusEl || !backendStatusLabelEl) return;

  const copy = BACKEND_STATUS_COPY[nextStatus] || BACKEND_STATUS_COPY.checking;
  backendStatusEl.classList.remove(
    "backend-status--checking",
    "backend-status--connected",
    "backend-status--disconnected",
    "backend-status--interactive",
  );
  backendStatusEl.classList.add(copy.className);
  if (copy.interactive) backendStatusEl.classList.add("backend-status--interactive");
  backendStatusEl.title = copy.title;
  backendStatusLabelEl.textContent = copy.label;
  updateBackendStatusAccessibility(nextStatus);
  updateBackendUiGate(nextStatus);
}

async function pingBridgeBackend() {
  const res = await fetchBridge("/api/ping", { method: "GET" });
  if (!res?.ok) return false;
  try {
    const data = await res.json();
    return data?.ok === true;
  } catch {
    return false;
  }
}

async function refreshBridgeBackendStatus({ forceChecking = false } = {}) {
  if (bridgeStatusInFlight) return bridgeBackendStatus === "connected";
  bridgeStatusInFlight = true;
  if (forceChecking) setBridgeBackendStatus("checking");

  try {
    const alive = await pingBridgeBackend();
    setBridgeBackendStatus(alive ? "connected" : "disconnected");
    if (alive) {
      void prefetchBackendConnectedDetails();
    }
    return alive;
  } finally {
    bridgeStatusInFlight = false;
  }
}

function startBridgeBackendMonitor() {
  void refreshBridgeBackendStatus({ forceChecking: true });
  if (bridgeStatusPollTimer) clearInterval(bridgeStatusPollTimer);
  bridgeStatusPollTimer = setInterval(() => {
    void refreshBridgeBackendStatus();
  }, 5000);
}

function hideBackendOfflineModal() {
  if (backendOfflineOverlay) backendOfflineOverlay.style.display = "none";
}

function hideBackendConnectedModal() {
  if (backendConnectedOverlay) backendConnectedOverlay.style.display = "none";
}

function hideAllBackendStatusModals() {
  hideBackendOfflineModal();
  hideBackendConnectedModal();
}

function catalogPathToLibraryFolder(catalogPath) {
  if (!catalogPath) return null;
  const folder = String(catalogPath).replace(/[/\\]youtube-catalog\.json$/i, "");
  return folder || catalogPath;
}

function rememberBackendConnectedDetails(catalogPath) {
  const folder = catalogPathToLibraryFolder(catalogPath);
  if (folder) {
    backendConnectedDetailsCache.libraryFolder = folder;
  }
}

function applyBackendConnectedDetailsToModal() {
  if (backendConnectedEndpointEl) {
    backendConnectedEndpointEl.textContent = backendConnectedDetailsCache.endpoint || BRIDGE_ENDPOINT;
  }
  if (backendConnectedLibraryEl) {
    backendConnectedLibraryEl.textContent =
      backendConnectedDetailsCache.libraryFolder || "Downloads/YouTube";
  }
}

async function prefetchBackendConnectedDetails() {
  try {
    const res = await fetchBridge("/api/config", { method: "GET" });
    if (!res?.ok) return;
    const data = await res.json();
    if (data?.youtubeCatalogPath) {
      youtubeCatalogPathHint = data.youtubeCatalogPath;
      rememberBackendConnectedDetails(data.youtubeCatalogPath);
      updateChannelLibrarySummaryUI();
    }
    if (backendConnectedOverlay?.style.display === "flex") {
      applyBackendConnectedDetailsToModal();
    }
  } catch {
    // keep cached values
  }
}

function showBackendConnectedModal() {
  if (!backendConnectedOverlay) return;
  hideBackendOfflineModal();
  if (youtubeCatalogPathHint) {
    rememberBackendConnectedDetails(youtubeCatalogPathHint);
  }
  applyBackendConnectedDetailsToModal();
  backendConnectedOverlay.style.display = "flex";
  void prefetchBackendConnectedDetails();
}

function showBackendOfflineModal() {
  if (!backendOfflineOverlay) return;
  hideBackendConnectedModal();
  backendOfflineOverlay.style.display = "flex";
}

backendConnectedOkBtn?.addEventListener("click", hideBackendConnectedModal);
backendConnectedOverlay?.addEventListener("click", (event) => {
  if (event.target === backendConnectedOverlay) hideBackendConnectedModal();
});

backendOfflineShieldActionBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  showBackendOfflineModal();
});

backendOfflineOkBtn?.addEventListener("click", hideBackendOfflineModal);
backendOfflineOverlay?.addEventListener("click", (event) => {
  if (event.target === backendOfflineOverlay) hideBackendOfflineModal();
});

function handleBackendStatusBadgeActivate() {
  if (bridgeBackendStatus === "connected") {
    showBackendConnectedModal();
    return;
  }
  if (bridgeBackendStatus === "disconnected") {
    showBackendOfflineModal();
    return;
  }
  void refreshBridgeBackendStatus({ forceChecking: true });
}

backendStatusEl?.addEventListener("click", handleBackendStatusBadgeActivate);
backendStatusEl?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  if (!BACKEND_STATUS_COPY[bridgeBackendStatus]?.interactive) return;
  event.preventDefault();
  handleBackendStatusBadgeActivate();
});

async function requireStreamsteinBackend() {
  if (bridgeBackendStatus === "connected") return true;
  const alive = await refreshBridgeBackendStatus({ forceChecking: true });
  if (alive) return true;
  showBackendOfflineModal();
  return false;
}

function setLibraryControlsEnabled(enabled) {
  // Keep these checkboxes always interactive; if the library snapshot
  // isn't ready yet, the filters simply won't exclude anything.
  if (channelOnlyMissingCheckbox) channelOnlyMissingCheckbox.disabled = false;
  if (channelMissingTranscriptsCheckbox) channelMissingTranscriptsCheckbox.disabled = false;
}

function updateChannelLibrarySummaryUI() {
  if (!channelLibrarySummaryEl) return;
  const lines = [];
  if (globalLibrarySummary) {
    lines.push(
      `Library: ${globalLibrarySummary.videosWithFile || 0} videos, ${
        globalLibrarySummary.transcriptsWithFile || 0
      } transcripts.`
    );
  }
  if (channelLibraryMatchSummary) {
    lines.push(
      `Channel snapshot: ${channelLibraryMatchSummary.haveVideo || 0}/${
        channelLibraryMatchSummary.total || 0
      } videos downloaded, ${channelLibraryMatchSummary.haveTranscript || 0} transcripts.`
    );
  }
  if (youtubeCatalogPathHint) {
    lines.push(`StreamStein catalog: ${youtubeCatalogPathHint}`);
  }
  channelLibrarySummaryEl.textContent = lines.join(" ");
  setLibraryControlsEnabled(Boolean(channelLibraryMatchSummary));
}

async function refreshYoutubeCatalogPathHint() {
  try {
    const res = await fetchBridge("/api/config", { method: "GET" });
    if (!res?.ok) return;
    const data = await res.json();
    if (data?.youtubeCatalogPath) {
      youtubeCatalogPathHint = data.youtubeCatalogPath;
      rememberBackendConnectedDetails(data.youtubeCatalogPath);
      updateChannelLibrarySummaryUI();
    }
  } catch {
    // bridge may be offline
  }
}

async function refreshGlobalLibrarySummary({ forceRescan = false } = {}) {
  try {
    const endpoint = forceRescan ? "/api/library/rescan" : "/api/library";
    const init = forceRescan
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        }
      : { method: "GET" };
    const res = await fetchBridge(endpoint, init);
    if (!res) {
      return false;
    }
    const data = await res.json();
    if (forceRescan) {
      const summary = data?.summary;
      globalLibrarySummary = summary?.librarySummary || summary || null;
    } else {
      globalLibrarySummary = data?.summary || null;
    }
    updateChannelLibrarySummaryUI();
    return true;
  } catch (err) {
    console.warn("Failed to refresh library summary", err);
    return false;
  }
}

let libraryIndexReadyPromise = null;

function invalidateLibraryIndexCache() {
  libraryIndexReadyPromise = null;
}

function labelFromFilenameHint(filenameHint) {
  if (!filenameHint || typeof filenameHint !== "string") return "";
  const parts = filenameHint.replace(/\\/g, "/").split("/");
  const base = parts[parts.length - 1] || filenameHint;
  return base.replace(/\.(mp4|mkv|webm|vtt|srt)$/i, "").trim() || base;
}

async function refreshLibraryAfterDownload(meta = {}) {
  invalidateLibraryIndexCache();
  const refreshed = await refreshGlobalLibrarySummary({ forceRescan: false });
  if (cachedChannelVideos.length) {
    await fetchChannelLibraryMatches(cachedChannelVideos);
  }
  if (meta?.videoId && videoUrlInput) {
    const currentUrl = videoUrlInput.value?.trim?.() || "";
    const currentId = currentUrl ? extractVideoId(currentUrl) : "";
    if (currentId && currentId === meta.videoId) {
      await resolveSingleVideoLibraryMatch(currentUrl, {
        force: true,
        fetchTitleIfNeeded: false
      });
    }
  }
  return refreshed;
}

async function ensureLibraryIndexed() {
  if (!libraryIndexReadyPromise) {
    libraryIndexReadyPromise = (async () => {
      const ok = await refreshGlobalLibrarySummary({ forceRescan: false });
      if (!ok) return false;
      if ((globalLibrarySummary?.videosWithFile || 0) === 0) {
        return refreshGlobalLibrarySummary({ forceRescan: true });
      }
      return true;
    })();
  }
  return libraryIndexReadyPromise;
}

function deriveChannelHint(channelUrl) {
  try {
    const u = new URL(channelUrl);
    // Strip common trailing sections so we end up with the canonical channel
    // handle or path segment (e.g. "/@TimDillonShow").
    const withoutVideos = u.pathname.replace(/\/(videos?|streams?)\/?$/i, "");
    const parts = withoutVideos.split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "";
    return last.replace(/^@/, "");
  } catch {
    return "";
  }
}

function isPlaceholderChannelTitle(title) {
  return /^Video \d+$/i.test(String(title || "").trim());
}

async function refreshLibraryMatchForMetadata(videoId, title, channelHint = null) {
  if (!videoId) return null;
  try {
    await ensureLibraryIndexed();
    const hint =
      channelHint !== null && channelHint !== undefined
        ? channelHint
        : deriveChannelHint(channelUrlInput?.value?.trim?.() || "");
    const res = await fetchBridge("/api/library/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videos: [{ videoId, title: title || "" }],
        channelHint: hint,
        debug: false
      })
    });
    if (!res) return null;
    const data = await res.json();
    const match = Array.isArray(data?.videos) ? data.videos[0] : null;
    if (!match) return null;
    if (match.videoId) {
      channelLibraryLookup.byId.set(match.videoId, match);
    }
    if (videoId && videoId !== match.videoId) {
      channelLibraryLookup.byId.set(videoId, match);
    }
    if (match.normalizedTitle) {
      channelLibraryLookup.byNormalized.set(match.normalizedTitle, match);
    }
    const idx = channelLibraryMatches.findIndex(
      (m) => m.videoId === videoId || m.videoId === match.videoId
    );
    if (idx >= 0) {
      channelLibraryMatches[idx] = match;
    } else {
      channelLibraryMatches.push(match);
    }
    return match;
  } catch (err) {
    console.warn("Failed to refresh library match for video", videoId, err);
    return null;
  }
}

async function fetchChannelLibraryMatches(videos) {
  if (!Array.isArray(videos) || !videos.length) {
    channelLibraryMatches = [];
    channelLibraryMatchSummary = null;
    channelLibraryLookup.byId.clear();
    channelLibraryLookup.byNormalized.clear();
    updateChannelLibrarySummaryUI();
    return false;
  }
  try {
    await ensureLibraryIndexed();
    const rawChannelUrl = channelUrlInput?.value?.trim?.() || "";
    const channelHint = deriveChannelHint(rawChannelUrl);
    const payload = {
      videos: videos.map((video) => ({
        videoId: video.id,
        title: video.title || "",
        normalizedTitle: video.normalizedTitle || normalizeTitleKey(video.title || "")
      })),
      channelHint,
      rescanBeforeCheck: true,
      debug: false
    };
    const res = await fetchBridge("/api/library/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res) {
      throw new Error("Bridge unavailable");
    }
    const data = await res.json();
    channelLibraryMatches = Array.isArray(data?.videos) ? data.videos : [];
    channelLibraryMatchSummary = data?.summary || null;
    rebuildChannelLibraryLookup(channelLibraryMatches);
    videos.forEach((video, index) => {
      if (!video?.id) return;
      const match =
        channelLibraryMatches.find((m) => m.index === index) || channelLibraryMatches[index];
      if (match) {
        channelLibraryLookup.byId.set(video.id, match);
      }
    });
    updateChannelLibrarySummaryUI();
    applyInLibraryDefaultExclusions();
    return true;
  } catch (err) {
    console.warn("Failed to load channel library snapshot", err);
    channelLibraryMatches = [];
    channelLibraryMatchSummary = null;
    channelLibraryLookup.byId.clear();
    channelLibraryLookup.byNormalized.clear();
    updateChannelLibrarySummaryUI();
    return false;
  }
}

function rebuildChannelLibraryLookup(matches) {
  channelLibraryLookup.byId.clear();
  channelLibraryLookup.byNormalized.clear();
  matches.forEach((match) => {
    if (match.videoId) {
      channelLibraryLookup.byId.set(match.videoId, match);
    }
    if (match.normalizedTitle) {
      channelLibraryLookup.byNormalized.set(match.normalizedTitle, match);
    }
  });
}

function getLibraryMatchForVideo(video) {
  if (!video) return null;
  if (video.id && channelLibraryLookup.byId.has(video.id)) {
    return channelLibraryLookup.byId.get(video.id);
  }
  if (video.normalizedTitle && channelLibraryLookup.byNormalized.has(video.normalizedTitle)) {
    return channelLibraryLookup.byNormalized.get(video.normalizedTitle);
  }
  const fileNorm = normalizeTitleKey(sanitizeFileName(video.title || ""));
  if (fileNorm && channelLibraryLookup.byNormalized.has(fileNorm)) {
    return channelLibraryLookup.byNormalized.get(fileNorm);
  }
  return null;
}

function isVideoAlreadyDownloaded(video) {
  if (isPlaceholderChannelTitle(video?.title)) {
    return false;
  }
  const match = getLibraryMatchForVideo(video);
  return Boolean(match?.hasVideo);
}

let singleVideoLibraryState = { url: "", videoId: "", match: null };
let singleLibraryCheckTimer = null;
let singleLibraryCheckGeneration = 0;

function getSingleVideoLibraryWarning(match) {
  if (!match?.hasVideo) return null;
  if (match.hasTranscript) {
    return "This video is already in your local library (video and transcript). Download is disabled to avoid duplicate files.";
  }
  if (appSettings.downloadTranscripts) {
    return "Video file already in your local library. Download will only fetch a missing transcript, not another copy of the video.";
  }
  return "This video is already in your local library. Download is disabled to avoid duplicate files.";
}

function updateSingleVideoDownloadButton(match) {
  if (!downloadVideoBtn) return;
  const hasVideo = Boolean(match?.hasVideo);
  const hasTranscript = Boolean(match?.hasTranscript);
  const transcriptsEnabled = Boolean(appSettings.downloadTranscripts);
  const nothingToDownload = hasVideo && (!transcriptsEnabled || hasTranscript);
  downloadVideoBtn.disabled = nothingToDownload;
  downloadVideoBtn.title = nothingToDownload ? "Already in your local library" : "";
}

function setSingleVideoStatusWithLibrary(primaryMessage, primaryType, match) {
  const lines = [{ message: primaryMessage, type: primaryType }];
  const warning = getSingleVideoLibraryWarning(match);
  if (warning) {
    lines.push({ message: warning, type: "warning" });
  }
  setStatusSingleMessages(lines);
  updateSingleVideoDownloadButton(match);
}

async function resolveSingleVideoLibraryMatch(url, options = {}) {
  const trimmed = (url || "").trim();
  if (!trimmed || !isYouTubeWatchUrl(trimmed)) {
    singleVideoLibraryState = { url: "", videoId: "", match: null };
    return null;
  }
  const videoId = extractVideoId(trimmed);
  if (!videoId) {
    singleVideoLibraryState = { url: trimmed, videoId: "", match: null };
    return null;
  }
  if (
    !options.force &&
    singleVideoLibraryState.url === trimmed &&
    singleVideoLibraryState.videoId === videoId &&
    singleVideoLibraryState.match
  ) {
    return singleVideoLibraryState.match;
  }

  let match = await refreshLibraryMatchForMetadata(videoId, "", "");
  if (!match?.hasVideo && options.fetchTitleIfNeeded !== false) {
    try {
      const meta = await loadPlayerResponse(trimmed);
      match = await refreshLibraryMatchForMetadata(meta.videoId, meta.videoTitle, "");
    } catch {
      // videoId-only check is enough when metadata is unavailable
    }
  }
  singleVideoLibraryState = { url: trimmed, videoId, match: match || null };
  return match;
}

function scheduleSingleVideoLibraryCheck(url, primaryMessage, primaryType) {
  if (singleLibraryCheckTimer) clearTimeout(singleLibraryCheckTimer);
  const generation = ++singleLibraryCheckGeneration;
  singleLibraryCheckTimer = setTimeout(async () => {
    singleLibraryCheckTimer = null;
    if (generation !== singleLibraryCheckGeneration) return;
    const currentUrl = videoUrlInput?.value?.trim?.() || "";
    if (currentUrl !== (url || "").trim()) return;
    const match = await resolveSingleVideoLibraryMatch(url, { fetchTitleIfNeeded: true });
    if (generation !== singleLibraryCheckGeneration) return;
    if ((videoUrlInput?.value?.trim?.() || "") !== (url || "").trim()) return;
    setSingleVideoStatusWithLibrary(primaryMessage, primaryType, match);
  }, 350);
}

function isTranscriptMissingForVideo(video) {
  const match = getLibraryMatchForVideo(video);
  return Boolean(match?.hasVideo) && !match?.hasTranscript;
}

function findVideoForMatch(match) {
  if (!match) return null;
  if (match.videoId) {
    const found = cachedChannelVideos.find((video) => video.id === match.videoId);
    if (found) return found;
  }
  if (match.normalizedTitle) {
    return cachedChannelVideos.find((video) => video.normalizedTitle === match.normalizedTitle) || null;
  }
  return null;
}

function buildTranscriptCatchupTargets(plannedIds = new Set()) {
  if (!channelMissingTranscriptsCheckbox?.checked) return [];
  return channelLibraryMatches.filter((match) => {
    if (!match?.hasVideo || match.hasTranscript) return false;
    if (!match.videoId) return false;
    if (plannedIds.has(match.videoId)) return false;
    return true;
  });
}

// Extract video ID from various YouTube URL shapes
function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") {
      return u.pathname.slice(1);
    }

    if (u.searchParams.get("v")) {
      return u.searchParams.get("v");
    }

    const parts = u.pathname.split("/");
    const shortsIndex = parts.indexOf("shorts");
    if (shortsIndex !== -1 && parts[shortsIndex + 1]) {
      return parts[shortsIndex + 1];
    }

    return null;
  } catch (err) {
    return null;
  }
}

// Safe filename from video title
function sanitizeFileName(name) {
  if (!name || typeof name !== "string") {
    return "youtube-video";
  }

  return (
    name
      // Strip control characters
      .replace(/[\u0000-\u001F\u007F]+/g, " ")
      // Strip any non-ASCII characters (smart quotes, emojis, etc.)
      .replace(/[^\x20-\x7E]+/g, " ")
      // Remove characters invalid for common filesystems
      .replace(/[<>:"/\\|?*]+/g, " ")
      // Collapse whitespace
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "youtube-video"
  );
}

function normalizeTitleKey(input = "") {
  return input
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Try local bridge first (background will call http://127.0.0.1:8789)
function attemptBridgeDownload(videoUrl, title, options = {}) {
  return new Promise((resolve) => {
    try {
      const { saveAs = true, downloadPath, params, endpoint, meta } = options;
      const baseName = (title ? sanitizeFileName(title) : "youtube-video") + ".mp4";
      const filenameHint = downloadPath || baseName;
      chrome.runtime?.sendMessage?.(
        {
          type: "BRIDGE_DOWNLOAD",
          url: videoUrl,
          filenameHint,
          saveAs,
          params,
          endpoint,
          meta: meta || null
        },
        (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, error: "Unknown bridge error" });
        }
      );
    } catch (e) {
      resolve({ ok: false, error: e?.message || "Bridge call failed" });
    }
  });
}

// =====================
// Download progress indicator (infinite bar)
// =====================

const progressContainer = document.getElementById("download-progress-container");
let channelBatchActive = false;
let extraJobActive = false;

function showProgressBar() {
  if (progressContainer) {
    progressContainer.classList.add("active");
  }
}

function hideProgressBar() {
  if (progressContainer) {
    progressContainer.classList.remove("active");
  }
}

async function handleDownloadFinished(message) {
  const { state, filenameHint, meta, isChannel } = message || {};
  if (state !== "complete") return;

  await refreshLibraryAfterDownload(meta || {});

  const assetLabel =
    meta?.assetType === "transcript" ? "Transcript" : "Video";
  const title =
    meta?.title ||
    labelFromFilenameHint(filenameHint) ||
    "Download";
  const successLine = `${assetLabel} saved:\n<strong>${title}</strong>`;

  if (isChannel || channelBatchActive) {
    appendChannelLog(`✓ ${assetLabel} complete: ${title}`);
  }

  if (!isChannel && !channelBatchActive && !extraJobActive) {
    const url = videoUrlInput?.value?.trim?.() || "";
    const match =
      singleVideoLibraryState.match ||
      (url && isYouTubeWatchUrl(url)
        ? await resolveSingleVideoLibraryMatch(url, {
            force: true,
            fetchTitleIfNeeded: false
          })
        : null);
    setSingleVideoStatusWithLibrary(successLine, "success", match);
    hideProgressBar();
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "YT_SAVER_DOWNLOAD_PROGRESS") {
    const { state } = message;
    if (state === "complete") {
      if (channelBatchActive || extraJobActive || message.isChannel) {
        // Bar stays visible until the batch finishes; status updates via YT_SAVER_DOWNLOAD_COMPLETE.
      } else {
        hideProgressBar();
      }
    } else if (state === "interrupted") {
      if (!channelBatchActive && !extraJobActive) {
        hideProgressBar();
        if (!message.isChannel) {
          setStatusSingle("Download was interrupted.", "error");
        }
      }
    } else {
      showProgressBar();
    }
  } else if (message?.type === "YT_SAVER_DOWNLOAD_COMPLETE") {
    handleDownloadFinished({ ...message, state: "complete" }).catch((err) => {
      console.warn("[YouTube Downloader] Download complete handler failed", err);
    });
  } else if (message?.type === "YT_SAVER_CHANNEL_STATUS") {
    const msg = message.message || "";
    if (msg) {
      if (!channelStatusState.showLog && channelStatusState.summary) {
        channelStatusState.showLog = true;
      }
      appendChannelLog(msg);
    }
    if (msg.includes("Channel batch completed.")) {
      scheduleChannelBatchFinalize();
    }
  }
});

// Get the active tab from the last-focused NORMAL Chrome window (ignoring this extension window).
function queryActiveTabInLastNormalWindow(callback) {
  try {
    chrome.windows.getLastFocused({ windowTypes: ["normal"] }, (win) => {
      const winId = win && typeof win.id === "number" ? win.id : undefined;
      const query = winId != null ? { active: true, windowId: winId } : { active: true, currentWindow: true };
      chrome.tabs.query(query, (tabs) => {
        const tab = tabs && tabs[0];
        callback(tab || null);
      });
    });
  } catch {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      callback(tab || null);
    });
  }
}

// Get current active tab’s URL (from last-focused normal window)
function getCurrentTabUrl(callback) {
  queryActiveTabInLastNormalWindow((tab) => {
    callback(tab && tab.url ? tab.url : null);
  });
}

function getCurrentTab(callback) {
  queryActiveTabInLastNormalWindow((tab) => callback(tab));
}

// Live channel collection state
const liveChannelCollect = {
  tabId: null,
  url: null,
  count: 0,
  done: false,
  ids: [],
  videos: []
};

let cachedChannelVideos = [];
let channelLibraryMatches = [];
let channelLibraryMatchSummary = null;
let globalLibrarySummary = null;
let youtubeCatalogPathHint = null;
const channelLibraryLookup = {
  byId: new Map(),
  byNormalized: new Map()
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "YT_SAVER_COLLECT_PROGRESS") {
    const { count, done, url } = message;
    liveChannelCollect.count = count || 0;
    liveChannelCollect.done = Boolean(done);
    liveChannelCollect.url = url || liveChannelCollect.url;
    if (done) {
      if (Array.isArray(message.ids)) {
        liveChannelCollect.ids = message.ids;
      }
      if (Array.isArray(message.videos)) {
        liveChannelCollect.videos = message.videos;
      }
    }
    const channelPanel = document.getElementById("tab-channel");
    if (channelPanel?.classList.contains("active")) {
      if (done) {
        if (Array.isArray(liveChannelCollect.videos) && liveChannelCollect.videos.length) {
          cachedChannelVideos = normalizeVideoList(liveChannelCollect.videos);
          resetChannelVideoExclusions();
          void fetchChannelLibraryMatches(cachedChannelVideos);
        }
        showChannelFoundStatus(liveChannelCollect.count);
      } else {
        const status = `Scanning channel… found ${liveChannelCollect.count} so far.`;
        setStatusChannel(status, "info");
      }
    }
  }
});

async function openChannelSelectionEditor() {
  if (cachedChannelVideos.length) {
    await fetchChannelLibraryMatches(cachedChannelVideos);
  } else {
    applyInLibraryDefaultExclusions();
  }
  renderChannelVideoPicker();
}

function toggleChannelSelectionEditor(show) {
  if (!channelSelectionEditor) return;
  const next = Boolean(show);
  channelSelectionEditor.style.display = next ? "" : "none";
  if (next) {
    void openChannelSelectionEditor();
  }
}

function showChannelFoundStatus(count) {
  const editButtonHtml =
    '<button type="button" id="channel-edit-selection-btn" class="status-edit-button">Edit selection…</button>';
  const message = `Found ${count} videos on the channel page. ${editButtonHtml}`;
  setStatusChannel(message, "success");
  const btn = document.getElementById("channel-edit-selection-btn");
  if (btn) {
    btn.addEventListener("click", () => {
      const isVisible =
        channelSelectionEditor && channelSelectionEditor.style.display !== "none";
      toggleChannelSelectionEditor(!isVisible);
    });
  }
}

function onTabActivated(target) {
  if (target === "channel") {
    startLiveChannelScanIfApplicable();
  } else if (target === "extra") {
    initializeExtraTab();
  } else if (target === "chat") {
    stopLiveChannelScan();
    initializeChatTab();
  } else {
    stopLiveChannelScan();
  }
}

function startLiveChannelScanIfApplicable() {
  getCurrentTab((tab) => {
    if (!tab || !tab.id || !tab.url) {
      setStatusChannel("No active tab URL found.", "error");
      return;
    }
    if (!(isYouTubeChannelVideosUrl(tab.url) || isYouTubeChannelCandidateUrl(tab.url))) {
      setStatusChannel("Active tab is not a channel page.", "error");
      return;
    }
    if (!channelUrlInput.value) {
      channelUrlInput.value = tab.url;
    }
    setStatusChannel("Scanning channel…", "info");
    liveChannelCollect.tabId = tab.id;
    liveChannelCollect.url = tab.url;
    liveChannelCollect.count = 0;
    liveChannelCollect.done = false;
    liveChannelCollect.ids = [];
    liveChannelCollect.videos = [];
    chrome.tabs.sendMessage(
      tab.id,
      { type: "YT_SAVER_START_COLLECT", maxScrolls: 80, idleRounds: 3, waitMs: 900 },
      () => {}
    );
  });
}

function stopLiveChannelScan() {
  if (!liveChannelCollect.tabId) return;
  try {
    chrome.tabs.sendMessage(liveChannelCollect.tabId, { type: "YT_SAVER_STOP_COLLECT" });
  } catch {}
}

// Fetch HTML from a URL (YouTube page)
async function fetchHtml(url) {
  const res = await fetch(url, {
    credentials: "include", // closer to what your actual tab sees
    cache: "no-store"
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching page`);
  }
  return res.text();
}

// Robustly pull ytInitialPlayerResponse JSON out of HTML using brace balancing
function extractPlayerResponse(html) {
  const marker = "ytInitialPlayerResponse";
  let idx = html.indexOf(marker);
  if (idx === -1) {
    throw new Error("Could not locate ytInitialPlayerResponse in page HTML.");
  }

  idx = html.indexOf("=", idx);
  if (idx === -1) {
    throw new Error("Could not locate assignment for ytInitialPlayerResponse.");
  }

  let start = html.indexOf("{", idx);
  if (start === -1) {
    throw new Error("Could not locate JSON object for ytInitialPlayerResponse.");
  }

  let braceDepth = 0;
  let inString = false;
  let stringChar = null;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const ch = html[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === stringChar) {
        inString = false;
        stringChar = null;
      }
    } else {
      if (ch === '"' || ch === "'") {
        inString = true;
        stringChar = ch;
      } else if (ch === "{") {
        braceDepth++;
      } else if (ch === "}") {
        braceDepth--;
        if (braceDepth === 0) {
          const jsonStr = html.slice(start, i + 1);
          try {
            return JSON.parse(jsonStr);
          } catch (e) {
            throw new Error(
              "Failed to parse ytInitialPlayerResponse JSON: " + e.message
            );
          }
        }
      }
    }
  }

  throw new Error("Failed to parse ytInitialPlayerResponse JSON.");
}

// Prefer progressive MP4 (video+audio) with a proper googlevideo URL,
// otherwise fall back to any direct-url format. Reject obviously wrong URLs.
function selectBestFormat(playerResponse) {
  const streamingData = playerResponse.streamingData;
  if (!streamingData) {
    throw new Error("No streaming data available for this video.");
  }

  const progressiveFormats = Array.isArray(streamingData.formats)
    ? streamingData.formats
    : [];
  const allFormats = [
    ...progressiveFormats,
    ...(streamingData.adaptiveFormats || [])
  ];

  if (!allFormats.length) {
    throw new Error("No downloadable formats found.");
  }

  const hasDirectUrl = (f) => typeof f.url === "string" && f.url.startsWith("http");

  // Prefer progressive video (any container) with direct URL, highest height first
  const progressive = progressiveFormats
    .filter(
      (f) =>
        f.mimeType &&
        f.mimeType.includes("video/") &&
        hasDirectUrl(f)
    )
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  let chosen = progressive[0];

  // Fallback: any video format with direct URL (may be video-only)
  if (!chosen) {
    const withUrl = allFormats
      .filter(
        (f) =>
          f.mimeType &&
          f.mimeType.includes("video/") &&
          hasDirectUrl(f)
      )
      .sort((a, b) => (b.height || 0) - (a.height || 0));
    if (withUrl.length) {
      chosen = withUrl[0];
    }
  }

  if (!chosen) {
    throw new Error(
      "This video only exposes encrypted streams that are not supported by this extension."
    );
  }

  // Sanity-check host: most playable URLs are *.googlevideo.com
  try {
    const u = new URL(chosen.url);
    if (!u.hostname.includes("googlevideo.com")) {
      throw new Error();
    }
  } catch {
    throw new Error(
      "This video’s streams require additional decryption steps and are not supported by this extension."
    );
  }

  return chosen;
}

async function loadPlayerResponse(videoUrl) {
  const videoId = extractVideoId(videoUrl);
  if (!videoId) {
    throw new Error("Could not extract a valid video ID from the URL.");
  }

  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const html = await fetchHtml(watchUrl);
  const playerResponse = extractPlayerResponse(html);
  const videoTitle =
    playerResponse.videoDetails?.title || `youtube-video-${videoId}`;

  return { videoId, watchUrl, playerResponse, videoTitle };
}

// Download a single video by URL
async function downloadVideoByUrl(videoUrl, preloadedMetadata, options = {}) {
  const { saveAs = true } = options;
  const metadata = preloadedMetadata || (await loadPlayerResponse(videoUrl));
  const { videoId, playerResponse, videoTitle } = metadata;

  const format = selectBestFormat(playerResponse);
  const mime = (format.mimeType || "").toLowerCase();
  const ext = mime.includes("webm") ? "webm" : "mp4";
  const fileName = sanitizeFileName(videoTitle) + "." + ext;
  const finalPath = getDownloadPathForFile(fileName);

  await new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: format.url,
        filename: finalPath,
        saveAs
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(
            new Error("Download failed: " + chrome.runtime.lastError.message)
          );
        } else if (!downloadId && downloadId !== 0) {
          reject(new Error("Download could not be started."));
        } else {
          resolve();
        }
      }
    );
  });

  return { title: videoTitle, videoId };
}

// Extract video IDs from a channel "Videos" page HTML
function extractVideoIdsFromChannelHtml(html) {
  const videos = [];
  try {
    const data = extractEmbeddedJson(html, "ytInitialData");
    const collected = collectVideosFromInitialData(data);
    if (collected.length) {
      return collected;
    }
  } catch (err) {
    console.warn("Failed to parse ytInitialData:", err);
  }
  const ids = new Set();
  const regex = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    ids.add(match[1]);
  }
  return Array.from(ids).map((id, idx) => formatVideoEntry({ id, title: `Video ${idx + 1}` }, idx));
}

function extractEmbeddedJson(html, marker) {
  let idx = html.indexOf(marker);
  if (idx === -1) {
    throw new Error(`Marker ${marker} not found`);
  }
  idx = html.indexOf("=", idx);
  if (idx === -1) throw new Error(`Assignment for ${marker} not found`);
  let start = html.indexOf("{", idx);
  if (start === -1) throw new Error("JSON object start not found");
  let braceDepth = 0;
  let inString = false;
  let stringChar = null;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === stringChar) {
        inString = false;
        stringChar = null;
      }
    } else if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
    } else if (ch === "{") {
      braceDepth++;
    } else if (ch === "}") {
      braceDepth--;
      if (braceDepth === 0) {
        const jsonStr = html.slice(start, i + 1);
        return JSON.parse(jsonStr);
      }
    }
  }
  throw new Error(`Failed to parse ${marker} JSON`);
}

function collectVideosFromInitialData(data) {
  const results = [];
  const seen = new Set();
  const stack = [data];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (typeof node !== "object") continue;
    const renderer =
      node.gridVideoRenderer ||
      node.videoRenderer ||
      (node.richItemRenderer && node.richItemRenderer.content?.videoRenderer);
    if (renderer && renderer.videoId && !seen.has(renderer.videoId)) {
      const title =
        renderer.title?.simpleText ||
        (Array.isArray(renderer.title?.runs)
          ? renderer.title.runs.map((r) => r.text).join(" ")
          : "") ||
        "";
      const entry = formatVideoEntry(
        {
          id: renderer.videoId,
          title
        },
        results.length
      );
      if (entry) {
        results.push(entry);
        seen.add(renderer.videoId);
      }
    }
    Object.values(node).forEach((value) => {
      if (value && typeof value === "object") {
        stack.push(value);
      }
    });
  }
  return results;
}

// Normalize a user-provided channel URL
function normalizeChannelUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.hostname !== "www.youtube.com" && u.hostname !== "youtube.com") {
      throw new Error("Not a YouTube URL.");
    }

    if (!u.pathname.endsWith("/videos")) {
      if (u.pathname.endsWith("/")) {
        u.pathname += "videos";
      } else {
        u.pathname += "/videos";
      }
    }
    return u.toString();
  } catch {
    throw new Error("Invalid channel URL.");
  }
}

function sameChannelRoot(aUrl, bUrl) {
  try {
    const a = new URL(aUrl);
    const b = new URL(bUrl);
    if (!a.hostname.includes("youtube.com") || !b.hostname.includes("youtube.com")) {
      return false;
    }
    const strip = (p) => p.replace(/\/videos\/?$/, "").replace(/\/$/, "");
    return strip(a.pathname) === strip(b.pathname);
  } catch {
    return false;
  }
}

function collectChannelIdsFromActiveTabIfSame(channelUrl, progressCb) {
  return new Promise((resolve) => {
    getCurrentTab((tab) => {
      if (!tab || !tab.id || !tab.url) {
        resolve({ ok: false, reason: "no-active-tab" });
        return;
      }
      if (!sameChannelRoot(tab.url, channelUrl)) {
        resolve({ ok: false, reason: "not-same-channel" });
        return;
      }
      try {
        progressCb?.("Scrolling channel page to load all videos…");
      } catch {}
      chrome.tabs.sendMessage(
        tab.id,
        { type: "YT_SAVER_COLLECT_CHANNEL_VIDEOS", maxScrolls: 80, idleRounds: 3, waitMs: 900 },
        (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, error: "Empty response" });
        }
      );
    });
  });
}

function parseChannelRangeSelection(input, total) {
  const set = new Set();
  if (!input || typeof input !== "string") return set;
  const parts = input.split(",");
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const single = part.match(/^(\d+)$/);
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let start = Number(range[1]);
      let end = Number(range[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (start > end) [start, end] = [end, start];
      for (let i = start; i <= end; i++) {
        if (i >= 1 && i <= total) set.add(i);
      }
    } else if (single) {
      const idx = Number(single[1]);
      if (Number.isFinite(idx) && idx >= 1 && idx <= total) {
        set.add(idx);
      }
    }
  }
  return set;
}

function formatVideoEntry(raw, index = 0) {
  if (!raw) return null;
  const id = typeof raw === "string" ? raw : raw.id || raw.videoId;
  if (!id) return null;
  const rawTitle = raw.title || raw.recordedTitle || `Video ${index + 1}`;
  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: rawTitle,
    normalizedTitle: raw.normalizedTitle || normalizeTitleKey(rawTitle)
  };
}

function normalizeVideoList(input) {
  if (!Array.isArray(input)) return [];
  const result = [];
  input.forEach((item, idx) => {
    const entry = formatVideoEntry(item, idx);
    if (entry) {
      result.push(entry);
    }
  });
  return result;
}

function applyChannelSelection(entries) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  const total = list.length;
  if (!total) return [];
  const rangesStr = channelRangesInput?.value?.trim?.() || "";
  if (rangesStr) {
    const keepSet = parseChannelRangeSelection(rangesStr, total);
    if (!keepSet.size) return [];
    const result = [];
    for (let i = 1; i <= total; i++) {
      if (keepSet.has(i)) {
        result.push(list[i - 1]);
      }
    }
    return result;
  }
  const skipFirst = clampNumber(
    channelSkipFirstInput?.value ?? 0,
    0,
    total,
    0
  );
  const skipLast = clampNumber(
    channelSkipLastInput?.value ?? 0,
    0,
    total,
    0
  );
  const start = Math.min(skipFirst, total);
  const endCut = Math.min(skipLast, Math.max(0, total - start));
  if (start === 0 && endCut === 0) {
    return list;
  }
  return list.slice(start, total - endCut);
}

const channelExcludedVideoIds = new Set();
const channelVideoPickerList = document.getElementById("channel-video-picker-list");
const channelVideoPickerMeta = document.getElementById("channel-video-picker-meta");
const channelPickerSelectAllBtn = document.getElementById("channel-picker-select-all");
const channelPickerSelectNoneBtn = document.getElementById("channel-picker-select-none");

function pruneChannelExclusionsToFiltered(filteredVideos) {
  const allowed = new Set((filteredVideos || []).map((v) => v.id).filter(Boolean));
  for (const id of [...channelExcludedVideoIds]) {
    if (!allowed.has(id)) {
      channelExcludedVideoIds.delete(id);
    }
  }
}

function getFilteredChannelVideos() {
  return applyChannelSelection(cachedChannelVideos);
}

function getChannelVideosForQueue() {
  return getFilteredChannelVideos().filter((video) => !channelExcludedVideoIds.has(video.id));
}

function updateChannelVideoPickerMeta(filtered) {
  if (!channelVideoPickerMeta) return;
  const list = filtered || getFilteredChannelVideos();
  if (!list.length) {
    channelVideoPickerMeta.textContent = cachedChannelVideos.length
      ? "No videos match the current filters."
      : "";
    return;
  }
  const selectedCount = list.filter((v) => !channelExcludedVideoIds.has(v.id)).length;
  const inLibraryCount = list.filter((v) => isVideoAlreadyDownloaded(v)).length;
  let text = `${selectedCount} of ${list.length} selected for download`;
  if (inLibraryCount) {
    text += ` · ${inLibraryCount} in library`;
  }
  channelVideoPickerMeta.textContent = text;
}

function applyInLibraryDefaultExclusions() {
  const filtered = getFilteredChannelVideos();
  pruneChannelExclusionsToFiltered(filtered);
  for (const video of filtered) {
    if (video?.id && isVideoAlreadyDownloaded(video)) {
      channelExcludedVideoIds.add(video.id);
    }
  }
}

function renderChannelVideoPicker() {
  if (!channelVideoPickerList) return;
  const filtered = getFilteredChannelVideos();
  pruneChannelExclusionsToFiltered(filtered);
  channelVideoPickerList.innerHTML = "";

  if (!filtered.length) {
    updateChannelVideoPickerMeta(filtered);
    return;
  }

  updateChannelVideoPickerMeta(filtered);

  filtered.forEach((video, index) => {
    const id = video.id;
    if (!id) return;
    const included = !channelExcludedVideoIds.has(id);
    const title = video.title || `Video ${index + 1}`;
    const match = getLibraryMatchForVideo(video);
    const inLibrary = Boolean(match?.hasVideo);

    const row = document.createElement("label");
    row.className = `channel-video-picker-item${included ? "" : " is-excluded"}${
      inLibrary ? " is-in-library" : ""
    }`;
    row.setAttribute("role", "listitem");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "channel-video-picker-check";
    checkbox.checked = included;
    checkbox.setAttribute("aria-label", `Include ${title}`);

    const thumb = document.createElement("img");
    thumb.className = "channel-video-picker-thumb";
    thumb.alt = "";
    thumb.loading = "lazy";
    thumb.src = `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;

    const body = document.createElement("div");
    body.className = "channel-video-picker-body";

    const titleEl = document.createElement("div");
    titleEl.className = "channel-video-picker-title";
    titleEl.textContent = title;

    const metaLine = document.createElement("div");
    metaLine.className = "channel-video-picker-meta-line";
    metaLine.append(document.createTextNode(`#${index + 1}`));
    if (inLibrary) {
      const badge = document.createElement("span");
      badge.className = "channel-library-badge";
      badge.textContent = "In Library";
      metaLine.append(document.createTextNode(" "));
      metaLine.append(badge);
    }

    body.appendChild(titleEl);
    body.appendChild(metaLine);
    row.appendChild(checkbox);
    row.appendChild(thumb);
    row.appendChild(body);

    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        channelExcludedVideoIds.delete(id);
        row.classList.remove("is-excluded");
      } else {
        channelExcludedVideoIds.add(id);
        row.classList.add("is-excluded");
      }
      updateChannelVideoPickerMeta(filtered);
    });

    channelVideoPickerList.appendChild(row);
  });
}

function resetChannelVideoExclusions() {
  channelExcludedVideoIds.clear();
}

function setChannelPickerSelection(selectAll) {
  const filtered = getFilteredChannelVideos();
  pruneChannelExclusionsToFiltered(filtered);
  for (const video of filtered) {
    if (!video?.id) continue;
    if (selectAll) {
      channelExcludedVideoIds.delete(video.id);
    } else {
      channelExcludedVideoIds.add(video.id);
    }
  }
  renderChannelVideoPicker();
}

function bindChannelSelectionEditorInputs() {
  const rerender = () => renderChannelVideoPicker();
  channelSkipFirstInput?.addEventListener("input", rerender);
  channelSkipLastInput?.addEventListener("input", rerender);
  channelRangesInput?.addEventListener("input", rerender);
  channelPickerSelectAllBtn?.addEventListener("click", () => setChannelPickerSelection(true));
  channelPickerSelectNoneBtn?.addEventListener("click", () => setChannelPickerSelection(false));
}

// =====================
// UI bindings - Single Video
// =====================

const videoUrlInput = document.getElementById("video-url");
const useCurrentVideoBtn = document.getElementById("use-current-video");
const downloadVideoBtn = document.getElementById("download-video");

function startupDetectActiveTab() {
  getCurrentTabUrl((url) => {
    // Video detection
    if (url && isYouTubeWatchUrl(url)) {
      videoUrlInput.value = url;
      setSingleVideoStatusWithLibrary("Detected current tab as a YouTube video.", "success", null);
      scheduleSingleVideoLibraryCheck(url, "Detected current tab as a YouTube video.", "success");
    } else if (url) {
      singleVideoLibraryState = { url: "", videoId: "", match: null };
      updateSingleVideoDownloadButton(null);
      setStatusSingle("Active tab is not a YouTube video.", "error");
    } else {
      singleVideoLibraryState = { url: "", videoId: "", match: null };
      updateSingleVideoDownloadButton(null);
      setStatusSingle("No active tab URL found.", "error");
    }

    // Channel detection
    if (url && (isYouTubeChannelVideosUrl(url) || isYouTubeChannelCandidateUrl(url))) {
      channelUrlInput.value = url;
      const okText = isYouTubeChannelVideosUrl(url)
        ? "Detected a YouTube channel Videos page."
        : "Detected a YouTube channel page (will convert to /videos).";
      setStatusChannel(okText, "success");
    } else if (url) {
      setStatusChannel("Active tab is not a channel page.", "error");
    } else {
      setStatusChannel("No active tab URL found.", "error");
    }

    // Settings detection summary
    if (url && isYouTubeWatchUrl(url)) {
      setStatusSettings("Active tab: YouTube video detected.", "success");
    } else if (url && (isYouTubeChannelVideosUrl(url) || isYouTubeChannelCandidateUrl(url))) {
      setStatusSettings("Active tab: YouTube channel page detected.", "success");
    } else if (url) {
      setStatusSettings("Active tab is not a YouTube page.", "error");
    } else {
      setStatusSettings("No active tab URL found.", "error");
    }
  });
}
startupDetectActiveTab();
void ensureLibraryIndexed();
refreshYoutubeCatalogPathHint();
startBridgeBackendMonitor();

// Re-run detection whenever the active normal tab changes or windows focus changes.
let detectTimer = null;
function scheduleDetectActiveTab() {
  if (detectTimer) clearTimeout(detectTimer);
  detectTimer = setTimeout(() => {
    detectTimer = null;
    startupDetectActiveTab();
  }, 250);
}
try {
  chrome.tabs.onActivated.addListener(() => scheduleDetectActiveTab());
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "complete" || typeof changeInfo.url === "string") {
      scheduleDetectActiveTab();
    }
  });
  chrome.windows.onFocusChanged.addListener(() => scheduleDetectActiveTab());
} catch {}

useCurrentVideoBtn.addEventListener("click", () => {
  getCurrentTabUrl((url) => {
    if (!url) {
      setStatusSingle("No active tab URL found.", "error");
      return;
    }
    if (!isYouTubeWatchUrl(url)) {
      setStatusSingle("Active tab is not a YouTube video.", "error");
      return;
    }
    videoUrlInput.value = url;
    setSingleVideoStatusWithLibrary("Using active tab as video URL.", "success", null);
    scheduleSingleVideoLibraryCheck(url, "Using active tab as video URL.", "success");
  });
});

downloadVideoBtn.addEventListener("click", async () => {
  const url = videoUrlInput.value.trim();
  if (!url) {
    setStatusSingle("Please enter a YouTube video URL.", "error");
    return;
  }

  if (!(await requireStreamsteinBackend())) return;

  setStatusSingle("Fetching video metadata…", "info");
  setButtonLoading(downloadVideoBtn, true, "Preparing…");

  let metadata;
  try {
    metadata = await loadPlayerResponse(url);
  } catch (err) {
    setStatusSingle(err.message || "Failed to load video metadata.", "error");
    setButtonLoading(downloadVideoBtn, false);
    return;
  }

  const { watchUrl, videoTitle, videoId } = metadata;
  const normalizedTitle = normalizeTitleKey(videoTitle);

  const libraryMatch =
    (await refreshLibraryMatchForMetadata(videoId, videoTitle, "")) ||
    (await resolveSingleVideoLibraryMatch(url, { force: true, fetchTitleIfNeeded: true }));
  const hasVideo = Boolean(libraryMatch?.hasVideo);
  const hasTranscript = Boolean(libraryMatch?.hasTranscript);
  const transcriptsEnabled = Boolean(appSettings.downloadTranscripts);
  const wantVideo = !hasVideo;
  const wantTranscript = transcriptsEnabled && !hasTranscript;

  if (!wantVideo && !wantTranscript) {
    setStatusSingleMessages([
      {
        message: `Already in your library:\n<strong>${videoTitle}</strong>`,
        type: "warning"
      },
      {
        message:
          "This video and its transcript are already saved locally. Download was not started.",
        type: "warning"
      }
    ]);
    updateSingleVideoDownloadButton(libraryMatch);
    setButtonLoading(downloadVideoBtn, false);
    return;
  }

  // Immediately reflect that we've handed the job to the local bridge / yt-dlp backend.
  try {
    const baseName = sanitizeFileName(videoTitle) + ".mp4";
    const channelName = getChannelNameFromPlayerResponse(metadata.playerResponse);
    const configuredVideoPath = getDownloadPathForFile(baseName);
    const defaultVideoPath = getDefaultChannelPathForFile(baseName, channelName);
    let chosenPath = configuredVideoPath;
    // For default save mode, always use per-channel folders automatically.
    if (appSettings.saveMode === "default") {
      chosenPath = defaultVideoPath;
    } else if (
      wantVideo &&
      appSettings.saveMode === "subfolder" &&
      channelName &&
      getLastFolderName(configuredVideoPath) !== getLastFolderName(defaultVideoPath)
    ) {
      const choice = await confirmSaveDestination({
        videoTitle,
        channelName,
        configuredPath: configuredVideoPath,
        defaultPath: defaultVideoPath
      });
      chosenPath = choice === "default" ? defaultVideoPath : configuredVideoPath;
    } else if (!wantVideo && hasVideo) {
      chosenPath =
        appSettings.saveMode === "default" ? defaultVideoPath : configuredVideoPath;
    }
    showProgressBar();
    const startedLines = [
      {
        message: wantVideo
          ? `Started download for:\n<strong>${videoTitle}</strong>`
          : `Fetching transcript for:\n<strong>${videoTitle}</strong>`,
        type: "success"
      },
      {
        message:
          "You can close this popup and downloads will continue.\nCheck your browser downloads folder.",
        type: "info"
      }
    ];
    if (hasVideo && wantTranscript) {
      startedLines.splice(1, 0, {
        message: "Video already in your library — only downloading the missing transcript.",
        type: "warning"
      });
    }
    setStatusSingleMessages(startedLines);

    if (wantVideo) {
      // Fire-and-forget to the background/bridge; we don't block the UI on the response.
      attemptBridgeDownload(watchUrl, videoTitle, {
        saveAs: appSettings.saveMode === "ask",
        downloadPath: chosenPath,
        params: {
          quality: appSettings.maxQuality || "best"
        },
        meta: buildYoutubeMediaMeta({
          videoId,
          watchUrl,
          videoTitle,
          playerResponse: metadata.playerResponse,
          assetType: "video",
          source: "single",
          quality: appSettings.maxQuality || "best",
          channelName
        })
      }).then((bridgeResp) => {
        console.log("[YouTube Downloader] Bridge response (single):", bridgeResp);
      }).catch((e) => {
        console.error("Bridge download error (single):", e);
      });
    }

    if (wantTranscript) {
      const transcriptName = sanitizeFileName(videoTitle) + ".vtt";
      const configuredTranscriptPath = getDownloadPathForFile(transcriptName);
      const defaultTranscriptPath = getDefaultChannelPathForFile(transcriptName, channelName);
      const chosenTranscriptPath =
        appSettings.saveMode === "default"
          ? defaultTranscriptPath
          : chosenPath === configuredVideoPath
            ? configuredTranscriptPath
            : defaultTranscriptPath;
      attemptBridgeDownload(watchUrl, videoTitle, {
        saveAs: false,
        downloadPath: chosenTranscriptPath,
        endpoint: "transcript",
        params: {},
        meta: buildYoutubeMediaMeta({
          videoId,
          watchUrl,
          videoTitle,
          playerResponse: metadata.playerResponse,
          assetType: "transcript",
          source: "single",
          channelName
        })
      }).then((bridgeResp) => {
        console.log("[YouTube Downloader] Bridge response (single transcript):", bridgeResp);
      }).catch((e) => {
        console.error("Bridge transcript download error (single):", e);
      });
    }
  } finally {
    setButtonLoading(downloadVideoBtn, false);
    updateSingleVideoDownloadButton(singleVideoLibraryState.match);
  }
});

// Live validate Single Video URL input
videoUrlInput.addEventListener("input", () => {
  const url = videoUrlInput.value.trim();
  if (!url) {
    singleVideoLibraryState = { url: "", videoId: "", match: null };
    if (singleLibraryCheckTimer) clearTimeout(singleLibraryCheckTimer);
    updateSingleVideoDownloadButton(null);
    setStatusSingle("", "info");
    return;
  }
  if (isYouTubeWatchUrl(url)) {
    setSingleVideoStatusWithLibrary("Ready to download this video URL.", "success", null);
    scheduleSingleVideoLibraryCheck(url, "Ready to download this video URL.", "success");
  } else {
    singleVideoLibraryState = { url: "", videoId: "", match: null };
    if (singleLibraryCheckTimer) clearTimeout(singleLibraryCheckTimer);
    updateSingleVideoDownloadButton(null);
    setStatusSingle("This does not look like a valid YouTube video URL.", "error");
  }
});

// =====================
// UI bindings - Channel Download
// =====================

const channelUrlInput = document.getElementById("channel-url");
const channelLimitInput = document.getElementById("channel-limit");
const useCurrentChannelBtn = document.getElementById("use-current-channel");
const downloadChannelBtn = document.getElementById("download-channel");
const channelSelectionEditor = document.getElementById("channel-selection-editor");
const channelSkipFirstInput = document.getElementById("channel-skip-first");
const channelSkipLastInput = document.getElementById("channel-skip-last");
const channelRangesInput = document.getElementById("channel-ranges");
const channelOnlyMissingCheckbox = document.getElementById("channel-only-missing");
const channelMissingTranscriptsCheckbox = document.getElementById("channel-missing-transcripts");
const channelRefreshLibraryBtn = document.getElementById("channel-refresh-library");
const channelLibrarySummaryEl = document.getElementById("channel-library-summary");
setLibraryControlsEnabled(false);
bindChannelSelectionEditorInputs();

useCurrentChannelBtn.addEventListener("click", () => {
  getCurrentTabUrl((url) => {
    if (!url) {
      setStatusChannel("No active tab URL found.", "error");
      return;
    }
    if (!(isYouTubeChannelVideosUrl(url) || isYouTubeChannelCandidateUrl(url))) {
      setStatusChannel("Active tab is not a channel page.", "error");
      return;
    }
    channelUrlInput.value = url;
    const okText = isYouTubeChannelVideosUrl(url)
      ? "Using active tab as channel Videos URL."
      : "Using active tab as channel URL candidate.";
    setStatusChannel(okText, "success");
  });
});

channelOnlyMissingCheckbox?.addEventListener("change", () => {
  if (channelOnlyMissingCheckbox.checked) {
    setStatusChannel("Auto-selecting only videos not found locally.", "info");
  }
});

channelMissingTranscriptsCheckbox?.addEventListener("change", () => {
  if (channelMissingTranscriptsCheckbox.checked) {
    setStatusChannel("Will queue transcripts missing from your library.", "info");
  }
});

channelRefreshLibraryBtn?.addEventListener("click", async () => {
  setStatusChannel("Refreshing local library…", "info");
  const refreshed = await refreshGlobalLibrarySummary({ forceRescan: true });
  if (cachedChannelVideos.length) {
    await fetchChannelLibraryMatches(cachedChannelVideos);
  }
  setStatusChannel(
    refreshed ? "Library refreshed." : "Unable to reach local library service.",
    refreshed ? "success" : "error"
  );
});

downloadChannelBtn.addEventListener("click", async () => {
  const rawUrl = channelUrlInput.value.trim();
  if (!rawUrl) {
    setStatusChannel("Please enter a YouTube channel URL.", "error");
    return;
  }

  const limit = parseInt(channelLimitInput.value, 10) || 1;
  if (limit < 1) {
    setStatusChannel("Max videos must be at least 1.", "error");
    return;
  }

  let channelUrl;
  try {
    channelUrl = normalizeChannelUrl(rawUrl);
  } catch (err) {
    setStatusChannel(err.message || "Invalid channel URL.", "error");
    return;
  }

  if (!(await requireStreamsteinBackend())) return;

  setStatusChannel("Fetching channel videos list…", "info");
  setButtonLoading(downloadChannelBtn, true, "Starting…");

  try {
    let videos = [];
    if (
      liveChannelCollect.done &&
      Array.isArray(liveChannelCollect.videos) &&
      liveChannelCollect.videos.length &&
      sameChannelRoot(liveChannelCollect.url, channelUrl)
    ) {
      videos = normalizeVideoList(liveChannelCollect.videos);
      setStatusChannel(`Found ${videos.length} videos on this channel.`, "success");
    }

    if (!videos.length) {
      const collectResp = await collectChannelIdsFromActiveTabIfSame(channelUrl, (t) => {
        setStatusChannel(t, "info");
      });
      if (collectResp?.ok) {
        const respVideos = normalizeVideoList(collectResp.videos || collectResp.ids);
        if (respVideos.length) {
          videos = respVideos;
          setStatusChannel(`Found ${videos.length} videos on this channel.`, "success");
        }
      }
    }

    if (!videos.length) {
      const html = await fetchHtml(channelUrl);
      videos = normalizeVideoList(extractVideoIdsFromChannelHtml(html));
    }

    if (!videos.length) {
      setStatusChannel(
        "No videos found on this channel page. Make sure you're using the /videos URL.",
        "error"
      );
      return;
    }

    cachedChannelVideos = videos;
    resetChannelVideoExclusions();
    await fetchChannelLibraryMatches(videos);

    toggleChannelSelectionEditor(false);

    let workingList = getChannelVideosForQueue();
    if (!applyChannelSelection(videos).length) {
      setStatusChannel(
        "Your selection filters excluded all videos. Adjust Skip/Range settings and try again.",
        "error"
      );
      return;
    }
    if (!workingList.length) {
      setStatusChannel(
        "No videos selected. Open Edit selection and check at least one episode.",
        "error"
      );
      return;
    }

    const transcriptsOnlyModeGlobal = Boolean(
      channelMissingTranscriptsCheckbox?.checked
    );

    // "Auto-select only videos not downloaded yet" should apply only to the
    // normal download mode. In transcript catch-up mode we explicitly want to
    // work with videos that ALREADY exist locally, so we must not filter them
    // out here.
    if (channelOnlyMissingCheckbox?.checked && !transcriptsOnlyModeGlobal) {
      const filtered = workingList.filter((video) => !isVideoAlreadyDownloaded(video));
      if (!filtered.length) {
        setStatusChannel(
          "All selected videos already exist in your library. Adjust filters or disable the missing-only option.",
          "error"
        );
        return;
      }
      workingList = filtered;
    }

    const toDownload = workingList.slice(0, limit);
    if (!toDownload.length) {
      setStatusChannel("Nothing to queue after applying filters.", "error");
      return;
    }

    let message = `Found ${videos.length} videos; preparing ${toDownload.length} downloads.\n\n`;
    setChannelStatusWithLog("Preparing channel downloads…", "info", message);

    const plannedVideoIds = new Set();
    let queuedCount = 0;
    let batchStarted = false;
    let pathChoiceForBatch = appSettings.saveMode === "default" ? "default" : null;

    for (let i = 0; i < toDownload.length; i++) {
      const video = toDownload[i];
      const watchUrl = `https://www.youtube.com/watch?v=${video.id}`;
      try {
        message += `(${i + 1}/${toDownload.length}) Preparing https://youtu.be/${video.id}\n`;
        setChannelStatusWithLog("Preparing channel downloads…", "info", message);

        const metadata = await loadPlayerResponse(watchUrl);
        const titleLabel = metadata.videoTitle;
        const normalizedTitle = normalizeTitleKey(titleLabel);

        let match =
          (await refreshLibraryMatchForMetadata(metadata.videoId, titleLabel)) ||
          getLibraryMatchForVideo({
            id: metadata.videoId,
            title: titleLabel,
            normalizedTitle
          });
        const hasVideo = Boolean(match?.hasVideo);
        const hasTranscript = Boolean(match?.hasTranscript);

        const transcriptsOnlyMode = Boolean(
          channelMissingTranscriptsCheckbox?.checked
        );
        const transcriptsEnabled =
          appSettings.downloadTranscripts || transcriptsOnlyMode;

        let wantVideo;
        let wantTranscript;

        if (transcriptsOnlyMode) {
          // In transcript catch-up mode, NEVER download videos.
          // Only queue transcripts where we already have the video file
          // but do not yet have a transcript recorded.
          wantVideo = false;
          wantTranscript = transcriptsEnabled && hasVideo && !hasTranscript;
        } else {
          // Normal behavior: download videos we don't have yet,
          // and transcripts for any items missing them.
          wantVideo = !hasVideo;
          wantTranscript = transcriptsEnabled && !hasTranscript;
        }

        // If neither video nor transcript is needed, skip this entry.
        if (!wantVideo && !wantTranscript) {
          if (transcriptsOnlyMode && !hasVideo) {
            message += `   Skipping (video not found locally; cannot queue transcript catch-up).\n`;
            if (match?.debug) {
              message += `   [Debug]: ${match.debug}\n`;
            }
          } else {
            message += "   Skipping (already have video and transcript locally).\n";
          }
          setChannelStatusWithLog("Preparing channel downloads…", "info", message);
          continue;
        }

        plannedVideoIds.add(metadata.videoId);

        message += `   Title: ${titleLabel}\n`;
        setChannelStatusWithLog("Preparing channel downloads…", "info", message);

        const jobs = [];

        if (wantVideo) {
          const baseName = sanitizeFileName(titleLabel) + ".mp4";
          const channelName = getChannelNameFromPlayerResponse(metadata.playerResponse);
          const configuredPath = getDownloadPathForFile(baseName);
          const defaultPath = getDefaultChannelPathForFile(baseName, channelName);
          if (
            pathChoiceForBatch == null &&
            appSettings.saveMode === "subfolder" &&
            channelName &&
            getLastFolderName(configuredPath) !== getLastFolderName(defaultPath)
          ) {
            // eslint-disable-next-line no-await-in-loop
            pathChoiceForBatch = await confirmSaveDestination({
              videoTitle: titleLabel,
              channelName,
              configuredPath,
              defaultPath
            });
          }
          const finalPath = pathChoiceForBatch === "default" ? defaultPath : configuredPath;
          jobs.push({
            url: watchUrl,
            filenameHint: finalPath,
            saveAs: false,
            params: {
              quality: appSettings.maxQuality || "best"
            },
            meta: buildYoutubeMediaMeta({
              videoId: metadata.videoId,
              watchUrl,
              videoTitle: titleLabel,
              playerResponse: metadata.playerResponse,
              assetType: "video",
              source: "channel",
              quality: appSettings.maxQuality || "best",
              channelName
            })
          });
        }

        if (wantTranscript) {
          const transcriptName = sanitizeFileName(titleLabel) + ".vtt";
          const channelName = getChannelNameFromPlayerResponse(metadata.playerResponse);
          const configuredTPath = getDownloadPathForFile(transcriptName);
          const defaultTPath = getDefaultChannelPathForFile(transcriptName, channelName);
          const transcriptPath =
            (pathChoiceForBatch || (appSettings.saveMode === "default" ? "default" : "configured")) === "default"
              ? defaultTPath
              : configuredTPath;
          jobs.push({
            url: watchUrl,
            filenameHint: transcriptPath,
            saveAs: false,
            params: {},
            endpoint: "transcript",
            noDelayAfter: true,
            meta: buildYoutubeMediaMeta({
              videoId: metadata.videoId,
              watchUrl,
              videoTitle: titleLabel,
              playerResponse: metadata.playerResponse,
              assetType: "transcript",
              source: transcriptsOnlyMode ? "transcript-catchup" : "channel",
              channelName
            })
          });
        }

        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            {
              type: "YT_SAVER_CHANNEL_BATCH",
              jobs,
              delaySeconds: appSettings.delaySeconds || 0
            },
            (resp) => {
              if (chrome.runtime.lastError) {
                message += `   ✗ Background queue error for ${video.id}: ${chrome.runtime.lastError.message}\n`;
                setChannelStatusWithLog("Preparing channel downloads…", "error", message);
                resolve();
                return;
              }
              if (resp && resp.ok) {
                queuedCount += jobs.length;
                if (!batchStarted) {
                  batchStarted = true;
                  channelBatchActive = true;
                  showProgressBar();
                }
              } else {
                message += `   ✗ Failed to queue ${video.id}: ${
                  resp?.error || "Unknown queue error"
                }\n`;
                setChannelStatusWithLog("Preparing channel downloads…", "error", message);
              }
              resolve();
            }
          );
        });
      } catch (err) {
        message += `   ✗ Failed to prepare ${video.id}: ${err.message}\n\n`;
        setChannelStatusWithLog("Preparing channel downloads…", "error", message);
      }
    }

    if (channelMissingTranscriptsCheckbox?.checked) {
      const catchupTargets = buildTranscriptCatchupTargets(plannedVideoIds);
      if (catchupTargets.length) {
        message += `\nAdding ${catchupTargets.length} transcript-only jobs for existing downloads…\n`;
        setChannelStatusWithLog("Preparing channel downloads…", "info", message);
        for (const match of catchupTargets) {
          const videoMeta = findVideoForMatch(match);
          if (!videoMeta) continue;
          const titleLabel = videoMeta.title || match.recordedTitle || `YouTube video ${match.videoId}`;
          const normalizedTitle =
            videoMeta.normalizedTitle || match.normalizedTitle || normalizeTitleKey(titleLabel);
          const transcriptName = sanitizeFileName(titleLabel) + ".vtt";
          const transcriptPath = getDownloadPathForFile(transcriptName);
          const watchUrl = `https://www.youtube.com/watch?v=${match.videoId}`;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              {
                type: "YT_SAVER_CHANNEL_BATCH",
                jobs: [
                  {
                    url: watchUrl,
                    filenameHint: transcriptPath,
                    saveAs: false,
                    params: {},
                    endpoint: "transcript",
                    noDelayAfter: true,
                    meta: buildYoutubeMediaMeta({
                      videoId: match.videoId,
                      watchUrl,
                      videoTitle: titleLabel,
                      assetType: "transcript",
                      source: "transcript-catchup"
                    })
                  }
                ],
                delaySeconds: 0
              },
              () => resolve()
            );
          });
        }
      }
    }

    if (queuedCount > 0) {
      setChannelStatusWithLog(
        `Queued ${queuedCount} job${queuedCount === 1 ? "" : "s"} for background download.\nYou can close this popup — downloads will continue.`,
        "success",
        message
      );
    } else {
      setChannelStatusWithLog("No jobs were queued. See details above.", "error", message);
    }
  } catch (err) {
    console.error(err);
    setStatusChannel(err.message || "Failed to fetch channel page.", "error");
  } finally {
    setButtonLoading(downloadChannelBtn, false);
  }
});

// Live validate Channel URL input
channelUrlInput.addEventListener("input", () => {
  const url = channelUrlInput.value.trim();
  if (!url) {
    setStatusChannel("", "info");
    return;
  }
  if (isYouTubeChannelVideosUrl(url) || isYouTubeChannelCandidateUrl(url)) {
    const okText = isYouTubeChannelVideosUrl(url)
      ? "Channel Videos URL detected."
      : "Channel URL detected (will use /videos).";
    setStatusChannel(okText, "success");
  } else {
    setStatusChannel("This does not look like a channel URL.", "error");
  }
});

// =====================
// UI bindings - Settings
// =====================

const settingsSaveMode = document.getElementById("settings-save-mode");
const settingsSubfolderRow = document.getElementById("settings-subfolder-row");
const settingsSubfolder = document.getElementById("settings-subfolder");
const settingsDelay = document.getElementById("settings-delay");
const settingsFfmpegPath = document.getElementById("settings-ffmpeg-path");
const settingsWhisperCommand = document.getElementById("settings-whisper-command");
const settingsMaxQuality = document.getElementById("settings-max-quality");
const settingsSaveBtn = document.getElementById("settings-save");
const settingsResetBtn = document.getElementById("settings-reset");
const settingsDownloadTranscripts = document.getElementById("settings-download-transcripts");
const settingsYtDlpCookiesBrowser = document.getElementById("settings-ytdlp-cookies-browser");
const settingsYtDlpCookiesFile = document.getElementById("settings-ytdlp-cookies-file");
const settingsYtDlpWarmupEnabled = document.getElementById("settings-ytdlp-warmup-enabled");
const settingsYtDlpWarmupDelayMs = document.getElementById("settings-ytdlp-warmup-delay-ms");
const settingsYtDlpWarmupCooldownMs = document.getElementById("settings-ytdlp-warmup-cooldown-ms");
const settingsYtDlpWarmupCloseTab = document.getElementById("settings-ytdlp-warmup-close-tab");

function applySettingsToUI() {
  settingsSaveMode.value = appSettings.saveMode;
  settingsSubfolder.value = appSettings.subfolder || "";
  settingsDelay.value = String(appSettings.delaySeconds ?? DEFAULT_SETTINGS.delaySeconds);
  settingsSubfolderRow.style.display = appSettings.saveMode === "subfolder" ? "" : "none";
  if (settingsFfmpegPath) settingsFfmpegPath.value = appSettings.ffmpegPath || "";
  if (settingsMaxQuality) settingsMaxQuality.value = appSettings.maxQuality || DEFAULT_SETTINGS.maxQuality;
  if (settingsWhisperCommand) settingsWhisperCommand.value = appSettings.whisperCommand || "";
  if (settingsDownloadTranscripts) {
    settingsDownloadTranscripts.checked = Boolean(appSettings.downloadTranscripts);
  }
  if (settingsYtDlpCookiesBrowser) {
    settingsYtDlpCookiesBrowser.value = appSettings.ytDlpCookiesFromBrowser || "";
  }
  if (settingsYtDlpCookiesFile) {
    settingsYtDlpCookiesFile.value = appSettings.ytDlpCookiesFile || "";
  }
  if (settingsYtDlpWarmupEnabled) {
    settingsYtDlpWarmupEnabled.checked = Boolean(appSettings.ytDlpWarmupEnabled);
  }
  if (settingsYtDlpWarmupDelayMs) {
    settingsYtDlpWarmupDelayMs.value = String(appSettings.ytDlpWarmupDelayMs ?? DEFAULT_SETTINGS.ytDlpWarmupDelayMs);
  }
  if (settingsYtDlpWarmupCooldownMs) {
    settingsYtDlpWarmupCooldownMs.value = String(
      appSettings.ytDlpWarmupCooldownMs ?? DEFAULT_SETTINGS.ytDlpWarmupCooldownMs
    );
  }
  if (settingsYtDlpWarmupCloseTab) {
    settingsYtDlpWarmupCloseTab.checked = appSettings.ytDlpWarmupCloseTab !== false;
  }
}

function readSettingsFromUI() {
  return {
    saveMode: settingsSaveMode.value,
    subfolder: settingsSubfolder.value,
    delaySeconds: Number(settingsDelay.value),
    ffmpegPath: settingsFfmpegPath?.value || "",
    maxQuality: settingsMaxQuality?.value || DEFAULT_SETTINGS.maxQuality,
    downloadTranscripts: settingsDownloadTranscripts?.checked || false,
    ytDlpCookiesFromBrowser: settingsYtDlpCookiesBrowser?.value || "",
    ytDlpCookiesFile: settingsYtDlpCookiesFile?.value || "",
    ytDlpWarmupEnabled: settingsYtDlpWarmupEnabled?.checked || false,
    ytDlpWarmupDelayMs: Number(settingsYtDlpWarmupDelayMs?.value || DEFAULT_SETTINGS.ytDlpWarmupDelayMs),
    ytDlpWarmupCooldownMs: Number(
      settingsYtDlpWarmupCooldownMs?.value || DEFAULT_SETTINGS.ytDlpWarmupCooldownMs
    ),
    ytDlpWarmupCloseTab: settingsYtDlpWarmupCloseTab?.checked !== false,
    whisperCommand: settingsWhisperCommand?.value || ""
  };
}

settingsSaveMode.addEventListener("change", () => {
  const mode = settingsSaveMode.value;
  settingsSubfolderRow.style.display = mode === "subfolder" ? "" : "none";
});

settingsSaveBtn.addEventListener("click", () => {
  const next = readSettingsFromUI();
  saveSettings(next, () => {
    applyServerConfig().then((msg) => {
      setStatusSettings(msg || "Settings saved.", "success");
    }).catch((e) => {
      setStatusSettings("Saved locally, but server config failed.", "error");
    });
  });
});

settingsResetBtn.addEventListener("click", () => {
  saveSettings({ ...DEFAULT_SETTINGS }, () => {
    applySettingsToUI();
    applyServerConfig().finally(() => {
      setStatusSettings("Settings reset to defaults.", "success");
    });
  });
});

// Initialize settings on load
async function fetchBridgeConfig() {
  try {
    const res = await fetchBridge("/api/config", { method: "GET" });
    if (!res?.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function resolveCookiesSettingsForBridge(bridgeConfig) {
  const effective =
    (bridgeConfig?.effectiveYtDlpCookiesFile || "").trim() ||
    (bridgeConfig?.ytDlpCookiesFile || "").trim();
  const userFile = (appSettings.ytDlpCookiesFile || "").trim();
  const userBrowser = (appSettings.ytDlpCookiesFromBrowser || "").trim();

  // Bridge always prefers YoutubeDownloaderExtension/youtube-cookies.txt when present.
  if (effective) {
    return { file: effective, fromBrowser: "" };
  }
  if (userFile) {
    return { file: userFile, fromBrowser: userBrowser };
  }
  return { file: "", fromBrowser: userBrowser };
}

async function mergeBridgeToolSettings() {
  const bridgeConfig = await fetchBridgeConfig();
  if (!bridgeConfig?.ok) return null;

  let changed = false;
  if (!appSettings.ffmpegPath && bridgeConfig.ffmpegPath) {
    appSettings.ffmpegPath = bridgeConfig.ffmpegPath;
    changed = true;
  }
  if (!appSettings.whisperCommand && bridgeConfig.whisperCommand) {
    appSettings.whisperCommand = bridgeConfig.whisperCommand;
    changed = true;
  }

  const effectiveCookies =
    (bridgeConfig.effectiveYtDlpCookiesFile || "").trim() ||
    (bridgeConfig.ytDlpCookiesFile || "").trim();
  if (effectiveCookies && !appSettings.ytDlpCookiesFile) {
    appSettings.ytDlpCookiesFile = effectiveCookies;
    changed = true;
  }
  if (effectiveCookies && appSettings.ytDlpCookiesFromBrowser) {
    appSettings.ytDlpCookiesFromBrowser = "";
    changed = true;
  }

  if (changed) {
    saveSettings(appSettings);
  }
  return bridgeConfig;
}

loadSettings(() => {
  mergeBridgeToolSettings().then((bridgeConfig) => {
    applySettingsToUI();
    applyServerConfig(bridgeConfig).then((msg) => {
      if (msg) console.log("[YouTube Downloader] Bridge config:", msg);
    });
  });
});

// =====================
// Chat Tab - LLM episode generation
// =====================

const chatBackendDot = document.getElementById("chat-backend-dot");
const chatBackendSummaryText = document.getElementById("chat-backend-summary-text");
const chatBackendRefreshBtn = document.getElementById("chat-backend-refresh");
const chatRefreshCreatorsBtn = document.getElementById("chat-refresh-creators");
const chatCreatorSelect = document.getElementById("chat-creator-select");
const chatEpisodeTitleInput = document.getElementById("chat-episode-title");
const chatMinutesInput = document.getElementById("chat-minutes");
const chatTopicsInput = document.getElementById("chat-topics");
const chatAutoNewsCheckbox = document.getElementById("chat-autonews");
const chatNewsDaysInput = document.getElementById("chat-news-days");
const chatModelSelect = document.getElementById("chat-model");
const chatModelPickerRoot = document.getElementById("chat-model-picker");
let chatModelPickerApi = null;
if (chatModelSelect && chatModelPickerRoot) {
  chatModelPickerApi = initChatModelPicker({
    hiddenInput: chatModelSelect,
    root: chatModelPickerRoot
  });
}
const chatOpenAiKeyInput = document.getElementById("chat-openai-key");
const chatSaveKeyBtn = document.getElementById("chat-save-key");
const chatGenerateBtn = document.getElementById("chat-generate");
const chatStatusBox = document.getElementById("chat-status");

let chatBackendInfo = null;
let chatProgressTimer = null;
let chatActiveJobId = null;
let chatJobActive = false;

function setStatusChat(message, type = "info") {
  if (!chatStatusBox) return;
  chatStatusBox.innerHTML = renderStatus(message, type);
}

function updateChatBackendUI(info) {
  chatBackendInfo = info || null;
  if (!chatBackendSummaryText || !chatBackendDot) return;
  chatBackendDot.className = "status-dot status-dot-unknown";
  if (!info) {
    chatBackendSummaryText.textContent = "not checked yet.";
    return;
  }
  const configured = Boolean(info.openaiConfigured);
  if (configured) {
    chatBackendDot.className = "status-dot status-dot-ok";
    chatBackendSummaryText.innerHTML = `OpenAI configured.<br>Default model: <strong>${info.openaiModelDefault || "gpt-4.1"}</strong>`;
  } else {
    chatBackendDot.className = "status-dot status-dot-warn";
    chatBackendSummaryText.textContent = "OpenAI key not configured.";
  }
}

async function refreshChatBackendStatus() {
  if (!chatBackendRefreshBtn) return;
  setButtonLoading(chatBackendRefreshBtn, true, "…");
  try {
    const res = await fetchBridge("/api/chat/status", { method: "GET" });
    if (!res) {
      updateChatBackendUI({ openaiConfigured: false });
      setStatusChat("Bridge not reachable for chat status.", "error");
      return;
    }
    const data = await res.json();
    if (!data?.ok) {
      updateChatBackendUI({ openaiConfigured: false });
      setStatusChat(data?.error || "Chat backend status failed.", "error");
      return;
    }
    updateChatBackendUI({
      openaiConfigured: data.openaiConfigured,
      openaiModelDefault: data.openaiModelDefault
    });
    const defaultModel = data.openaiModelDefault || DEFAULT_CHAT_MODEL_ID;
    if (defaultModel) {
      if (CHAT_MODEL_BY_ID.has(defaultModel)) {
        chatModelPickerApi?.setValue(defaultModel, { silent: true });
      } else if (chatModelSelect) {
        chatModelSelect.value = defaultModel;
        chatModelPickerApi?.setValue(DEFAULT_CHAT_MODEL_ID, { silent: true });
      }
    }
  } catch (err) {
    updateChatBackendUI({ openaiConfigured: false });
    setStatusChat(err?.message || "Chat backend status failed.", "error");
  } finally {
    setButtonLoading(chatBackendRefreshBtn, false);
  }
}

async function fetchCreatorsList() {
  try {
    const res = await fetchBridge("/api/chat/creators", { method: "GET" });
    if (!res) return [];
    const data = await res.json();
    const creators = Array.isArray(data?.creators) ? data.creators : [];
    return creators;
  } catch {
    return [];
  }
}

function populateCreators(creators) {
  if (!chatCreatorSelect) return;
  chatCreatorSelect.innerHTML = "";
  if (!creators.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No creators found in library";
    chatCreatorSelect.appendChild(opt);
    return;
  }
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select creator…";
  chatCreatorSelect.appendChild(placeholder);
  creators.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.key;
    opt.textContent = `${c.label || c.key} (${c.count || 0} transcripts)`;
    chatCreatorSelect.appendChild(opt);
  });
}

async function initializeChatTab() {
  setStatusChat("Loading chat backend status and creators…", "info");
  await refreshChatBackendStatus();
  const creators = await fetchCreatorsList();
  populateCreators(creators);
  if (creators.length) {
    setStatusChat("Ready.", "success");
  } else {
    setStatusChat("No creators with transcripts found. Generate transcripts first in Extra tab.", "error");
  }
}

chatBackendRefreshBtn?.addEventListener("click", () => {
  refreshChatBackendStatus();
});

chatRefreshCreatorsBtn?.addEventListener("click", async () => {
  setStatusChat("Refreshing creators…", "info");
  const creators = await fetchCreatorsList();
  populateCreators(creators);
  setStatusChat(creators.length ? "Creators refreshed." : "No creators found.", creators.length ? "success" : "error");
});

chatSaveKeyBtn?.addEventListener("click", async () => {
  const key = (chatOpenAiKeyInput?.value || "").trim();
  setStatusChat("Saving OpenAI key…", "info");
  try {
    const res = await fetchBridge("/api/chat/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openaiKey: key, openaiModelDefault: chatModelSelect?.value || undefined })
    });
    if (!res) {
      setStatusChat("Bridge not reachable.", "error");
      return;
    }
    const data = await res.json();
    if (data?.ok) {
      updateChatBackendUI({
        openaiConfigured: data.openaiConfigured,
        openaiModelDefault: data.openaiModelDefault
      });
      setStatusChat("OpenAI key saved.", "success");
    } else {
      setStatusChat(data?.error || "Failed to save key.", "error");
    }
  } catch (err) {
    setStatusChat(err?.message || "Failed to save key.", "error");
  }
});

async function pollChatProgressOnce() {
  try {
    if (!chatActiveJobId) return;
    const res = await fetchBridge(`/api/chat/progress?jobId=${encodeURIComponent(chatActiveJobId)}`, { method: "GET" });
    if (!res) return;
    const data = await res.json();
    if (!data?.ok) return;
    const job = data.job || {};
    let msg = job.message || "";
    if (job.current && job.total) {
      msg = `${msg} (${job.current}/${job.total})`;
    }
    setStatusChat(msg, job.phase === "error" ? "error" : "info");
    if (job.phase === "done" || job.phase === "error" || !job.active) {
      if (job.phase === "done" && job.targetPath) {
        setStatusChat(`Done. Transcript saved: ${job.targetPath}`, "success");
      }
      stopChatProgressPolling();
      chatJobActive = false;
      if (!channelBatchActive && !extraJobActive) {
        hideProgressBar();
      }
    }
  } catch {
    // ignore
  }
}

function startChatProgressPolling() {
  if (chatProgressTimer) return;
  chatProgressTimer = setInterval(pollChatProgressOnce, 1200);
}

function stopChatProgressPolling() {
  if (!chatProgressTimer) return;
  clearInterval(chatProgressTimer);
  chatProgressTimer = null;
}

chatGenerateBtn?.addEventListener("click", async () => {
  const creatorKey = chatCreatorSelect?.value || "";
  if (!creatorKey) {
    setStatusChat("Select a creator.", "error");
    return;
  }
  const minutes = Math.max(5, Math.min(180, Number(chatMinutesInput?.value || 60) || 60));
  const topicsStr = chatTopicsInput?.value || "";
  const topics =
    topicsStr.trim().length > 0
      ? topicsStr.split(",").map((t) => t.trim()).filter(Boolean)
      : [];
  const payload = {
    creatorKey,
    minutes,
    topics,
    autoNews: Boolean(chatAutoNewsCheckbox?.checked),
    newsDays: Math.max(1, Math.min(14, Number(chatNewsDaysInput?.value || 7) || 7)),
    model: chatModelSelect?.value || undefined,
    title: chatEpisodeTitleInput?.value || ""
  };
  try {
    setButtonLoading(chatGenerateBtn, true, "Starting…");
    setStatusChat("Starting generation…", "info");
    chatJobActive = true;
    showProgressBar();
    const res = await fetchBridge("/api/chat/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res) {
      setStatusChat("Bridge not reachable.", "error");
      return;
    }
    const data = await res.json();
    if (data?.ok && data.jobId) {
      chatActiveJobId = data.jobId;
      startChatProgressPolling();
      setStatusChat("Queued. Generating…", "info");
    } else {
      setStatusChat(data?.error || "Failed to start generation.", "error");
      chatJobActive = false;
      if (!channelBatchActive && !extraJobActive) {
        hideProgressBar();
      }
    }
  } catch (err) {
    setStatusChat(err?.message || "Failed to start generation.", "error");
    chatJobActive = false;
    if (!channelBatchActive && !extraJobActive) {
      hideProgressBar();
    }
  } finally {
    setButtonLoading(chatGenerateBtn, false);
  }
});

// =====================
// Extra Tab - Whisper transcription
// =====================

const extraRefreshLibraryBtn = document.getElementById("extra-refresh-library");
const extraVideoSelect = document.getElementById("extra-video-select");
const extraEngineSelect = document.getElementById("extra-engine");
const extraModelSelect = document.getElementById("extra-model");
const extraPreviewSecondsInput = document.getElementById("extra-preview-seconds");
const extraPreviewOnlyCheckbox = document.getElementById("extra-preview-only");
const extraPreviewSecondsWrap = document.getElementById("extra-preview-seconds-wrap");
const extraGenerateBtn = document.getElementById("extra-generate");
const extraStatusBox = document.getElementById("extra-status");
const extraBackendDot = document.getElementById("extra-backend-dot");
const extraBackendSummaryText = document.getElementById("extra-backend-summary-text");
const extraBackendRefreshBtn = document.getElementById("extra-backend-refresh");
const extraFolderPathInput = document.getElementById("extra-folder-path");
const extraFolderBrowseBtn = document.getElementById("extra-folder-browse");
const extraFolderRecursiveCheckbox = document.getElementById("extra-folder-recursive");
const extraFolderScanBtn = document.getElementById("extra-folder-scan");
const extraFolderGenerateBtn = document.getElementById("extra-folder-generate");
const extraFolderScanSummary = document.getElementById("extra-folder-scan-summary");

let extraLibraryEntries = [];
let extraBackendInfo = null;
let extraProgressTimer = null;
let extraFolderTargets = [];
let extraFolderBatchPollTimer = null;

function getExtraMediaPath(entry) {
  if (!entry) return "";
  return entry.video?.path || entry.audio?.path || "";
}

function getExtraMediaKind(entry) {
  if (!entry) return "";
  if (entry.mediaKind === "audio" || entry.audio?.path) return "audio";
  if (entry.mediaKind === "video" || entry.video?.path) return "video";
  return "";
}

function getExtraAsrPayload() {
  const model = extraModelSelect?.value || "medium.en";
  const previewOnly = Boolean(extraPreviewOnlyCheckbox?.checked);
  const rawPreview = Math.max(0, Math.min(600, Number(extraPreviewSecondsInput?.value || 0) || 0));
  const previewSeconds = previewOnly ? Math.max(1, rawPreview) : 0;
  const engine = extraEngineSelect?.value || "whisper";
  return {
    model,
    engine,
    previewSeconds,
    language: "en"
  };
}

function syncExtraPreviewControls() {
  const previewOn = Boolean(extraPreviewOnlyCheckbox?.checked);
  extraPreviewSecondsWrap?.classList.toggle("is-disabled", !previewOn);
  if (extraPreviewSecondsInput) {
    extraPreviewSecondsInput.disabled = !previewOn;
  }
}

syncExtraPreviewControls();
extraPreviewOnlyCheckbox?.addEventListener("change", syncExtraPreviewControls);

function formatExtraMediaBadge(kind) {
  if (kind === "audio") return "[Audio] ";
  if (kind === "video") return "[Video] ";
  return "";
}

function setStatusExtra(message, type = "info") {
  if (!extraStatusBox) return;
  extraStatusBox.innerHTML = renderStatus(message, type);
}

function updateExtraBackendUI(info) {
  extraBackendInfo = info || null;
  if (!extraBackendSummaryText || !extraBackendDot) return;

  extraBackendDot.className = "status-dot status-dot-unknown";

  if (!info) {
    extraBackendSummaryText.textContent = "not checked yet.";
    return;
  }

  const whisperAvailable = Boolean(info.whisperAvailable);
  const fasterWhisperAvailable = Boolean(info.fasterWhisperAvailable);
  const hasEngine = whisperAvailable || fasterWhisperAvailable;
  const cudaAvailable =
    typeof info.cudaAvailable === "boolean"
      ? info.cudaAvailable
      : info.whisperMode === "gpu" || info.whisperDevice === "cuda"
        ? true
        : info.whisperMode === "cpu" || info.whisperDevice === "cpu"
          ? false
          : null;
  const hadFallback = Boolean(info.whisperFallbackError);
  const hasError = Boolean(info.error);

  if (!hasEngine) {
    extraBackendDot.className = "status-dot status-dot-error";
    extraBackendSummaryText.textContent = "Whisper not installed.";
  } else if (hasError) {
    extraBackendDot.className = "status-dot status-dot-error";
    extraBackendSummaryText.textContent = "error probing backend.";
  } else if (cudaAvailable === true && !hadFallback) {
    extraBackendDot.className = "status-dot status-dot-ok";
    extraBackendSummaryText.textContent = fasterWhisperAvailable && !whisperAvailable
      ? "Faster-Whisper GPU ready."
      : "GPU (CUDA) ready.";
  } else if (cudaAvailable === true && hadFallback) {
    extraBackendDot.className = "status-dot status-dot-warn";
    extraBackendSummaryText.textContent = "GPU available; previous run fell back to CPU.";
  } else if (cudaAvailable === false) {
    extraBackendDot.className = "status-dot status-dot-warn";
    extraBackendSummaryText.textContent = "CPU mode (CUDA not available).";
  } else {
    extraBackendDot.className = "status-dot status-dot-ok";
    extraBackendSummaryText.textContent = "Whisper ready.";
  }
}

async function refreshExtraBackendStatus() {
  if (!extraBackendRefreshBtn) return;
  setButtonLoading(extraBackendRefreshBtn, true, "…");
  try {
    const res = await fetchBridge("/api/asr/status", { method: "GET" });
    if (!res) {
      updateExtraBackendUI({ error: "Bridge not reachable." });
      setStatusExtra("Bridge not reachable for backend check.", "error");
      return;
    }
    const data = await res.json();
    const info = {
      torchVersion: data.torchVersion,
      cudaAvailable: data.cudaAvailable,
      device: data.device,
      whisperAvailable: data.whisperAvailable,
      fasterWhisperAvailable: data.fasterWhisperAvailable,
      whisperCommand: data.whisperCommand,
      error: data.error || null
    };
    if (!data.ok) {
      updateExtraBackendUI(info);
      setStatusExtra(
        data.error ||
          "Whisper is not available. Install openai-whisper or faster-whisper, or set the command in Settings → Tools.",
        "error"
      );
      return;
    }
    updateExtraBackendUI(info);
    const engineBits = [];
    if (data.whisperAvailable) engineBits.push("openai-whisper");
    if (data.fasterWhisperAvailable) engineBits.push("faster-whisper");
    if (data.cudaAvailable) {
      setStatusExtra(
        `Whisper ready (${engineBits.join(", ") || "engine detected"}). torch ${
          data.torchVersion || "unknown"
        }, device: ${data.device || "GPU"}.`,
        "success"
      );
    } else {
      setStatusExtra(
        `Whisper ready in CPU mode (${engineBits.join(", ") || "engine detected"}). torch ${
          data.torchVersion || "unknown"
        }, device: ${data.device || "CPU"}.`,
        "info"
      );
    }
  } catch (err) {
    updateExtraBackendUI({ error: err?.message || "Backend check failed." });
    setStatusExtra(err?.message || "Backend check failed.", "error");
  } finally {
    setButtonLoading(extraBackendRefreshBtn, false);
  }
}

extraBackendRefreshBtn?.addEventListener("click", () => {
  refreshExtraBackendStatus();
});

async function pollExtraProgressOnce() {
  try {
    const res = await fetchBridge("/api/asr/progress", { method: "GET" });
    if (!res) return;
    const data = await res.json();
    if (!data?.ok) return;
    const p = data.progress || {};
    if (!p.active && !extraProgressTimer) return;
    let msg;
    const engineLabel =
      p.engine === "faster-whisper"
        ? "Faster-Whisper"
        : "Whisper";
    if (p.batchActive && p.batchTotal) {
      const fileLabel = p.batchFile ? ` — ${p.batchFile}` : "";
      if (p.phase === "batch-file" || p.phase === "batch") {
        msg = `Folder batch: file ${p.batchCurrent || 0} of ${p.batchTotal}${fileLabel}`;
      } else if (!p.phase || p.phase === "preparing-audio" || p.phase === "chunking") {
        msg = `Folder batch (${p.batchCurrent || 0}/${p.batchTotal}): preparing audio${fileLabel}…`;
      } else if (p.phase === "chunk") {
        const total = p.totalChunks || 0;
        const current = p.currentChunk || 0;
        msg = total
          ? `Folder batch (${p.batchCurrent || 0}/${p.batchTotal}): chunk ${current} of ${total}${fileLabel}`
          : `Folder batch (${p.batchCurrent || 0}/${p.batchTotal}): transcribing${fileLabel}…`;
      } else {
        msg = `Folder batch: file ${p.batchCurrent || 0} of ${p.batchTotal}${fileLabel}`;
      }
    } else if (!p.phase || p.phase === "preparing-audio" || p.phase === "chunking") {
      msg = `Preparing audio and estimating chunks for ${engineLabel}…`;
    } else if (p.phase === "preview") {
      msg = `Running ${engineLabel} preview on GPU…`;
    } else if (p.phase === "chunk") {
      const total = p.totalChunks || 0;
      const current = p.currentChunk || 0;
      if (total) {
        msg = `Running ${engineLabel} transcription…\nProcessing chunk ${current} of ${total}…`;
      } else {
        msg = `Running ${engineLabel} transcription…\nProcessing chunk ${current}…`;
      }
 
    } else if (p.phase === "done") {
      msg = `${engineLabel} transcription finished.`;
    } else if (p.phase === "error") {
      msg = `${engineLabel} transcription encountered an error (see details below).`;
    } else {
      msg = `${engineLabel} transcription in progress…`;
    }
    setStatusExtra(msg, "info");
  } catch {
    // ignore transient errors
  }
}

function startExtraProgressPolling() {
  if (extraProgressTimer) return;
  extraProgressTimer = setInterval(pollExtraProgressOnce, 1000);
}

function stopExtraProgressPolling() {
  if (!extraProgressTimer) return;
  clearInterval(extraProgressTimer);
  extraProgressTimer = null;
}

async function fetchLibraryEntries() {
  try {
    const res = await fetchBridge("/api/library/list", { method: "GET" });
    if (!res) return [];
    const data = await res.json();
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    // For the Extra tab we only want videos that do NOT already have an
    // associated transcript (.vtt) so we don't overwrite existing captions.
    return entries.filter((e) => !e.transcript && getExtraMediaPath(e));
  } catch {
    return [];
  }
}

function populateExtraVideoSelect(entries) {
  if (!extraVideoSelect) return;
  extraVideoSelect.innerHTML = "";
  if (!entries.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No media without transcripts found in library";
    extraVideoSelect.appendChild(opt);
    return;
  }
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select video or audio without transcript…";
  extraVideoSelect.appendChild(placeholder);
  entries.forEach((e) => {
    const opt = document.createElement("option");
    opt.value = e.id;
    const mediaPath = getExtraMediaPath(e);
    const base = mediaPath ? mediaPath.split(/[/\\]/).pop() : "";
    const title = e.title || "";
    const badge = formatExtraMediaBadge(getExtraMediaKind(e));
    let label;
    if (title && base && title !== base) {
      label = `${badge}${title} — ${base}`;
    } else if (title) {
      label = `${badge}${title}`;
    } else if (base) {
      label = `${badge}${base}`;
    } else {
      label = `${badge}${e.id}`;
    }
    opt.textContent = label;
    extraVideoSelect.appendChild(opt);
  });
}

function setExtraFolderScanSummary(message) {
  if (!extraFolderScanSummary) return;
  extraFolderScanSummary.textContent = message;
}

function updateExtraFolderGenerateButton() {
  if (!extraFolderGenerateBtn) return;
  extraFolderGenerateBtn.disabled = !extraFolderTargets.length;
}

function resetExtraFolderScan() {
  extraFolderTargets = [];
  updateExtraFolderGenerateButton();
  setExtraFolderScanSummary("Scan a folder to see how many files need transcripts.");
}

async function initializeExtraTab() {
  setStatusExtra("Loading library entries…", "info");
  updateExtraBackendUI(extraBackendInfo);
  resetExtraFolderScan();
  extraLibraryEntries = await fetchLibraryEntries();
  populateExtraVideoSelect(extraLibraryEntries);
  setStatusExtra(
    extraLibraryEntries.length
      ? "Library loaded. Showing videos and audio without transcripts."
      : "No videos or audio without transcripts found in your library.",
    extraLibraryEntries.length ? "success" : "error"
  );
}

extraRefreshLibraryBtn?.addEventListener("click", async () => {
  setStatusExtra("Refreshing library…", "info");
  const res = await fetchBridge("/api/library/rescan", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (!res) {
    setStatusExtra("Bridge not reachable.", "error");
    return;
  }
  extraLibraryEntries = await fetchLibraryEntries();
  populateExtraVideoSelect(extraLibraryEntries);
  setStatusExtra(
    extraLibraryEntries.length
      ? "Library refreshed. Showing videos and audio without transcripts."
      : "Library refreshed. No videos or audio without transcripts found.",
    extraLibraryEntries.length ? "success" : "error"
  );
});

extraFolderBrowseBtn?.addEventListener("click", async () => {
  setButtonLoading(extraFolderBrowseBtn, true, "…");
  try {
    const initialDir = (extraFolderPathInput?.value || "").trim();
    const res = await fetchBridge("/api/dialog/pick-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initialDir })
    });
    if (!res) {
      setStatusExtra("Bridge not reachable.", "error");
      return;
    }
    const data = await res.json();
    if (!data?.ok) {
      setStatusExtra(data?.error || "Could not open folder picker.", "error");
      return;
    }
    if (data.cancelled) {
      return;
    }
    if (data.folderPath && extraFolderPathInput) {
      extraFolderPathInput.value = data.folderPath;
      resetExtraFolderScan();
      setStatusExtra(`Folder selected: ${data.folderPath}`, "success");
    }
  } catch (err) {
    setStatusExtra(err?.message || "Could not open folder picker.", "error");
  } finally {
    setButtonLoading(extraFolderBrowseBtn, false);
  }
});

extraFolderScanBtn?.addEventListener("click", async () => {
  const folderPath = (extraFolderPathInput?.value || "").trim();
  if (!folderPath) {
    setStatusExtra("Choose a folder with Browse or enter a path to scan.", "error");
    return;
  }
  const recursive = Boolean(extraFolderRecursiveCheckbox?.checked);
  setButtonLoading(extraFolderScanBtn, true, "Scanning…");
  setStatusExtra("Scanning folder for media without transcripts…", "info");
  try {
    const res = await fetchBridge("/api/library/folder-scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderPath, recursive })
    });
    if (!res) {
      setStatusExtra("Bridge not reachable.", "error");
      return;
    }
    const data = await res.json();
    if (!data?.ok) {
      setStatusExtra(data?.error || "Folder scan failed.", "error");
      resetExtraFolderScan();
      return;
    }
    extraFolderTargets = Array.isArray(data.targets) ? data.targets : [];
    updateExtraFolderGenerateButton();
    const audioCount = extraFolderTargets.filter((t) => t.kind === "audio").length;
    const videoCount = extraFolderTargets.filter((t) => t.kind === "video").length;
    if (!extraFolderTargets.length) {
      setExtraFolderScanSummary("No video or audio files without transcripts were found in that folder.");
      setStatusExtra("Folder scan complete. Nothing to transcribe.", "success");
      return;
    }
    setExtraFolderScanSummary(
      `Found ${extraFolderTargets.length} file(s) needing transcripts (${videoCount} video, ${audioCount} audio).`
    );
    setStatusExtra(
      `Folder scan complete. ${extraFolderTargets.length} file(s) ready for batch transcription.`,
      "success"
    );
  } catch (err) {
    setStatusExtra(err?.message || "Folder scan failed.", "error");
    resetExtraFolderScan();
  } finally {
    setButtonLoading(extraFolderScanBtn, false);
  }
});

function stopExtraFolderBatchPolling() {
  if (!extraFolderBatchPollTimer) return;
  clearInterval(extraFolderBatchPollTimer);
  extraFolderBatchPollTimer = null;
}

function startExtraFolderBatchPolling(onComplete) {
  stopExtraFolderBatchPolling();
  extraFolderBatchPollTimer = setInterval(async () => {
    try {
      const res = await fetchBridge("/api/asr/progress", { method: "GET" });
      if (!res) return;
      const data = await res.json();
      const p = data?.progress || {};
      if (p.active) {
        await pollExtraProgressOnce();
        return;
      }
      stopExtraFolderBatchPolling();
      onComplete?.(p);
    } catch {
      // keep polling
    }
  }, 1000);
}

function finishExtraFolderBatchUi() {
  setButtonLoading(extraFolderGenerateBtn, false);
  setButtonLoading(extraFolderScanBtn, false);
  extraJobActive = false;
  stopExtraProgressPolling();
  stopExtraFolderBatchPolling();
  if (!channelBatchActive) {
    hideProgressBar();
  }
}

extraFolderGenerateBtn?.addEventListener("click", async () => {
  const folderPath = (extraFolderPathInput?.value || "").trim();
  if (!folderPath) {
    setStatusExtra("Choose a folder with Browse or enter a path.", "error");
    return;
  }
  if (!extraFolderTargets.length) {
    setStatusExtra("Scan the folder first to find files without transcripts.", "error");
    return;
  }
  if (!(await requireStreamsteinBackend())) return;

  const recursive = Boolean(extraFolderRecursiveCheckbox?.checked);
  const asr = getExtraAsrPayload();
  const engineLabel = asr.engine === "faster-whisper" ? "Faster Whisper" : "Whisper";
  const totalQueued = extraFolderTargets.length;

  const finishBatch = async (finalProgress, batchTotal) => {
    if (finalProgress?.phase === "error") {
      setStatusExtra("Folder batch encountered an error.", "error");
    } else {
      setStatusExtra(
        `Folder batch finished. Processed ${batchTotal} file(s). Refreshing library…`,
        "success"
      );
    }
    await refreshGlobalLibrarySummary({ forceRescan: false });
    extraLibraryEntries = await fetchLibraryEntries();
    populateExtraVideoSelect(extraLibraryEntries);
    try {
      const scanRes = await fetchBridge("/api/library/folder-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderPath, recursive })
      });
      if (scanRes) {
        const scanData = await scanRes.json();
        if (scanData?.ok) {
          extraFolderTargets = Array.isArray(scanData.targets) ? scanData.targets : [];
          updateExtraFolderGenerateButton();
          if (!extraFolderTargets.length) {
            setExtraFolderScanSummary("All media in this folder now have transcripts.");
          } else {
            setExtraFolderScanSummary(
              `${extraFolderTargets.length} file(s) still need transcripts.`
            );
          }
        }
      }
    } catch {
      resetExtraFolderScan();
    }
    finishExtraFolderBatchUi();
  };

  try {
    setStatusExtra(
      `Starting folder batch (${totalQueued} file(s)) with ${engineLabel}…`,
      "info"
    );
    setButtonLoading(extraFolderGenerateBtn, true, "Working…");
    setButtonLoading(extraFolderScanBtn, true, "…");
    extraJobActive = true;
    showProgressBar();
    startExtraProgressPolling();

    const res = await fetchBridge("/api/asr/folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folderPath,
        recursive,
        ...asr
      })
    });
    if (!res) {
      setStatusExtra("Bridge not reachable.", "error");
      finishExtraFolderBatchUi();
      return;
    }
    const data = await res.json();
    if (!data?.ok) {
      setStatusExtra(data?.error || "Could not start folder batch.", "error");
      finishExtraFolderBatchUi();
      return;
    }
    if (!data.started || !data.total) {
      setStatusExtra(data.message || "No files needed transcription.", "success");
      resetExtraFolderScan();
      finishExtraFolderBatchUi();
      return;
    }

    const batchTotal = data.total;
    startExtraFolderBatchPolling((finalProgress) => {
      void finishBatch(finalProgress, batchTotal);
    });
  } catch (err) {
    setStatusExtra(err?.message || "Folder batch failed.", "error");
    finishExtraFolderBatchUi();
  }
});

extraGenerateBtn?.addEventListener("click", async () => {
  const entryId = extraVideoSelect?.value || "";
  if (!entryId) {
    setStatusExtra("Select a video or audio file from the library.", "error");
    return;
  }
  const entry = extraLibraryEntries.find((e) => e.id === entryId);
  const mediaPath = getExtraMediaPath(entry);
  if (!entry || !mediaPath) {
    setStatusExtra("Selected entry has no media file.", "error");
    return;
  }
  if (!(await requireStreamsteinBackend())) return;

  const asr = getExtraAsrPayload();
  const engine = asr.engine;

  try {
    setStatusExtra(`Starting ${engine === "faster-whisper" ? "Faster Whisper" : "Whisper"} transcription…`, "info");
    setButtonLoading(extraGenerateBtn, true, "Working…");
    extraJobActive = true;
    showProgressBar();
    startExtraProgressPolling();
    const payload = {
      path: mediaPath,
      ...asr
    };
    const res = await fetchBridge("/api/asr/whisper", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res) {
      setStatusExtra("Bridge not reachable.", "error");
      return;
    }
    const data = await res.json();
    if (data?.ok) {
      setStatusExtra(`Transcript created: ${data.transcriptPath}`, "success");
      updateExtraBackendUI({
        whisperMode: data.whisperMode,
        whisperDevice: data.whisperDevice,
        whisperFallbackError: data.whisperFallbackError
      });
      await refreshGlobalLibrarySummary({ forceRescan: false });
      // Refresh the Extra tab list so the processed video (now with a .vtt
      // transcript) disappears from the selection dropdown.
      extraLibraryEntries = await fetchLibraryEntries();
      populateExtraVideoSelect(extraLibraryEntries);
    } else {
      setStatusExtra(data?.error || "Whisper transcription failed.", "error");
    }
  } catch (err) {
    setStatusExtra(err?.message || "Failed to run Whisper.", "error");
  } finally {
    setButtonLoading(extraGenerateBtn, false);
    extraJobActive = false;
    stopExtraProgressPolling();
    if (!channelBatchActive) {
      hideProgressBar();
    }
  }
});

async function applyServerConfig(existingBridgeConfig = null) {
  try {
    const bridgeConfig = existingBridgeConfig || (await fetchBridgeConfig());
    const cookies = resolveCookiesSettingsForBridge(bridgeConfig);
    const res = await fetchBridge("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ffmpegPath: appSettings.ffmpegPath || bridgeConfig?.ffmpegPath || "",
        downloadMode: appSettings.saveMode || DEFAULT_SETTINGS.saveMode,
        downloadSubfolder:
          appSettings.saveMode === "subfolder"
            ? appSettings.subfolder || DEFAULT_SETTINGS.subfolder
            : DEFAULT_SETTINGS.subfolder,
        ytDlpCookiesFromBrowser: cookies.fromBrowser,
        ytDlpCookiesFile: cookies.file,
        // Warm-up is handled in the Chrome extension (background tab open/close)
        // to ensure it happens in the user's real Chrome profile.
        ytDlpWarmupEnabled: false,
        whisperCommand: appSettings.whisperCommand || bridgeConfig?.whisperCommand || ""
      })
    });
    if (!res) {
      return "Saved locally; bridge not reachable.";
    }
    if (!res.ok) {
      return "Saved locally; could not reach bridge to apply server config.";
    }
    const data = await res.json();
    if (data?.ok) {
      return data.ffmpegVerified
        ? "Settings saved. FFmpeg verified."
        : "Settings saved. FFmpeg not verified; check path.";
    }
    return "Saved locally; bridge rejected config.";
  } catch {
    return "Saved locally; bridge not reachable.";
  }
}

// =====================
// Legal note (for you as dev)
// =====================
// Only download content when you have the rights to do so and stay within
// YouTube's Terms of Service and your local laws.
