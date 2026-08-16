// background.js (MV3 service worker)

const MAX_PROXY_RESPONSE_CHARS = 2_000_000; // 2 MB ceiling for text payloads.

// Track downloads started via the bridge so we can report progress to the UI.
const downloadJobs = {};

// Simple channel batch queue so a sequence of downloads keeps running
// in the background even if the popup is closed.
const channelQueue = [];
let channelActive = false;
let channelDelaySeconds = 0;
let currentChannelDownloadId = null;

const DEFAULT_SETTINGS = {
  ytDlpWarmupEnabled: false,
  ytDlpWarmupDelayMs: 2500,
  ytDlpWarmupCooldownMs: 15000,
  ytDlpWarmupCloseTab: true
};

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

async function loadSyncedSettings() {
  try {
    const getter = chrome.storage?.sync?.get;
    if (typeof getter !== "function") {
      return { ...DEFAULT_SETTINGS };
    }
    let data = null;
    const maybePromise = getter.call(chrome.storage.sync, "ytSaverSettings");
    if (maybePromise && typeof maybePromise.then === "function") {
      data = await maybePromise;
    } else {
      data = await new Promise((resolve) => {
        try {
          chrome.storage.sync.get("ytSaverSettings", (result) => resolve(result));
        } catch {
          resolve(null);
        }
      });
    }
    const stored = data?.ytSaverSettings;
    if (stored && typeof stored === "object") {
      return {
        ...DEFAULT_SETTINGS,
        ...stored,
        ytDlpWarmupEnabled: Boolean(stored.ytDlpWarmupEnabled),
        ytDlpWarmupDelayMs: clampNumber(
          stored.ytDlpWarmupDelayMs,
          0,
          15000,
          DEFAULT_SETTINGS.ytDlpWarmupDelayMs
        ),
        ytDlpWarmupCooldownMs: clampNumber(
          stored.ytDlpWarmupCooldownMs,
          0,
          600000,
          DEFAULT_SETTINGS.ytDlpWarmupCooldownMs
        ),
        ytDlpWarmupCloseTab: stored.ytDlpWarmupCloseTab !== false
      };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function extractVideoId(input) {
  if (!input || typeof input !== "string") return null;
  try {
    const url = new URL(input);
    if (url.hostname === "youtu.be") {
      const id = url.pathname.replace("/", "");
      return id || null;
    }
    const v = url.searchParams.get("v");
    if (v) return v;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] === "shorts" && segments[1]) return segments[1];
  } catch {
    const match = input.match(/[?&]v=([^&]+)/);
    if (match) return match[1];
  }
  return null;
}

const warmupLastOpenedAtByVideoId = new Map();
let warmupLock = Promise.resolve();
let activeWarmup = { videoId: null, tabId: null };

async function ensureWarmupTabForUrl(videoUrl) {
  const settings = await loadSyncedSettings();
  if (!settings.ytDlpWarmupEnabled) return;

  const videoId = extractVideoId(videoUrl);
  if (!videoId) return;

  const delayMs = clampNumber(settings.ytDlpWarmupDelayMs, 0, 15000, DEFAULT_SETTINGS.ytDlpWarmupDelayMs);
  const cooldownMs = clampNumber(settings.ytDlpWarmupCooldownMs, 0, 600000, DEFAULT_SETTINGS.ytDlpWarmupCooldownMs);

  const now = Date.now();
  const last = warmupLastOpenedAtByVideoId.get(videoId) || 0;
  if (cooldownMs > 0 && now - last < cooldownMs) return;

  if (activeWarmup.videoId === videoId && typeof activeWarmup.tabId === "number") {
    return;
  }

  // Serialize warm-ups to avoid tab spam during heavy batches.
  warmupLock = warmupLock.then(async () => {
    if (activeWarmup.videoId === videoId && typeof activeWarmup.tabId === "number") {
      return;
    }
    const now2 = Date.now();
    const last2 = warmupLastOpenedAtByVideoId.get(videoId) || 0;
    if (cooldownMs > 0 && now2 - last2 < cooldownMs) return;
    warmupLastOpenedAtByVideoId.set(videoId, now2);

    const warmUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    let tabId = null;
    try {
      const tab = await chrome.tabs.create({ url: warmUrl, active: false });
      tabId = tab?.id ?? null;
    } catch {
      tabId = null;
    }

    if (delayMs > 0) {
      await sleepMs(delayMs);
    }

    // Keep the tab open for the duration of this video's downloads.
    // We'll close it when the video/transcript downloads complete.
    activeWarmup = { videoId, tabId: typeof tabId === "number" ? tabId : null };
  }).catch(() => {});

  await warmupLock;
}

async function maybeCloseWarmupTabIfDone(currentVideoUrl) {
  try {
    const settings = await loadSyncedSettings();
    if (!settings.ytDlpWarmupEnabled) return;
    if (settings.ytDlpWarmupCloseTab === false) return;

    const currentVideoId = extractVideoId(currentVideoUrl);
    if (!currentVideoId) return;
    if (activeWarmup.videoId !== currentVideoId) return;

    const next = channelQueue.length ? channelQueue[0] : null;
    const nextVideoId = next ? (next.meta?.videoId || extractVideoId(next.url)) : null;
    if (nextVideoId && nextVideoId === currentVideoId) {
      return; // still more work for this same video; keep tab open
    }

    const tabId = activeWarmup.tabId;
    activeWarmup = { videoId: null, tabId: null };
    if (typeof tabId === "number") {
      try {
        await chrome.tabs.remove(tabId);
      } catch {}
    }
  } catch {}
}

// Track the dedicated app window so we can focus it instead of opening duplicates.
let appWindowId = null;
const MIN_APP_WIDTH = 420;
const MIN_APP_HEIGHT = 640;

chrome.action.onClicked.addListener(async () => {
  try {
    if (appWindowId != null) {
      try {
        const existing = await chrome.windows.get(appWindowId);
        if (existing) {
          await chrome.windows.update(appWindowId, { focused: true });
          return;
        }
      } catch {
        // Window no longer exists; fall through to create a new one.
      }
    }

    const url = chrome.runtime.getURL("popup/popup.html");
    const created = await chrome.windows.create({
      url,
      type: "popup",
      width: 500,
      height: 750
    });
    if (created && typeof created.id === "number") {
      appWindowId = created.id;
      // Immediately clamp bounds in case platform reduced them.
      try {
        const w = await chrome.windows.get(appWindowId);
        const update = {};
        let need = false;
        if (typeof w.width === "number" && w.width < MIN_APP_WIDTH) {
          update.width = MIN_APP_WIDTH;
          need = true;
        }
        if (typeof w.height === "number" && w.height < MIN_APP_HEIGHT) {
          update.height = MIN_APP_HEIGHT;
          need = true;
        }
        if (need) {
          await chrome.windows.update(appWindowId, update);
        }
      } catch {}
    }
  } catch (err) {
    console.error("[YouTube Downloader] Failed to open app window", err);
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === appWindowId) {
    appWindowId = null;
  }
});

// Enforce a minimum size while the user resizes the app window.
chrome.windows.onBoundsChanged.addListener(async (windowId) => {
  if (windowId !== appWindowId) return;
  try {
    const w = await chrome.windows.get(windowId);
    if (!w) return;
    const update = {};
    let need = false;
    if (typeof w.width === "number" && w.width < MIN_APP_WIDTH) {
      update.width = MIN_APP_WIDTH;
      need = true;
    }
    if (typeof w.height === "number" && w.height < MIN_APP_HEIGHT) {
      update.height = MIN_APP_HEIGHT;
      need = true;
    }
    if (need) {
      await chrome.windows.update(windowId, update);
    }
  } catch {}
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "BRIDGE_DOWNLOAD") {
    handleBridgeDownload(message)
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error(err);
        sendResponse({ ok: false, error: err?.message || "Bridge download failed" });
      });
    return true;
  }

  if (message?.type === "PROXY_FETCH") {
    handleProxyFetch(message.request)
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error(err);
        sendResponse({ ok: false, error: err?.message || "Proxy fetch failed." });
      });
    return true;
  }

  if (message?.type === "YT_SAVER_CHANNEL_BATCH") {
    try {
      const jobs = Array.isArray(message.jobs) ? message.jobs : [];
      const delay = Number(message.delaySeconds) || 0;
      if (jobs.length) {
        channelQueue.push(...jobs);
        channelDelaySeconds = delay;
        if (!channelActive) {
          channelActive = true;
          runNextChannelJob();
        }
      }
      sendResponse({ ok: true, queued: channelQueue.length });
    } catch (err) {
      console.error(err);
      sendResponse({ ok: false, error: err?.message || "Failed to queue channel batch." });
    }
    return true;
  }

  return false;
});

async function handleBridgeDownload(message) {
  const url = message?.url;
  const filenameHint = message?.filenameHint || "video.mp4";
  const saveAs = message?.saveAs !== false; // default to true; channel can explicitly disable
  const params = message?.params && typeof message.params === "object" ? message.params : {};
  const endpointPath = typeof message?.endpoint === "string" && message.endpoint ? message.endpoint : "download";
  if (!url || typeof url !== "string") {
    return { ok: false, error: "Missing URL" };
  }

  const endpoints = [
    `http://127.0.0.1:8789/api/${endpointPath}`,
    `http://localhost:8789/api/${endpointPath}`
  ];

  const search = new URLSearchParams({
    url,
    ...params,
    ...(typeof message?.meta?.title === "string" && message.meta.title.trim()
      ? { title: message.meta.title.trim() }
      : {})
  });
  let lastError = null;

  for (const ep of endpoints) {
    const downloadUrl = `${ep}?${search.toString()}`;
    try {
      const downloadId = await startChromeDownload(
        downloadUrl,
        filenameHint,
        saveAs
      );
      const meta = normalizeJobMeta(message?.meta);
      downloadJobs[downloadId] = {
        url,
        downloadUrl,
        filenameHint,
        startedAt: Date.now(),
        meta
      };
      postCatalogRequest({
        status: "pending",
        videoId: meta?.videoId,
        watchUrl: meta?.watchUrl || url,
        title: meta?.title,
        normalizedTitle: meta?.normalizedTitle,
        channelId: meta?.channelId,
        channelName: meta?.channelName,
        assetType: meta?.assetType,
        source: meta?.source,
        quality: meta?.quality,
        filenameHint
      }).catch(() => {});
      return { ok: true, downloadId };
    } catch (err) {
      lastError = err;
    }
  }

  return { ok: false, error: lastError?.message || "Bridge unavailable" };
}

async function handleProxyFetch(request = {}) {
  const url = typeof request.url === "string" ? request.url : null;
  if (!url) {
    return { ok: false, error: "Missing url" };
  }

  const method = (request.method || "GET").toUpperCase();
  const headers = buildHeaders(request.headers);
  const init = {
    method,
    headers,
    redirect: "follow",
    cache: "no-store",
    credentials: normalizeCredentials(request.credentials)
  };

  if (request.body && method !== "GET" && method !== "HEAD") {
    init.body = request.body;
  }

  const response = await fetch(url, init);
  const text = await response.text();
  if (text.length > MAX_PROXY_RESPONSE_CHARS) {
    return { ok: false, error: "Proxy response exceeded 2 MB limit." };
  }

  const headersArray = [];
  response.headers.forEach((value, key) => {
    headersArray.push([key, value]);
  });

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: headersArray,
    body: text
  };
}

function buildHeaders(input) {
  const headers = new Headers();
  if (Array.isArray(input)) {
    input.forEach(([key, value]) => {
      if (key && typeof value === "string") {
        headers.set(key, value);
      }
    });
    return headers;
  }

  if (input && typeof input === "object") {
    Object.entries(input).forEach(([key, value]) => {
      if (typeof value === "string") {
        headers.set(key, value);
      }
    });
  }
  return headers;
}

function normalizeCredentials(value) {
  if (value === "include" || value === "omit") {
    return value;
  }
  return "same-origin";
}

function startChromeDownload(downloadUrl, filenameHint, saveAs = true) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: downloadUrl,
        filename: filenameHint,
        saveAs,
        conflictAction: "uniquify"
      },
      (downloadId) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        if (downloadId === undefined || downloadId === null) {
          reject(new Error("Failed to start download"));
          return;
        }
        resolve(downloadId);
      }
    );
  });
}

function runNextChannelJob() {
  const job = channelQueue.shift(); // { url, filenameHint, saveAs, params, endpoint, noDelayAfter }

  if (!job) {
    // Nothing left to do; mark batch as completed.
    if (channelActive) {
      channelActive = false;
      currentChannelDownloadId = null;
      try {
        chrome.runtime.sendMessage({
          type: "YT_SAVER_CHANNEL_STATUS",
          message: "Channel batch completed."
        });
      } catch {}
    }
    return;
  }

  (async () => {
    try {
      chrome.runtime.sendMessage({
        type: "YT_SAVER_CHANNEL_STATUS",
        message: `Starting: ${job.filenameHint || job.url}`
      });
    } catch {}

    try {
      await ensureWarmupTabForUrl(job.url);
      const result = await handleBridgeDownload(job);
      try {
        chrome.runtime.sendMessage({
          type: "YT_SAVER_CHANNEL_STATUS",
          message: result.ok
            ? `✓ Started download: ${job.filenameHint || job.url}`
            : `✗ Failed to start: ${job.filenameHint || job.url} (${result.error || "unknown error"})`
        });
      } catch {}

      if (result && result.ok && typeof result.downloadId === "number") {
        const dj = downloadJobs[result.downloadId];
        if (dj) {
          dj.isChannel = true;
          if (job.noDelayAfter) {
            dj.noDelayAfter = true;
          }
        }
        currentChannelDownloadId = result.downloadId;
        // Do NOT start the next job yet; wait for this download to complete
        // (handled in chrome.downloads.onChanged).
      } else {
        // No download was started; move on to the next job immediately.
        scheduleNextChannelJobAfterDelay();
      }
    } catch (err) {
      console.error(err);
      try {
        chrome.runtime.sendMessage({
          type: "YT_SAVER_CHANNEL_STATUS",
          message: `✗ Error for ${job.filenameHint || job.url}: ${err?.message || "Unknown error"}`
        });
      } catch {}
      scheduleNextChannelJobAfterDelay();
    }
  })();
}

function scheduleNextChannelJobAfterDelay() {
  if (!channelQueue.length) {
    if (channelActive) {
      channelActive = false;
      currentChannelDownloadId = null;
      try {
        chrome.runtime.sendMessage({
          type: "YT_SAVER_CHANNEL_STATUS",
          message: "Channel batch completed."
        });
      } catch {}
    }
    return;
  }

  if (channelDelaySeconds > 0) {
    try {
      chrome.runtime.sendMessage({
        type: "YT_SAVER_CHANNEL_STATUS",
        message: `⏳ Waiting ${channelDelaySeconds}s before next video...`
      });
    } catch {}
    setTimeout(runNextChannelJob, channelDelaySeconds * 1000);
  } else {
    runNextChannelJob();
  }
}

// Report download progress back to any open popup.
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta || typeof delta.id !== "number") return;
  const job = downloadJobs[delta.id];
  if (!job) return;

  if (delta.bytesReceived && typeof delta.bytesReceived.current === "number") {
    job.bytesReceived = delta.bytesReceived.current;
  }
  if (delta.totalBytes && typeof delta.totalBytes.current === "number") {
    job.totalBytes = delta.totalBytes.current;
  }
  if (delta.state && typeof delta.state.current === "string") {
    job.state = delta.state.current;
  }

  const bytesReceived = job.bytesReceived ?? 0;
  const totalBytes = job.totalBytes ?? 0;
  const state = job.state || "in_progress";

  try {
    chrome.runtime.sendMessage({
      type: "YT_SAVER_DOWNLOAD_PROGRESS",
      downloadId: delta.id,
      bytesReceived,
      totalBytes,
      state,
      filenameHint: job.filenameHint,
      meta: job.meta || null,
      isChannel: Boolean(job.isChannel)
    });
  } catch {}

  if (state === "complete") {
    registerDownloadWithLibrary(delta.id, job).then((registered) => {
      if (registered) {
        try {
          chrome.runtime.sendMessage({
            type: "YT_SAVER_DOWNLOAD_COMPLETE",
            downloadId: delta.id,
            filenameHint: job.filenameHint,
            meta: job.meta || null,
            isChannel: Boolean(job.isChannel)
          });
        } catch {}
      }
    });
  }

  if (state === "complete" || state === "interrupted") {
    const wasChannel = job.isChannel;
    const noDelayAfter = job.noDelayAfter;
    delete downloadJobs[delta.id];
    if (wasChannel && delta.id === currentChannelDownloadId) {
      currentChannelDownloadId = null;
      // If we're done with all jobs for this videoId, close the warm-up tab now.
      maybeCloseWarmupTabIfDone(job.url);
      if (noDelayAfter) {
        runNextChannelJob();
      } else {
        scheduleNextChannelJobAfterDelay();
      }
    }
  }
});

function lookupDownloadById(downloadId) {
  return new Promise((resolve) => {
    chrome.downloads.search({ id: downloadId }, (results) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(results && results[0] ? results[0] : null);
    });
  });
}

async function registerDownloadWithLibrary(downloadId, job) {
  if (!job || !job.meta) {
    return false;
  }
  try {
    const downloadItem = await lookupDownloadById(downloadId);
    if (!downloadItem || !downloadItem.filename) {
      return false;
    }
    const payload = {
      videoId: job.meta.videoId,
      title: job.meta.title || downloadItem.filename.split(/[/\\]/).pop() || "",
      normalizedTitle: job.meta.normalizedTitle || null,
      path: downloadItem.filename,
      type: job.meta.assetType === "transcript" ? "transcript" : "video",
      size:
        typeof downloadItem.fileSize === "number" && downloadItem.fileSize >= 0
          ? downloadItem.fileSize
          : job.totalBytes || job.bytesReceived || null,
      mtime: downloadItem.endTime
        ? Date.parse(downloadItem.endTime)
        : downloadItem.startTime
          ? Date.parse(downloadItem.startTime)
          : null,
      source: job.meta.source || (job.isChannel ? "channel" : "single"),
      watchUrl: job.meta.watchUrl || job.url || null,
      shortUrl: job.meta.shortUrl || null,
      thumbnailUrl: job.meta.thumbnailUrl || null,
      channelId: job.meta.channelId || null,
      channelName: job.meta.channelName || null,
      quality: job.meta.quality || null,
      intendedPath: job.filenameHint || null
    };
    return await postLibraryRegister(payload);
  } catch (err) {
    console.warn("[YouTube Downloader] Failed to register download with library", err);
    return false;
  }
}

async function postLibraryRegister(payload) {
  const endpoints = [
    "http://127.0.0.1:8789/api/library/register",
    "http://localhost:8789/api/library/register"
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        return true;
      }
    } catch (err) {
      // try next endpoint
    }
  }
  return false;
}

async function postCatalogRequest(payload) {
  const endpoints = [
    "http://127.0.0.1:8789/api/youtube/catalog/request",
    "http://localhost:8789/api/youtube/catalog/request"
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        return true;
      }
    } catch {
      // try next endpoint
    }
  }
  return false;
}

function normalizeJobMeta(meta) {
  if (!meta || typeof meta !== "object") {
    return null;
  }
  return {
    videoId: typeof meta.videoId === "string" ? meta.videoId : null,
    title: typeof meta.title === "string" ? meta.title : null,
    normalizedTitle: typeof meta.normalizedTitle === "string" ? meta.normalizedTitle : null,
    assetType: meta.assetType === "transcript" ? "transcript" : "video",
    source: typeof meta.source === "string" ? meta.source : null,
    watchUrl: typeof meta.watchUrl === "string" ? meta.watchUrl : null,
    shortUrl: typeof meta.shortUrl === "string" ? meta.shortUrl : null,
    thumbnailUrl: typeof meta.thumbnailUrl === "string" ? meta.thumbnailUrl : null,
    channelId: typeof meta.channelId === "string" ? meta.channelId : null,
    channelName: typeof meta.channelName === "string" ? meta.channelName : null,
    quality: typeof meta.quality === "string" ? meta.quality : null
  };
}


