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

  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  playerSession.setUserAgent(UA);
  trailerSession.setUserAgent(UA);

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

      if (
        url.includes(".m3u8") ||
        (streamResolver.isResolverWebContents(details.webContentsId) &&
          (url.includes(".mp4") || url.includes(".webm")))
      ) {
        streamResolver.notifyMediaUrl(details.webContentsId, url);
      }
      const mw = getMainWindow();
      if (mw && !mw.isDestroyed()) {
        if (url.includes(".m3u8")) {
          mw.webContents.send("m3u8-found", {
            url,
            webContentsId: details.webContentsId,
          });
        } else if (url.includes(".vtt")) {
          const { extractSubtitleLang } = require("./subtitles");
          mw.webContents.send("subtitle-found", {
            url,
            lang: extractSubtitleLang(url),
          });
        }
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
  for (const domain of [".youtube.com", ".youtube-nocookie.com"]) {
    const cookie = { ...ytCookie, domain };
    trailerSession.cookies.set(cookie).catch(() => {});
    playerSession.cookies.set(cookie).catch(() => {});
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
