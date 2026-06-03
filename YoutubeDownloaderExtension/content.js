const BRIDGE_SOURCE = "yt-saver-bridge";
const REQUEST_TYPE = "YT_SAVER_PROXY_FETCH";
const RESPONSE_TYPE = "YT_SAVER_PROXY_FETCH_RESPONSE";

injectProxyScript();

window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }

  const data = event.data;
  if (!data || data.source !== BRIDGE_SOURCE || data.type !== REQUEST_TYPE) {
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: "PROXY_FETCH",
      request: data.request
    },
    (response) => {
      const runtimeError = chrome.runtime.lastError;
      const payload = runtimeError
        ? { ok: false, error: runtimeError.message || "Proxy fetch failed." }
        : response || { ok: false, error: "Empty proxy fetch response." };

      window.postMessage(
        {
          source: BRIDGE_SOURCE,
          type: RESPONSE_TYPE,
          id: data.id,
          response: payload
        },
        "*"
      );
    }
  );
});

function injectProxyScript() {
  const inject = () => {
    const existing = document.querySelector(
      `script[data-source="${BRIDGE_SOURCE}"]`
    );
    if (existing) {
      return;
    }

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("injected.js");
    script.dataset.source = BRIDGE_SOURCE;
    script.type = "module";
    script.onload = () => {
      script.remove();
    };
    document.documentElement.appendChild(script);
  };

  if (document.documentElement) {
    inject();
  } else {
    window.addEventListener("DOMContentLoaded", inject, { once: true });
  }
}

// =====================
// Channel collector (scroll + scrape)
// =====================

function normalizeTitleKey(input = "") {
  return input
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function preferText(node) {
  if (!node || typeof node.textContent !== "string") {
    return "";
  }
  return node.textContent.trim();
}

function extractVideoTitle(anchor) {
  if (!anchor) return "";
  const titleAttr = anchor.getAttribute("title");
  if (titleAttr && titleAttr.trim()) {
    return titleAttr.trim();
  }
  const ariaLabel = anchor.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim()) {
    const cleaned = ariaLabel.replace(/\s+\d+\s+(hours?|minutes?|seconds?).*$/i, "").trim();
    if (cleaned) return cleaned;
  }
  const lockupTitle = preferText(
    anchor.querySelector(
      ".ytAttributedStringHost, #video-title, .ytLockupMetadataViewModelTitle span"
    )
  );
  if (lockupTitle) {
    return lockupTitle;
  }
  const innerTitle = preferText(anchor.querySelector("#video-title"));
  if (innerTitle) {
    return innerTitle;
  }
  const lockupHost = anchor.closest(
    ".ytLockupViewModelHost, ytd-rich-item-renderer, ytd-rich-grid-video-renderer"
  );
  if (lockupHost) {
    const heading = lockupHost.querySelector(
      "h3[title], .ytLockupMetadataViewModelTitle, a.ytLockupMetadataViewModelTitle"
    );
    const headingTitle =
      heading?.getAttribute?.("title")?.trim() ||
      preferText(heading?.querySelector?.(".ytAttributedStringHost")) ||
      preferText(heading);
    if (headingTitle) {
      return headingTitle;
    }
  }
  const renderer = anchor.closest(
    "ytd-rich-grid-video-renderer,ytd-rich-item-renderer,ytd-grid-video-renderer,ytd-playlist-video-renderer,ytd-compact-video-renderer"
  );
  if (renderer) {
    const rendererTitle = preferText(renderer.querySelector("#video-title"));
    if (rendererTitle) {
      return rendererTitle;
    }
    const attributed = preferText(
      renderer.querySelector("#video-title .yt-core-attributed-string")
    );
    if (attributed) {
      return attributed;
    }
  }
  const siblingTitle = preferText(anchor.parentElement?.querySelector("#video-title"));
  if (siblingTitle) {
    return siblingTitle;
  }
  const text = preferText(anchor);
  if (text) {
    return text;
  }
  return "";
}

function gatherChannelVideos() {
  const anchors = Array.from(
    document.querySelectorAll(
      'a#video-title-link[href*="/watch?v="], a[href*="/watch?v="], a.ytLockupMetadataViewModelTitle[href*="/watch?v="]'
    )
  );
  const map = new Map();
  for (const a of anchors) {
    try {
      const href = a.getAttribute("href") || a.href || "";
      const url = new URL(href, location.origin);
      const v = url.searchParams.get("v");
      if (!v || v.length !== 11 || map.has(v)) continue;
      const title = extractVideoTitle(a);
      map.set(v, {
        id: v,
        url: `https://www.youtube.com/watch?v=${v}`,
        title,
        normalizedTitle: normalizeTitleKey(title)
      });
    } catch {}
  }
  return Array.from(map.values());
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "YT_SAVER_COLLECT_CHANNEL_VIDEOS") {
    collectAllChannelVideoIds(message?.maxScrolls, message?.idleRounds, message?.waitMs)
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({ ok: false, error: err?.message || "Collector failed." })
      );
    return true;
  } else if (message?.type === "YT_SAVER_START_COLLECT") {
    startLiveCollector(message?.maxScrolls, message?.idleRounds, message?.waitMs)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err?.message || "Start failed." }));
    return true;
  } else if (message?.type === "YT_SAVER_STOP_COLLECT") {
    stopLiveCollector();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

async function collectAllChannelVideoIds(maxScrolls = 60, idleRounds = 3, waitMs = 900) {
  if (!isYouTubeChannelPage()) {
    return { ok: false, error: "Not on a YouTube channel page." };
  }

  const getVideos = () => gatherChannelVideos();

  let lastCount = 0;
  let stagnant = 0;

  for (let i = 0; i < maxScrolls; i++) {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(waitMs);
    const current = getVideos().length;
    if (current > lastCount) {
      lastCount = current;
      stagnant = 0;
    } else {
      stagnant++;
      if (stagnant >= idleRounds) {
        break;
      }
    }
  }

  const finalVideos = getVideos();
  const finalIds = finalVideos.map((video) => video.id);
  return { ok: true, ids: finalIds, videos: finalVideos, count: finalIds.length };
}

// Live collector with progress updates
let liveCollector = null;

async function startLiveCollector(maxScrolls = 80, idleRounds = 3, waitMs = 900) {
  if (!isYouTubeChannelPage()) {
    return { ok: false, error: "Not on a YouTube channel page." };
  }
  if (liveCollector?.running) {
    return { ok: true, note: "Already running" };
  }
  const getVideos = () => gatherChannelVideos();

  liveCollector = { running: true, stop: false };
  let lastCount = 0;
  let stagnant = 0;

  for (let i = 0; i < maxScrolls && !liveCollector.stop; i++) {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(waitMs);
    const videos = getVideos();
    const current = videos.length;

    chrome.runtime.sendMessage({
      type: "YT_SAVER_COLLECT_PROGRESS",
      count: current,
      done: false,
      url: location.href
    });

    if (current > lastCount) {
      lastCount = current;
      stagnant = 0;
    } else {
      stagnant++;
      if (stagnant >= idleRounds) {
        break;
      }
    }
  }

  const finalVideos = getVideos();
  const finalIds = finalVideos.map((video) => video.id);
  liveCollector.running = false;
  chrome.runtime.sendMessage({
    type: "YT_SAVER_COLLECT_PROGRESS",
    count: finalIds.length,
    done: true,
    url: location.href,
    ids: finalIds,
    videos: finalVideos
  });
  return { ok: true, count: finalIds.length };
}

function stopLiveCollector() {
  if (liveCollector) {
    liveCollector.stop = true;
  }
}

function isYouTubeChannelPage() {
  try {
    const { hostname, pathname } = location;
    if (!hostname.includes("youtube.com")) return false;
    if (pathname.includes("/watch") || pathname.includes("/shorts")) return false;
    return pathname.includes("/@") || pathname.startsWith("/channel/") || pathname.startsWith("/c/") || pathname.startsWith("/user/");
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}


