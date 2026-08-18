// ── Background stream URL resolver (Videasy / VidSrc embeds) ─────────────────
// Loads the same embed URLs as the in-app webview, automates play/server clicks,
// and captures m3u8/mp4 via persist:player webRequest (see playerSession.js).

const { BrowserWindow } = require("electron");
const crypto = require("crypto");
const { scheduleEmbedAutomation } = require("./embedAutomation");

const RESOLVE_TIMEOUT_MS = 55000;
const EARLY_SETTLE_MS = 2200;
// Keep aligned with src/utils/api.js PLAYER_SOURCES (Jun 2026 upstream domain migrations).
const SOURCE_ORDER_DEFAULT = ["videasy", "vidsrc", "vidking"];

const EMBED_URLS = {
  videasy: {
    tv: (id, season, ep) =>
      `https://player.videasy.to/tv/${id}/${season}/${ep}`,
    movie: (id) => `https://player.videasy.to/movie/${id}`,
  },
  vidsrc: {
    tv: (id, season, ep) =>
      `https://vsembed.su/embed/tv/${id}/${season}/${ep}`,
    movie: (id) => `https://vsembed.su/embed/movie/${id}`,
  },
  vidking: {
    tv: (id, season, ep) =>
      `https://www.vidking.net/embed/tv/${id}/${season}/${ep}`,
    movie: (id) => `https://www.vidking.net/embed/movie/${id}`,
  },
};

/** @type {import('./playerSession')} */
let _playerSession = null;

/** requestId → pending state */
const _pending = new Map();
/** webContentsId → Set<requestId> */
const _wcToRequests = new Map();

/** Reused hidden player — avoids spawning 30+ windows per series batch */
let _resolverWin = null;

function bindPlayerSession(playerSessionModule) {
  _playerSession = playerSessionModule;
}

function _ensureSessions() {
  if (_playerSession?.ensurePlayerSessions) {
    // configure() is idempotent; deps registered once from index.js
    _playerSession.ensurePlayerSessions();
  }
}

function _embedUrl(sourceId, mediaType, tmdbId, season, episode) {
  const src = EMBED_URLS[sourceId];
  if (!src) return null;
  return mediaType === "tv"
    ? src.tv(tmdbId, season, episode)
    : src.movie(tmdbId);
}

function _qualityScore(url) {
  const u = url.toLowerCase();
  if (/preview|trailer|sample|thumb/i.test(u)) return -100;
  if (/1080|1920x|2160|4k/.test(u)) return 100;
  if (/720/.test(u)) return 72;
  if (/480/.test(u)) return 48;
  if (/360/.test(u)) return 30;
  if (/\.m3u8/.test(u)) return 55;
  if (/\.mp4/.test(u)) return 60;
  return 20;
}

function pickBestMediaUrl(urls) {
  const uniq = [...new Set(urls.filter(Boolean))];
  if (!uniq.length) return null;
  uniq.sort((a, b) => _qualityScore(b) - _qualityScore(a));
  const best = uniq[0];
  const bestScore = _qualityScore(best);
  if (bestScore < 48) {
    const hd = uniq.find((u) => _qualityScore(u) >= 72);
    if (hd) return hd;
  }
  return best;
}

function isResolverWebContents(webContentsId) {
  if (webContentsId == null) return false;
  return _wcToRequests.has(webContentsId);
}

function _scheduleEarlyFinish(reqId) {
  const p = _pending.get(reqId);
  if (!p || p.done) return;
  const best = pickBestMediaUrl(p.urls);
  if (!best || _qualityScore(best) < 30) return;

  clearTimeout(p.earlyTimer);
  p.earlyTimer = setTimeout(() => {
    const cur = _pending.get(reqId);
    if (!cur || cur.done) return;
    const settled = pickBestMediaUrl(cur.urls);
    if (settled) {
      _finishRequest(reqId, {
        ok: true,
        url: settled,
        sourceId: cur.sourceId,
      });
    }
  }, EARLY_SETTLE_MS);
}

function notifyMediaUrl(webContentsId, url) {
  if (!url || webContentsId == null) return;
  const ids = _wcToRequests.get(webContentsId);
  if (!ids?.size) return;
  const lower = url.toLowerCase();
  if (
    !lower.includes(".m3u8") &&
    !lower.includes(".mp4") &&
    !lower.includes(".webm")
  )
    return;
  if (/preview|trailer|sample/i.test(lower)) return;

  for (const reqId of ids) {
    const p = _pending.get(reqId);
    if (p && !p.done) {
      p.urls.push(url);
      _scheduleEarlyFinish(reqId);
    }
  }
}

function _finishRequest(reqId, result) {
  const p = _pending.get(reqId);
  if (!p || p.done) return;
  p.done = true;
  clearTimeout(p.timer);
  clearTimeout(p.earlyTimer);
  if (p.stopAutomation) p.stopAutomation();

  const wcId = p.win?.webContents?.id;
  if (wcId != null) {
    const set = _wcToRequests.get(wcId);
    if (set) {
      set.delete(reqId);
      if (!set.size) _wcToRequests.delete(wcId);
    }
  }
  _pending.delete(reqId);
  try {
    const wc = p.win?.webContents;
    if (wc && !wc.isDestroyed()) {
      wc.stop();
      wc.loadURL("about:blank").catch(() => {});
    }
  } catch {}
  p.resolve(result);
}

function _getResolverWindow() {
  _ensureSessions();
  if (_resolverWin && !_resolverWin.isDestroyed()) return _resolverWin;

  _resolverWin = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      partition: "persist:player",
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  _resolverWin.webContents.setAudioMuted(true);
  return _resolverWin;
}

function resolveFromEmbed(opts) {
  const {
    sourceId,
    mediaType = "tv",
    tmdbId,
    season,
    episode,
    timeoutMs = RESOLVE_TIMEOUT_MS,
  } = opts;
  const pageUrl = _embedUrl(sourceId, mediaType, tmdbId, season, episode);
  if (!pageUrl) {
    return Promise.resolve({ ok: false, error: `Unknown source: ${sourceId}` });
  }

  return new Promise((resolve) => {
    const reqId = crypto.randomUUID();
    const win = _getResolverWindow();
    const wc = win.webContents;

    const entry = {
      urls: [],
      win,
      done: false,
      resolve,
      sourceId,
      timer: null,
      earlyTimer: null,
      stopAutomation: null,
      mainLoadFailed: false,
    };
    _pending.set(reqId, entry);

    const wcId = wc.id;
    if (!_wcToRequests.has(wcId)) _wcToRequests.set(wcId, new Set());
    _wcToRequests.get(wcId).add(reqId);

    entry.stopAutomation = scheduleEmbedAutomation(wc, timeoutMs - 2000, 2000);

    entry.timer = setTimeout(() => {
      const best = pickBestMediaUrl(entry.urls);
      _finishRequest(
        reqId,
        best
          ? { ok: true, url: best, sourceId }
          : {
              ok: false,
              error: entry.mainLoadFailed
                ? "Player page failed to load"
                : "No stream URL captured — try playing the episode manually first",
              sourceId,
            },
      );
    }, timeoutMs);

    const onFailLoad = (_ev, _code, _desc, _url, isMainFrame) => {
      if (isMainFrame === false) return;
      if (!entry.done && entry.urls.length === 0) entry.mainLoadFailed = true;
    };

    const onFinishLoad = () => {
      if (!entry.done) {
        const { runInAllFrames } = require("./embedAutomation");
        runInAllFrames(wc).catch(() => {});
      }
    };

    wc.once("did-fail-load", onFailLoad);
    wc.once("did-finish-load", onFinishLoad);

    wc.loadURL(pageUrl).catch(() => {
      entry.mainLoadFailed = true;
      _finishRequest(reqId, {
        ok: false,
        error: "Failed to open player page",
        sourceId,
      });
    });
  });
}

/**
 * Try sources in order; prefer 1080, accept 720 as fallback.
 */
async function resolveStreamWithFallback(opts) {
  const sources = opts.sources?.length
    ? opts.sources
    : SOURCE_ORDER_DEFAULT;
  const minScore = opts.minQuality === 720 ? 72 : 100;
  const attempts = [];

  for (const sourceId of sources) {
    const r = await resolveFromEmbed({ ...opts, sourceId });
    attempts.push({ sourceId, ...r });
    if (!r.ok || !r.url) continue;
    if (_qualityScore(r.url) >= minScore) {
      return { ok: true, url: r.url, sourceId, attempts };
    }
  }

  const withUrl = attempts.filter((a) => a.ok && a.url);
  if (withUrl.length) {
    const best = withUrl.sort(
      (a, b) => _qualityScore(b.url) - _qualityScore(a.url),
    )[0];
    return {
      ok: true,
      url: best.url,
      sourceId: best.sourceId,
      attempts,
      note: "lower-quality-fallback",
    };
  }

  const last = attempts[attempts.length - 1];
  return {
    ok: false,
    error: last?.error || "Could not resolve stream from any source",
    attempts,
  };
}

function destroyResolverWindow() {
  try {
    if (_resolverWin && !_resolverWin.isDestroyed()) _resolverWin.destroy();
  } catch {}
  _resolverWin = null;
}

module.exports = {
  bindPlayerSession,
  notifyMediaUrl,
  isResolverWebContents,
  resolveFromEmbed,
  resolveStreamWithFallback,
  pickBestMediaUrl,
  destroyResolverWindow,
  SOURCE_ORDER_DEFAULT,
};
