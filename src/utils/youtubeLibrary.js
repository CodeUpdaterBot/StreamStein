// Renderer-side helpers for the YouTube library page.

import { formatBytes } from "./storage";

export const YOUTUBE_PROGRESS_PREFIX = "yt_";

export function youtubeProgressKey(recordId) {
  return `${YOUTUBE_PROGRESS_PREFIX}${recordId}`;
}

export function getYoutubeThumbnail(record) {
  if (record.thumbnailUrl) return record.thumbnailUrl;
  if (record.videoId) {
    return `https://i.ytimg.com/vi/${encodeURIComponent(record.videoId)}/hqdefault.jpg`;
  }
  return null;
}

/** True when the library entry is missing YouTube thumbnail / ID metadata. */
export function needsYoutubeMetadataSync(record) {
  if (!record?.fileExists) return false;
  if (record.metadataTestClone) return true;
  return !getYoutubeThumbnail(record);
}

export function formatYoutubeDate(isoOrMs) {
  if (!isoOrMs) return "";
  const d =
    typeof isoOrMs === "number"
      ? new Date(isoOrMs)
      : new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function filterYoutubeVideos(videos, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return videos;
  return videos.filter((v) => {
    const haystack = [
      v.title,
      v.channelName,
      v.libraryChannel,
      v.youtubeChannelName,
      v.fileName,
      v.directory,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

export function sortYoutubeVideos(videos, sortBy, sortDir) {
  const dir = sortDir === "asc" ? 1 : -1;
  return [...videos].sort((a, b) => {
    let cmp = 0;
    if (sortBy === "date") {
      const aT = a.mtime || Date.parse(a.completedAt) || 0;
      const bT = b.mtime || Date.parse(b.completedAt) || 0;
      cmp = aT - bT;
    } else if (sortBy === "name") {
      cmp = (a.title || "").localeCompare(b.title || "");
    } else if (sortBy === "size") {
      cmp = (a.size || 0) - (b.size || 0);
    } else if (sortBy === "channel") {
      cmp = (a.channelName || "").localeCompare(b.channelName || "");
      if (cmp === 0) cmp = (a.title || "").localeCompare(b.title || "");
    }
    return cmp * dir;
  });
}

export function groupYoutubeByChannel(videos) {
  const map = new Map();
  for (const v of videos) {
    const key = v.channelName || "Uncategorized";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(v);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([channelName, items]) => ({ channelName, items }));
}

function formatDurationSeconds(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return "";
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function formatVideoMeta(record) {
  const parts = [];
  if (record.size != null) parts.push(formatBytes(record.size));
  const dur = formatDurationSeconds(record.durationSeconds);
  if (dur) parts.push(dur);
  const date = formatYoutubeDate(record.completedAt || record.mtime);
  if (date) parts.push(date);
  if (record.quality) parts.push(record.quality);
  return parts.join(" · ");
}
