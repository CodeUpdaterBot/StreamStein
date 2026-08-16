export function parseChannelRangeSelection(input, total) {
  const set = new Set();
  if (!input || typeof input !== "string") return set;
  const parts = input.split(",");
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const single = part.match(/^(\d+)$/);
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let start = Number(range[1]);
      let end = Number(range[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (start > end) [start, end] = [end, start];
      for (let i = start; i <= end; i++) {
        if (i >= 1 && i <= total) set.add(i);
      }
    } else if (single) {
      const idx = Number(single[1]);
      if (Number.isFinite(idx) && idx >= 1 && idx <= total) {
        set.add(idx);
      }
    }
  }
  return set;
}

export function formatVideoEntry(raw, index = 0) {
  if (!raw) return null;
  const id = typeof raw === "string" ? raw : raw.id || raw.videoId;
  if (!id) return null;
  const rawTitle = raw.title || raw.recordedTitle || `Video ${index + 1}`;
  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: rawTitle,
    normalizedTitle:
      raw.normalizedTitle ||
      (typeof rawTitle === "string"
        ? rawTitle
            .toLowerCase()
            .replace(/[^\w\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        : "")
  };
}

export function normalizeVideoList(input) {
  if (!Array.isArray(input)) return [];
  const result = [];
  input.forEach((item, idx) => {
    const entry = formatVideoEntry(item, idx);
    if (entry) result.push(entry);
  });
  return result;
}

export function applyChannelSelection(entries, selection) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  const total = list.length;
  if (!total) return [];

  const rangesStr =
    typeof selection?.ranges === "string"
      ? selection.ranges.trim()
      : typeof selection === "object" && selection.rangesInput
        ? selection.rangesInput?.value?.trim?.() || ""
        : "";

  if (rangesStr) {
    const keepSet = parseChannelRangeSelection(rangesStr, total);
    if (!keepSet.size) return [];
    const result = [];
    for (let i = 1; i <= total; i++) {
      if (keepSet.has(i)) result.push(list[i - 1]);
    }
    return result;
  }

  const skipFirst =
    selection?.skipFirst !== undefined
      ? clampNumber(selection.skipFirst, 0, total, 0)
      : clampNumber(selection?.skipFirstInput?.value ?? 0, 0, total, 0);
  const skipLast =
    selection?.skipLast !== undefined
      ? clampNumber(selection.skipLast, 0, total, 0)
      : clampNumber(selection?.skipLastInput?.value ?? 0, 0, total, 0);

  const start = Math.min(skipFirst, total);
  const endCut = Math.min(skipLast, total - start);
  return list.slice(start, total - endCut);
}

export function deriveChannelHint(channelUrl) {
  try {
    const u = new URL(channelUrl);
    const withoutVideos = u.pathname.replace(/\/(videos?|streams?)\/?$/i, "");
    const parts = withoutVideos.split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "";
    return last.replace(/^@/, "");
  } catch {
    return "";
  }
}

export function computeChannelKey(channelUrl) {
  try {
    const u = new URL(channelUrl);
    const withoutVideos = u.pathname.replace(/\/(videos?|streams?)\/?$/i, "");
    const parts = withoutVideos.split("/").filter(Boolean);
    if (parts[0] === "channel" && parts[1]) return parts[1];
    if (parts[0]?.startsWith("@")) return parts[0].slice(1);
    const hint = parts[parts.length - 1] || "";
    return hint.replace(/^@/, "") || deriveChannelHint(channelUrl);
  } catch {
    return deriveChannelHint(channelUrl);
  }
}

export function snapshotChannelSelection({
  limitInput,
  skipFirstInput,
  skipLastInput,
  rangesInput,
  onlyMissingCheckbox,
  missingTranscriptsCheckbox,
  excludedVideoIds
}) {
  return {
    limit: clampNumber(limitInput?.value ?? 20, 1, 500, 20),
    skipFirst: clampNumber(skipFirstInput?.value ?? 0, 0, 500, 0),
    skipLast: clampNumber(skipLastInput?.value ?? 0, 0, 500, 0),
    ranges: rangesInput?.value?.trim?.() || "",
    excludedVideoIds: Array.from(excludedVideoIds || []),
    onlyMissing: onlyMissingCheckbox?.checked !== false,
    missingTranscripts: Boolean(missingTranscriptsCheckbox?.checked)
  };
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
