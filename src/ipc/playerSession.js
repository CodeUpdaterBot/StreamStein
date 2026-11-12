// ── persist:player / persist:trailer session setup (ad block + media intercept) ─
// Must run before background stream resolution or any webview loads media URLs.

const { session } = require("electron");

let _configured = false;
/** @type {object | null} */
let _deps = null;

/**
 * @param {object} deps
 * @param {() => import('electron').BrowserWindow | null} deps.getMainWindow
 * @param {{ notifyMediaUrl: Function, isResolverWebContents: Function }} deps.streamResolver
 * @param {{ recordBlockedRequest: Function }} deps.blockStats
 * @param {string[]} deps.blockedHosts
 */
function configurePlayerSessions(deps) {
  if (_configured) return;
  _configured = true;

  try {
    require("./localMedia").ensureHttpServer();
  } catch {}

  const { getMainWindow, streamResolver, blockStats, blockedHosts } = deps;
  const playerSession = session.fromPartition("persist:player");
  const trailerSession = session.fromPartition("persist:trailer");

  const stripHeaders = (details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === "x-frame-options" || lower === "content-security-policy")
        delete headers[key];
    }
    callback({ responseHeaders: headers });
  };

  // ── User agent ──────────────────────────────────────────────────────────────
  // Do NOT spoof a UA on the player session. Upstream removed this deliberately
  // ("fix failed cloudflare challenge", streambert 44682f5): the player webview
  // starts loading BEFORE setUserAgent() takes effect, so the first player of a
  // session used Electron's real UA and passed Cloudflare Turnstile, while every
  // later player got the modified UA and failed with error 600010.
  //
  // Per-source UAs are still available where a host genuinely needs one: sources
  // flagged `cleanUserAgent` (e.g. vidfast) are loaded with a UA passed at
  // loadURL / the <webview> `useragent` attribute (see buildCleanUserAgent() in
  // index.js, exposed to the renderer as window.electron.cleanUserAgent).
  // playerSession.setUserAgent(...) intentionally NOT called.

  // No browser downloads from player/trailer pages: video and subtitle downloads
  // go exclusively through the app's own download manager, never the webview.
  const blockDownloads = (event) => event.preventDefault();
  playerSession.on("will-download", blockDownloads);
  trailerSession.on("will-download", blockDownloads);

  playerSession.webRequest.onHeadersReceived(
    { urls: ["*://*/*"] },
    stripHeaders,
  );
  trailerSession.webRequest.onHeadersReceived(
    { urls: ["*://*/*"] },
    stripHeaders,
  );

  trailerSession.webRequest.onBeforeRequest(
    { urls: blockedHosts },
    (_, cb) => cb({ cancel: true }),
  );

  const MEDIA_URLS = [
    "*://*/*.m3u8*",
    "*://*/*.m3u8",
    "*://*/*.vtt*",
    "*://*/*.vtt",
  ];

  // Capture Cookie/Referer/Origin from the live request that successfully hits the CDN.
  // onBeforeRequest cannot see request headers; onBeforeSendHeaders can.
  /** @type {Map<string, { headers: Record<string,string>, at: number }>} */
  const recentMediaHeaders = new Map();

  const pickRequestHeaders = (requestHeaders) => {
    const out = {};
    if (!requestHeaders) return out;
    for (const [k, v] of Object.entries(requestHeaders)) {
      const lower = String(k).toLowerCase();
      if (
        lower === "cookie" ||
        lower === "referer" ||
        lower === "origin" ||
        lower === "user-agent" ||
        lower === "authorization"
      ) {
        out[k] = Array.isArray(v) ? v.join("; ") : String(v || "");
      }
    }
    return out;
  };

  playerSession.webRequest.onBeforeSendHeaders(
    { urls: MEDIA_URLS },
    (details, callback) => {
      try {
        if (details.url?.includes(".m3u8")) {
          const headers = pickRequestHeaders(details.requestHeaders);
          recentMediaHeaders.set(details.url, {
            headers,
            at: Date.now(),
          });
          if (recentMediaHeaders.size > 40) {
            const oldest = [...recentMediaHeaders.entries()].sort(
              (a, b) => a[1].at - b[1].at,
            )[0];
            if (oldest) recentMediaHeaders.delete(oldest[0]);
          }

          streamResolver.notifyMediaUrl(details.webContentsId, details.url);
          const mw = getMainWindow();
          if (mw && !mw.isDestroyed()) {
            mw.webContents.send("m3u8-found", {
              url: details.url,
              webContentsId: details.webContentsId,
              requestHeaders: headers,
            });
          }
        }
      } catch {}
      callback({ requestHeaders: details.requestHeaders });
    },
  );

  playerSession.webRequest.onBeforeRequest(
    { urls: [...blockedHosts, ...MEDIA_URLS] },
    (details, callback) => {
      const { url } = details;
      const isMedia = url.includes(".m3u8") || url.includes(".vtt");
      if (!isMedia) {
        blockStats.recordBlockedRequest(url);
        callback({ cancel: true });
        return;
      }
      try {
        const host = new URL(url).hostname;
        const blocked = blockedHosts.some((pat) => {
          const hostPat = pat.replace(/^\*:\/\//, "").split("/")[0];
          return hostPat.startsWith("*.")
            ? host.endsWith(hostPat.slice(1))
            : host === hostPat || host === hostPat.replace(/^\*\./, "");
        });
        if (blocked) {
          blockStats.recordBlockedRequest(url);
          callback({ cancel: true });
          return;
        }
      } catch {}

      // m3u8 notify happens in onBeforeSendHeaders (has Cookie/Referer).
      // Still notify resolver for non-m3u8 media used by hidden resolver.
      if (
        !url.includes(".m3u8") &&
        streamResolver.isResolverWebContents(details.webContentsId) &&
        (url.includes(".mp4") || url.includes(".webm"))
      ) {
        streamResolver.notifyMediaUrl(details.webContentsId, url);
      }
      const mw = getMainWindow();
      if (mw && !mw.isDestroyed() && url.includes(".vtt")) {
        const { extractSubtitleLang } = require("./subtitles");
        mw.webContents.send("subtitle-found", {
          url,
          lang: extractSubtitleLang(url),
        });
      }
      callback({});
    },
  );

  const ytCookie = {
    url: "https://www.youtube.com",
    name: "SOCS",
    value: "CAI",
    path: "/",
    secure: true,
    httpOnly: false,
    sameSite: "no_restriction",
    expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 2,
  };
  // Scoped to the trailer session only (upstream narrowed this in 44682f5): YouTube
  // content is only ever embedded in the trailer webview.
  for (const domain of [".youtube.com", ".youtube-nocookie.com"]) {
    const cookie = { ...ytCookie, domain };
    trailerSession.cookies.set(cookie).catch(() => {});
  }
}

function registerPlayerSessionDeps(deps) {
  _deps = deps;
}

function ensurePlayerSessions() {
  if (_deps) configurePlayerSessions(_deps);
}

module.exports = {
  configurePlayerSessions,
  registerPlayerSessionDeps,
  ensurePlayerSessions,
};
