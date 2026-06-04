/**
 * Build grouped, MediaCard-compatible items from completed downloads and scanned local files.
 */

function stripEpisodeSuffix(name) {
  if (!name) return "";
  return name.replace(/\s*S\d{1,2}E\d{1,3}.*$/i, "").trim() || name;
}

function dlSortTs(d) {
  return d.completedAt || d.startedAt || 0;
}

/** Raw union of finished registry entries + folder-scanned files not in the registry. */
export function getRawLocalEntries(downloads, localFiles) {
  const finished = (downloads || []).filter(
    (d) =>
      d.status !== "downloading" &&
      d.status !== "queued" &&
      d.status !== "resolving",
  );
  const localFileItems = (localFiles || []).map((f) => ({
    id: f.filePath,
    name: f.name,
    filePath: f.filePath,
    size: f.size,
    status: "local",
    isLocalOnly: true,
  }));
  const finishedPaths = new Set(finished.map((d) => d.filePath).filter(Boolean));
  const extraLocal = localFileItems.filter(
    (lf) => !finishedPaths.has(lf.filePath),
  );
  return [...finished, ...extraLocal];
}

function isEntryVisible(d, fileExistsCache) {
  if (d.isLocalOnly) return true;
  if (d.status === "completed" && d.filePath) {
    return fileExistsCache[d.id] !== false;
  }
  return d.status === "completed" || d.status === "local";
}

function dlToTrackedMediaItem(d, mediaType) {
  const displayName = stripEpisodeSuffix(d.name) || d.name;
  return {
    id: d.tmdbId,
    media_type: mediaType,
    title: mediaType === "movie" ? displayName : undefined,
    name: mediaType === "tv" ? displayName : undefined,
    poster_path: d.posterPath || null,
    localInstall: true,
    _sortTs: dlSortTs(d),
    _isUntracked: false,
  };
}

function dlToUntrackedMediaItem(d) {
  const name = d.name || "Local file";
  return {
    id: d.id || d.filePath,
    media_type: "local",
    title: name,
    name,
    poster_path: null,
    localInstall: true,
    _sortTs: dlSortTs(d),
    _isUntracked: true,
    _filePath: d.filePath,
    _downloadId: d.isLocalOnly ? null : d.id,
  };
}

/**
 * @param {object[]} rawEntries — from getRawLocalEntries
 * @param {Record<string, boolean>} fileExistsCache — download id → exists
 * @returns {object[]} items for MediaCard / carousel (newest first)
 */
export function groupLocalLibraryForDisplay(rawEntries, fileExistsCache = {}) {
  const visible = rawEntries.filter((d) => isEntryVisible(d, fileExistsCache));

  const movies = new Map();
  const series = new Map();
  const untracked = [];

  for (const d of visible) {
    if (d.isLocalOnly || !d.tmdbId || !d.mediaType) {
      untracked.push(dlToUntrackedMediaItem(d));
      continue;
    }

    if (d.mediaType === "movie") {
      const key = `movie_${d.tmdbId}`;
      const existing = movies.get(key);
      const ts = dlSortTs(d);
      if (!existing || ts > (existing._sortTs || 0)) {
        movies.set(key, dlToTrackedMediaItem(d, "movie"));
      }
      continue;
    }

    if (d.mediaType === "tv") {
      const key = `tv_${d.tmdbId}`;
      let entry = series.get(key);
      const ts = dlSortTs(d);
      if (!entry) {
        entry = {
          ...dlToTrackedMediaItem(d, "tv"),
          localEpisodeCount: 1,
        };
        series.set(key, entry);
      } else {
        entry.localEpisodeCount = (entry.localEpisodeCount || 1) + 1;
        if (ts > (entry._sortTs || 0)) {
          entry._sortTs = ts;
          if (d.posterPath) entry.poster_path = d.posterPath;
          const displayName = stripEpisodeSuffix(d.name);
          if (displayName) entry.name = displayName;
        }
      }
    }
  }

  const tracked = [
    ...movies.values(),
    ...series.values(),
  ];
  const all = [...tracked, ...untracked];
  all.sort((a, b) => (b._sortTs || 0) - (a._sortTs || 0));
  return all;
}

export const LOCAL_FILES_CHANGED = "streamstein:local-files-changed";
