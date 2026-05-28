/**
 * TV series batch download via the SAME UI path as manual download:
 * click episode → player loads → press play in embed → stream plays (duration) → m3u8 → runDownload
 */

import { pickBestMediaUrl } from "./streamMedia";
import { TRIGGER_PLAY_JS } from "./playerAutomation";

const URL_SETTLE_MS = 3500;
const LOAD_TIMEOUT_MS = 90000;
const PLAY_TIMEOUT_MS = 120000;
const POST_LOAD_PLAY_MS = 2500;

/** Videasy first — matches manual flow and avoids VidSrc empty embeds. */
const SOURCE_PRIORITY = ["videasy", "vidsrc", "2embed"];

function sortSources(sources) {
  const list = [...(sources || [])];
  return list.sort((a, b) => {
    const ia = SOURCE_PRIORITY.indexOf(a);
    const ib = SOURCE_PRIORITY.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

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

async function automatePlay(wv, wcId) {
  try {
    wv?.focus?.();
  } catch {}
  try {
    if (wcId && window.electron?.clickEmbedPlayCenter) {
      await window.electron.clickEmbedPlayCenter(wcId);
    } else if (wcId && window.electron?.automateEmbedPlayer) {
      await window.electron.automateEmbedPlayer(wcId);
    }
  } catch {}
  try {
    await wv?.executeJavaScript?.(TRIGGER_PLAY_JS);
  } catch {}
}

/** @returns {Promise<string|null>} */
async function waitForVideoPlaying(wcId, signal, timeoutMs = PLAY_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) return null;
    try {
      const progress = await window.electron.queryVideoProgress(wcId);
      if (
        progress?.duration > 0 &&
        isFinite(progress.duration) &&
        progress.duration < 60 * 60 * 12
      ) {
        return progress;
      }
    } catch {}
    await delay(2000);
  }
  return null;
}

function shouldSkipEpisode(downloads, tmdbId, season, episode) {
  return downloads.some(
    (d) =>
      d.tmdbId === tmdbId &&
      d.mediaType === "tv" &&
      Number(d.season) === Number(season) &&
      Number(d.episode) === Number(episode) &&
      (d.status === "completed" || d.status === "downloading"),
  );
}

function episodeLabel(ep) {
  return `S${String(ep.uiSeason ?? ep.season).padStart(2, "0")}E${String(ep.uiEpisode ?? ep.episode).padStart(2, "0")}`;
}

function buildMediaName(showTitle, year, ep) {
  const s = String(ep.uiSeason ?? ep.season).padStart(2, "0");
  const e = String(ep.uiEpisode ?? ep.episode).padStart(2, "0");
  return `${showTitle}${year ? ` (${year})` : ""} S${s} E${e}`;
}

/**
 * @param {object} tv — live TV page handles
 * @param {object} job
 * @param {object} deps
 */
export async function runTvSeriesPlayerDownload(tv, job, deps) {
  const { onProgress, onDownloadStarted, signal } = deps;
  const batchId = crypto.randomUUID();
  const errors = [];
  let staged = 0;
  let skipped = 0;
  const total = job.episodes.length;

  const report = (patch) => {
    onProgress?.({
      batchId,
      total,
      staged,
      skipped,
      errors: [...errors],
      ...patch,
    });
  };

  tv.beginBatchCapture?.();

  try {
    report({
      phase: "starting",
      message: "Using TV player (same steps as manual download)…",
    });

    let downloads = (await window.electron.getDownloads()) || [];

    for (const d of downloads) {
      if (
        d.tmdbId === job.tmdbId &&
        d.mediaType === "tv" &&
        (d.status === "queued" || d.status === "resolving")
      ) {
        try {
          await window.electron.deleteDownload({ id: d.id, filePath: null });
        } catch {}
      }
    }
    downloads = (await window.electron.getDownloads()) || [];

    const sourceList = job.isAnime
      ? []
      : sortSources(
          job.sources?.length > 0
            ? job.sources
            : [tv.playerSource || "videasy"],
        );

    for (let i = 0; i < job.episodes.length; i++) {
      if (signal?.aborted) {
        report({ phase: "cancelled" });
        await window.electron.cancelSeriesDownload?.({ batchId });
        return { ok: true, batchId, staged, skipped, errors, cancelled: true };
      }

      const ep = job.episodes[i];
      const label = episodeLabel(ep);

      if (
        job.skipExisting &&
        shouldSkipEpisode(downloads, job.tmdbId, ep.season, ep.episode)
      ) {
        skipped++;
        report({ phase: "skipped", current: label, index: i + 1 });
        continue;
      }

      report({
        phase: "loading",
        current: label,
        index: i + 1,
        message: `Opening ${label} in player (like clicking the episode)…`,
      });

      let capturedUrl = null;
      let usedSource = null;

      if (job.isAnime) {
        report({
          phase: "resolving",
          current: label,
          index: i + 1,
          message: `Resolving ${label} on AllManga…`,
        });
        const r = await window.electron.resolveAllManga({
          title: job.animeTitle || job.showTitle,
          seasonNumber: ep.uiSeason ?? ep.season,
          episodeNumber: ep.uiEpisode ?? ep.episode,
          translationType: job.dubMode === "dub" ? "dub" : "sub",
        });
        if (r?.ok && r.url) {
          capturedUrl = r.url;
          usedSource = "allmanga";
        } else {
          errors.push({
            label,
            error: r?.error || "AllManga resolve failed",
          });
          report({ phase: "error_episode", current: label, index: i + 1 });
          continue;
        }
      } else {
        for (const sourceId of sourceList) {
          if (signal?.aborted) break;

          tv.applyPlayerSource?.(sourceId);

          report({
            phase: "loading",
            current: label,
            index: i + 1,
            message: `Loading ${sourceId} for ${label}…`,
          });

          const loaded = await tv.loadEpisodeInPlayer(ep, { signal, sourceId });
          if (!loaded.ok) {
            continue;
          }

          const wv = tv.getWebview();
          const wcId = getWebviewId(wv);
          if (!wcId) continue;

          await delay(POST_LOAD_PLAY_MS);

          report({
            phase: "playing",
            current: label,
            index: i + 1,
            message: `Starting playback for ${label} (${sourceId}: clicking play)…`,
          });

          const m3u8Promise = tv.waitForBatchM3u8(wcId, signal);

          const playStart = Date.now();
          let videoReady = false;
          while (Date.now() - playStart < PLAY_TIMEOUT_MS) {
            if (signal?.aborted) break;
            await automatePlay(wv, wcId);
            const progress = await waitForVideoPlaying(wcId, signal, 5000);
            if (progress) {
              videoReady = true;
              break;
            }
            await delay(1800);
          }

          if (!videoReady) {
            tv.cancelBatchM3u8?.();
            continue;
          }

          capturedUrl = await m3u8Promise;
          tv.cancelBatchM3u8?.();

          if (capturedUrl) {
            usedSource = sourceId;
            break;
          }
        }

        if (!capturedUrl) {
          errors.push({
            label,
            error: `Could not start stream for ${label} (try playing this episode manually first)`,
          });
          report({ phase: "error_episode", current: label, index: i + 1 });
          await tv.stopPlayer?.();
          continue;
        }
      }

      const name = buildMediaName(job.showTitle, job.year, ep);

      report({
        phase: "downloading",
        current: label,
        index: i + 1,
        message: `Queueing download for ${label}…`,
      });

      const result = await window.electron.runDownload({
        token: job.token,
        m3u8Url: capturedUrl,
        name,
        downloadPath: job.downloadPath,
        mediaId: job.mediaId,
        mediaType: "tv",
        season: ep.season,
        episode: ep.episode,
        posterPath: job.posterPath,
        tmdbId: job.tmdbId,
        subtitles: [],
        seriesBatchId: batchId,
      });

      if (!result?.ok) {
        errors.push({
          label,
          error: result?.error || "Failed to queue download",
        });
        await tv.stopPlayer?.();
        continue;
      }

      staged++;
      const queued = !!result.queued;
      onDownloadStarted?.({
        id: result.id,
        name,
        m3u8Url: capturedUrl,
        downloadPath: job.downloadPath,
        filePath: null,
        status: queued ? "queued" : "downloading",
        progress: 0,
        speed: "",
        size: "",
        totalFragments: 0,
        lastMessage: queued ? "Queued (waiting for a slot)" : "Starting…",
        startedAt: Date.now(),
        completedAt: null,
        mediaId: job.mediaId,
        mediaType: "tv",
        season: ep.season,
        episode: ep.episode,
        posterPath: job.posterPath,
        tmdbId: job.tmdbId,
        seriesBatchId: batchId,
      });

      downloads.push({
        id: result.id,
        tmdbId: job.tmdbId,
        mediaType: "tv",
        season: ep.season,
        episode: ep.episode,
        status: queued ? "queued" : "downloading",
      });

      report({ phase: "staged", current: label, index: i + 1 });
      await tv.stopPlayer?.();
      await delay(400);
    }

    report({
      phase: "finished",
      message:
        errors.length > 0
          ? `${staged} started, ${skipped} skipped, ${errors.length} failed.`
          : `${staged} episode(s) added to downloads${skipped ? `, ${skipped} skipped` : ""}.`,
    });

    return { ok: true, batchId, staged, skipped, errors, cancelled: false };
  } finally {
    tv.endBatchCapture?.();
    await tv.stopPlayer?.();
  }
}
