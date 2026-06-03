// Read/update a single row in youtube-catalog.json.

const fs = require("fs");
const path = require("path");
const { saveCatalogFile, loadCatalogFile } = require("./youtubeCatalogScan");

const EDITABLE_STRING_KEYS = new Set([
  "status",
  "videoId",
  "watchUrl",
  "shortUrl",
  "thumbnailUrl",
  "title",
  "normalizedTitle",
  "channelId",
  "channelName",
  "channelKey",
  "fileName",
  "filePath",
  "intendedPath",
  "directory",
  "extension",
  "source",
  "quality",
  "libraryEntryId",
  "requestedAt",
  "completedAt",
  "metadataEnrichedAt",
  "metadataEnrichedBy",
]);

const EDITABLE_NUMBER_KEYS = new Set(["size", "mtime", "durationSeconds"]);

const READ_ONLY_KEYS = new Set([
  "id",
  "assetType",
  "metadataTestClone",
  "metadataTestSourceId",
]);

function trimOrNull(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}

function parseOptionalNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildYoutubeUrls(videoId) {
  const id = trimOrNull(videoId);
  if (!id) return { watchUrl: null, shortUrl: null, thumbnailUrl: null };
  return {
    watchUrl: `https://www.youtube.com/watch?v=${id}`,
    shortUrl: `https://youtu.be/${id}`,
    thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  };
}

function sanitizeRecordPatch(patch) {
  if (!patch || typeof patch !== "object") return {};
  const out = {};
  for (const key of EDITABLE_STRING_KEYS) {
    if (!(key in patch)) continue;
    out[key] = trimOrNull(patch[key]);
  }
  for (const key of EDITABLE_NUMBER_KEYS) {
    if (!(key in patch)) continue;
    out[key] = parseOptionalNumber(patch[key]);
  }
  return out;
}

function applyPatchToRecord(record, patch) {
  const next = { ...record, ...patch, id: record.id, assetType: record.assetType };
  const now = new Date().toISOString();
  next.updatedAt = now;

  if (patch.videoId !== undefined) {
    const urls = buildYoutubeUrls(next.videoId);
    if (!patch.watchUrl && !record.watchUrl) next.watchUrl = urls.watchUrl;
    if (!patch.shortUrl && !record.shortUrl) next.shortUrl = urls.shortUrl;
    if (!patch.thumbnailUrl && !record.thumbnailUrl) {
      next.thumbnailUrl = urls.thumbnailUrl;
    }
  }

  if (patch.title !== undefined && patch.normalizedTitle === undefined) {
    next.normalizedTitle = next.title
      ? String(next.title).toLowerCase().replace(/\s+/g, " ").trim()
      : null;
  }

  if (next.filePath) {
    next.filePath = path.normalize(next.filePath);
    next.fileName = next.fileName || path.basename(next.filePath);
    next.directory = next.directory || path.dirname(next.filePath);
    next.extension =
      next.extension || path.extname(next.filePath).toLowerCase() || null;
    try {
      if (fs.existsSync(next.filePath)) {
        const st = fs.statSync(next.filePath);
        if (patch.size === undefined) next.size = st.size;
        if (patch.mtime === undefined) next.mtime = st.mtimeMs;
      }
    } catch {
      // keep user values
    }
  }

  return next;
}

function getCatalogRecord(catalog, recordId) {
  if (!catalog?.records || !recordId) return null;
  return catalog.records.find((r) => r.id === recordId) || null;
}

function updateCatalogRecord(catalogPath, recordId, patch) {
  const catalog = loadCatalogFile(catalogPath);
  const record = getCatalogRecord(catalog, recordId);
  if (!record) {
    return { ok: false, error: "Entry not found in catalog." };
  }
  if (record.assetType !== "video") {
    return { ok: false, error: "Only video entries can be edited here." };
  }

  const sanitized = sanitizeRecordPatch(patch);
  const keys = Object.keys(sanitized);
  if (!keys.length) {
    return { ok: false, error: "No changes to save." };
  }

  const idx = catalog.records.findIndex((r) => r.id === recordId);
  catalog.records[idx] = applyPatchToRecord(record, sanitized);
  saveCatalogFile(catalogPath, catalog);

  return {
    ok: true,
    record: catalog.records[idx],
    recordId,
  };
}

module.exports = {
  sanitizeRecordPatch,
  applyPatchToRecord,
  updateCatalogRecord,
  getCatalogRecord,
  EDITABLE_STRING_KEYS,
  EDITABLE_NUMBER_KEYS,
  READ_ONLY_KEYS,
};
