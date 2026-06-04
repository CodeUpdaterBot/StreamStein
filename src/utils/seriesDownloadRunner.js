/**
 * TV series batch download — mirrors manual flow per episode:
 * 1) Open embed in persist:player webview (same as clicking an episode)
 * 2) Capture m3u8 via webRequest → m3u8-found (same as watching)
 * 3) runDownload({ m3u8Url }) (same as Download modal → Start)
 */

function episodeLabel(ep) {
  return `S${String(ep.uiSeason ?? ep.season).padStart(2, "0")}E${String(ep.uiEpisode ?? ep.episode).padStart(2, "0")}`;
}

function buildMediaName(showTitle, year, ep) {
  const s = String(ep.uiSeason ?? ep.season).padStart(2, "0");
  const e = String(ep.uiEpisode ?? ep.episode).padStart(2, "0");
  return `${showTitle}${year ? ` (${year})` : ""} S${s} E${e}`;
}

/** Only skip truly done or actively downloading — not stale queued rows from failed runs. */
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

/**
 * @param {object} job
 * @param {object} deps
 * @param {(opts: object) => Promise<{ok:boolean,url?:string,error?:string,sourceId?:string}>} deps.captureEpisodeStream
 * @param {(p: object) => void} [deps.onProgress]
 * @param {(entry: object) => void} [deps.onDownloadStarted]
 * @param {AbortSignal} [deps.signal]
 */
export async function runSeriesDownload(job, deps) {
  const {
    captureEpisodeStream,
    onProgress,
    onDownloadStarted,
    signal,
  } = deps;

  const batchId = crypto.randomUUID();
  const errors = [];
  let staged = 0;
  let skipped = 0;
  const total = job.episodes.length;

  const report = (patch) => {
    onProgress?.({
      phase: "running",
      batchId,
      total,
      staged,
      skipped,
      errors: [...errors],
      ...patch,
    });
  };

  report({ phase: "starting", message: "Preparing series download…" });

  let downloads = [];
  try {
    downloads = (await window.electron.getDownloads()) || [];
  } catch {
    downloads = [];
  }

  // Remove stuck queued/resolving rows from earlier failed batch attempts
  let clearedStale = 0;
  for (const d of downloads) {
    if (
      d.tmdbId === job.tmdbId &&
      d.mediaType === "tv" &&
      (d.status === "queued" || d.status === "resolving")
    ) {
      try {
        await window.electron.deleteDownload({ id: d.id, filePath: null });
        clearedStale++;
      } catch {}
    }
  }
  if (clearedStale > 0) {
    try {
      downloads = (await window.electron.getDownloads()) || [];
    } catch {
      downloads = [];
    }
    report({
      phase: "starting",
      message: `Cleared ${clearedStale} stuck queued item(s) from a previous attempt…`,
    });
  }

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
      report({
        phase: "skipped",
        current: label,
        index: i + 1,
      });
      continue;
    }

    report({
      phase: "resolving",
      current: label,
      index: i + 1,
      message: `Playing ${label} in embed player to capture stream…`,
    });

    const captured = await captureEpisodeStream({
      isAnime: job.isAnime,
      title: job.animeTitle || job.showTitle,
      season: ep.season,
      episode: ep.episode,
      tmdbId: job.tmdbId,
      sources: job.sources,
      dubMode: job.dubMode,
      signal,
    });

    if (signal?.aborted) {
      report({ phase: "cancelled" });
      await window.electron.cancelSeriesDownload?.({ batchId });
      return { ok: true, batchId, staged, skipped, errors, cancelled: true };
    }

    if (!captured?.ok || !captured.url) {
      errors.push({
        season: ep.season,
        episode: ep.episode,
        label,
        error: captured?.error || "Could not capture stream link",
      });
      report({
        phase: "error_episode",
        current: label,
        index: i + 1,
      });
      continue;
    }

    const name = buildMediaName(job.showTitle, job.year, ep);

    report({
      phase: "downloading",
      current: label,
      index: i + 1,
      message: `Starting download for ${label}…`,
    });

    const result = await window.electron.runDownload({
      token: job.token,
      m3u8Url: captured.url,
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
        season: ep.season,
        episode: ep.episode,
        label,
        error: result?.error || "Failed to queue download",
      });
      continue;
    }

    staged++;
    const queued = !!result.queued;
    onDownloadStarted?.({
      id: result.id,
      name,
      m3u8Url: captured.url,
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

    report({
      phase: "staged",
      current: label,
      index: i + 1,
    });

    await new Promise((r) => setTimeout(r, 300));
  }

  report({
    phase: "finished",
    message:
      errors.length > 0
        ? `${staged} started, ${skipped} skipped, ${errors.length} failed.`
        : `${staged} episode(s) added to downloads${skipped ? `, ${skipped} skipped` : ""}.`,
  });

  return { ok: true, batchId, staged, skipped, errors, cancelled: false };
}
