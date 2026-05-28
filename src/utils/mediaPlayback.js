/**
 * Media playback source model for in-app local .mp4 vs streaming embeds.
 *
 * sourceType: "local" | "stream"
 * availability: "local-only" | "stream-only" | "both" | "none"
 */

const MP4_RE = /\.mp4$/i;

export function isLocalMp4Path(filePath) {
  return !!filePath && MP4_RE.test(filePath);
}

/**
 * Find a completed download entry for the given TMDB item.
 * @param {object[]} downloads
 * @param {{ mediaType: "movie"|"tv", tmdbId: number, season?: number, episode?: number }} query
 */
export function findLocalDownloadCandidate(downloads, query) {
  if (!downloads?.length || !query?.tmdbId) return null;

  const matchEpisode = (dl) => {
    if (query.mediaType !== "tv") return true;
    const s = query.season;
    const e = query.episode;
    if (s == null || e == null) return false;
    return (
      String(dl.season ?? "") === String(s) &&
      String(dl.episode ?? "") === String(e)
    );
  };

  const baseMatch = (dl) =>
    dl.mediaType === query.mediaType &&
    (dl.tmdbId === query.tmdbId || dl.mediaId === query.tmdbId) &&
    dl.status === "completed" &&
    dl.filePath &&
    isLocalMp4Path(dl.filePath) &&
    matchEpisode(dl);

  return downloads.find(baseMatch) || null;
}

/**
 * @param {object|null} localDownload
 * @param {boolean} fileExists
 */
export function buildMediaPlaybackDescriptor(
  localDownload,
  fileExists,
  { streamAvailable = true } = {},
) {
  const hasLocal = !!(localDownload?.filePath && fileExists);
  const hasStream = !!streamAvailable;

  let availability = "none";
  if (hasLocal && hasStream) availability = "both";
  else if (hasLocal) availability = "local-only";
  else if (hasStream) availability = "stream-only";

  return {
    availability,
    hasLocal,
    hasStream,
    localPath: hasLocal ? localDownload.filePath : null,
    localDownload: hasLocal ? localDownload : null,
    sourceType: hasLocal ? "local" : hasStream ? "stream" : null,
  };
}

/** User preference: null = auto (prefer local), "local" | "stream" */
export function resolveEffectivePlaybackMode(descriptor, userPreference) {
  if (!descriptor) return "stream";
  const { availability, hasLocal, hasStream } = descriptor;

  if (userPreference === "local" && hasLocal) return "local";
  if (userPreference === "stream" && hasStream) return "stream";

  if (availability === "both" || availability === "local-only") {
    if (hasLocal) return "local";
  }
  return "stream";
}

export function canTogglePlaybackMode(descriptor) {
  return descriptor?.availability === "both";
}

export function playbackModeStorageKey(progressKey) {
  return `playbackMode_${progressKey}`;
}
