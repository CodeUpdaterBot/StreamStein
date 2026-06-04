import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from "react";
import { getSourceUrl } from "../utils/api";
import { storage } from "../utils/storage";
import {
  deliverM3u8ToBatch,
  reserveM3u8Capture,
} from "../utils/m3u8Capture";
import { pickBestMediaUrl } from "../utils/streamMedia";
import { TRIGGER_PLAY_JS } from "../utils/playerAutomation";
import {
  pauseTvPlayersForSeriesCapture,
  resumeTvPlayersAfterSeriesCapture,
} from "../utils/seriesCaptureEvents";
import { runSeriesDownload } from "../utils/seriesDownloadRunner";

const StreamCaptureContext = createContext(null);

const RESOLVE_TIMEOUT_MS = 75000;
const URL_SETTLE_MS = 3200;
const DEFAULT_SOURCES = ["videasy", "vidsrc"];

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getWebviewId(wv) {
  try {
    const id = wv?.getWebContentsId?.();
    return id && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function waitForWebview(wv, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    if (!wv) {
      reject(new Error("Player webview not mounted"));
      return;
    }
    const existing = getWebviewId(wv);
    if (existing) {
      resolve({ wv, webContentsId: existing });
      return;
    }
    const onReady = () => {
      const id = getWebviewId(wv);
      if (id) {
        cleanup();
        resolve({ wv, webContentsId: id });
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Player webview timed out while starting"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      try {
        wv.removeEventListener("dom-ready", onReady);
      } catch {}
    };
    try {
      wv.addEventListener("dom-ready", onReady);
    } catch {
      cleanup();
      reject(new Error("Could not attach to player webview"));
    }
  });
}

export function StreamCaptureProvider({ children }) {
  const webviewRef = useRef(null);
  const batchWcIdRef = useRef(null);

  useEffect(() => {
    if (!window.electron?.onM3u8Found) return;
    const handler = (payload) => {
      const url = typeof payload === "string" ? payload : payload?.url;
      const webContentsId =
        typeof payload === "object" ? payload?.webContentsId : undefined;
      deliverM3u8ToBatch(url, webContentsId);
    };
    const h = window.electron.onM3u8Found(handler);
    return () => window.electron.offM3u8Found?.(h);
  }, []);

  const captureFromEmbed = useCallback(
    async (sourceId, tmdbId, season, episode, signal) => {
      const { wv, webContentsId } = await waitForWebview(webviewRef.current);
      batchWcIdRef.current = webContentsId;
      const pageUrl = getSourceUrl(sourceId, "tv", tmdbId, season, episode);

      return new Promise((resolve) => {
        let settled = false;
        let releaseCapture = () => {};
        let autoTimer = null;
        let settleTimer = null;
        let domHandler = null;
        let finishLoadHandler = null;

        const finish = (url) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          clearTimeout(settleTimer);
          clearInterval(autoTimer);
          releaseCapture();
          signal?.removeEventListener("abort", onAbort);
          try {
            if (domHandler) wv.removeEventListener("dom-ready", domHandler);
            if (finishLoadHandler)
              wv.removeEventListener("did-finish-load", finishLoadHandler);
          } catch {}
          resolve(url || null);
        };

        const onAbort = () => finish(null);
        signal?.addEventListener("abort", onAbort);

        const scheduleSettle = (urls) => {
          const best = pickBestMediaUrl(urls);
          if (!best) return;
          clearTimeout(settleTimer);
          settleTimer = setTimeout(() => finish(best), URL_SETTLE_MS);
        };

        releaseCapture = reserveM3u8Capture((_url, allUrls) => {
          scheduleSettle(allUrls);
        }, webContentsId);

        const runAutomation = () => {
          if (signal?.aborted) return;
          try {
            const wcId = getWebviewId(wv) || webContentsId;
            if (wcId && window.electron?.automateEmbedPlayer) {
              window.electron.automateEmbedPlayer(wcId).catch(() => {});
            }
            wv.executeJavaScript?.(TRIGGER_PLAY_JS).catch(() => {});
          } catch {}
        };

        domHandler = () => runAutomation();
        finishLoadHandler = () => runAutomation();

        const timeout = setTimeout(() => {
          finish(null);
        }, RESOLVE_TIMEOUT_MS);

        try {
          wv.addEventListener("dom-ready", domHandler);
          wv.addEventListener("did-finish-load", finishLoadHandler);
        } catch {}

        autoTimer = setInterval(runAutomation, 1800);

        (async () => {
          try {
            wv.stop?.();
          } catch {}
          try {
            wv.src = "about:blank";
          } catch {}
          await delay(600);
          if (signal?.aborted) {
            finish(null);
            return;
          }
          runAutomation();
          try {
            wv.src = pageUrl;
          } catch {
            finish(null);
          }
        })();
      });
    },
    [],
  );

  const captureEpisodeStream = useCallback(
    async ({
      isAnime,
      title,
      season,
      episode,
      tmdbId,
      sources,
      dubMode,
      signal,
    }) => {
      if (signal?.aborted) return { ok: false, error: "Cancelled" };

      if (isAnime) {
        const r = await window.electron.resolveAllManga({
          title,
          seasonNumber: season,
          episodeNumber: episode,
          translationType: dubMode === "dub" ? "dub" : "sub",
        });
        if (r?.ok && r.url) return { ok: true, url: r.url, sourceId: "allmanga" };
        return { ok: false, error: r?.error || "AllManga resolve failed" };
      }

      const sourceList =
        sources?.length > 0
          ? sources
          : storage.get("playerSource")
            ? [storage.get("playerSource")]
            : DEFAULT_SOURCES;

      let lastError = "No stream URL captured from embed player";
      for (const sourceId of sourceList) {
        if (signal?.aborted) return { ok: false, error: "Cancelled" };
        const url = await captureFromEmbed(
          sourceId,
          tmdbId,
          season,
          episode,
          signal,
        );
        if (url) return { ok: true, url, sourceId };
        lastError = `No stream from ${sourceId} for S${season}E${episode}`;
        await delay(500);
      }
      return { ok: false, error: lastError };
    },
    [captureFromEmbed],
  );

  const runBatchCapture = useCallback(
    async (job, { onProgress, onDownloadStarted, signal }) => {
      pauseTvPlayersForSeriesCapture();
      await delay(400);
      try {
        return await runSeriesDownload(job, {
          captureEpisodeStream,
          onProgress,
          onDownloadStarted,
          signal,
        });
      } finally {
        resumeTvPlayersAfterSeriesCapture();
        try {
          const wv = webviewRef.current;
          if (wv) wv.src = "about:blank";
        } catch {}
      }
    },
    [captureEpisodeStream],
  );

  const value = {
    captureEpisodeStream,
    runBatchCapture,
    batchWebContentsId: () => batchWcIdRef.current,
  };

  if (!window.electron) {
    return (
      <StreamCaptureContext.Provider value={value}>
        {children}
      </StreamCaptureContext.Provider>
    );
  }

  return (
    <StreamCaptureContext.Provider value={value}>
      {children}
      <webview
        ref={webviewRef}
        src="about:blank"
        partition="persist:player"
        allowpopups="false"
        sandbox="allow-scripts allow-same-origin allow-forms"
        style={{
          position: "fixed",
          width: 960,
          height: 540,
          left: -980,
          top: -560,
          opacity: 0.03,
          pointerEvents: "none",
          zIndex: -1,
        }}
        tabIndex={-1}
      />
    </StreamCaptureContext.Provider>
  );
}

export function useStreamCapture() {
  const ctx = useContext(StreamCaptureContext);
  if (!ctx) {
    throw new Error("useStreamCapture must be used within StreamCaptureProvider");
  }
  return ctx;
}
