// Deduplicate Windows duplicate files in youtube-catalog.json (safe: never removes primary files).

const fs = require("fs");
const path = require("path");
const { parseDurationSeconds } = require("./youtubeDurationProbe");

const WINDOWS_COPY_SUFFIX_RE = /\s*-\s*Copy(?:\s*\(\d+\))?$/iu;
const WINDOWS_NUMBERED_COPY_RE = /\s*\(\d+\)$/u;

function basenameNoExt(filePath) {
  if (!filePath) return "";
  const base = path.basename(filePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function stripWindowsDuplicateBasename(baseName) {
  let s = String(baseName || "").trim();
  s = s.replace(WINDOWS_COPY_SUFFIX_RE, "");
  s = s.replace(WINDOWS_NUMBERED_COPY_RE, "");
  return s.trim();
}

function isWindowsCopyBasename(baseName) {
  return WINDOWS_COPY_SUFFIX_RE.test(String(baseName || "").trim());
}

function isWindowsNumberedCopyBasename(baseName) {
  return WINDOWS_NUMBERED_COPY_RE.test(String(baseName || "").trim());
}

/** Only these variants may be removed from the catalog / disk — never the primary file. */
function isRemovableDuplicateBasename(baseName) {
  return (
    isWindowsCopyBasename(baseName) || isWindowsNumberedCopyBasename(baseName)
  );
}

function isPreferredCanonicalBasename(baseName) {
  return !isRemovableDuplicateBasename(baseName);
}

function normalizeDir(record) {
  if (!record?.filePath) return "";
  return path.normalize(record.directory || path.dirname(record.filePath));
}

function canonicalGroupKey(record) {
  const dir = normalizeDir(record);
  const base = stripWindowsDuplicateBasename(
    basenameNoExt(record.filePath),
  ).toLowerCase();
  if (!dir || !base) return null;
  return `${dir}::${base}`;
}

function scoreRecordForKeep(record) {
  const base = basenameNoExt(record.filePath);
  let score = 0;
  if (isPreferredCanonicalBasename(base)) score += 100;
  if (record.videoId) score += 20;
  if (record.thumbnailUrl) score += 5;
  if (record.metadataEnrichedAt) score += 3;
  const mtime = Number(record.mtime) || 0;
  return score * 1e15 - mtime;
}

function sizesMatch(a, b) {
  const sa = Number(a?.size);
  const sb = Number(b?.size);
  if (!Number.isFinite(sa) || !Number.isFinite(sb) || sa <= 0 || sb <= 0) {
    return true;
  }
  const diff = Math.abs(sa - sb);
  return diff <= Math.max(1024, sa * 0.01);
}

function durationsMatchRecords(a, b) {
  const da = parseDurationSeconds(a?.durationSeconds);
  const db = parseDurationSeconds(b?.durationSeconds);
  if (!da || !db) return true;
  return Math.abs(da - db) <= Math.max(3, da * 0.03);
}

function pickCanonicalRecord(group) {
  if (!group.length) return null;
  return [...group].sort((a, b) => scoreRecordForKeep(b) - scoreRecordForKeep(a))[0];
}

function relatedTranscriptRecords(records, videoRecord) {
  const dir = normalizeDir(videoRecord);
  const base = stripWindowsDuplicateBasename(
    basenameNoExt(videoRecord.filePath),
  ).toLowerCase();
  return records.filter((r) => {
    if (r.assetType !== "transcript" || !r.filePath) return false;
    const rDir = normalizeDir(r);
    const rBase = stripWindowsDuplicateBasename(
      basenameNoExt(r.filePath),
    ).toLowerCase();
    if (rDir === dir && rBase === base) return true;
    if (videoRecord.videoId && r.videoId === videoRecord.videoId) return true;
    return false;
  });
}

/**
 * Remove duplicate catalog rows for Windows " - Copy" / " (1)" files only.
 * Never removes the primary (canonical) file even if it shares a videoId with a copy.
 *
 * @param {object[]} records
 * @param {{ deleteCopyFiles?: boolean, protectRecordIds?: string[] }} options
 */
function dedupeWindowsCopyRecords(records, options = {}) {
  const deleteCopyFiles = options.deleteCopyFiles === true;
  const protectIds = new Set(
    (options.protectRecordIds || [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  );
  const removedRecords = [];
  const deletedFiles = [];
  const removedIds = new Set();

  const videos = records.filter(
    (r) =>
      r?.status === "completed" &&
      r.assetType === "video" &&
      r.filePath &&
      fs.existsSync(r.filePath),
  );

  const groups = new Map();
  for (const rec of videos) {
    const key = canonicalGroupKey(rec);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const canonical = pickCanonicalRecord(group);
    if (!canonical) continue;

    for (const dup of group) {
      if (dup.id === canonical.id || removedIds.has(dup.id)) continue;
      if (protectIds.has(dup.id) || protectIds.has(canonical.id)) continue;

      const dupBase = basenameNoExt(dup.filePath);

      // CRITICAL: only remove explicit Windows duplicate filenames — never the main file.
      if (!isRemovableDuplicateBasename(dupBase)) continue;
      if (!sizesMatch(canonical, dup)) continue;
      if (!durationsMatchRecords(canonical, dup)) continue;

      removedIds.add(dup.id);
      removedRecords.push(dup);

      for (const tr of relatedTranscriptRecords(records, dup)) {
        removedIds.add(tr.id);
      }

      if (deleteCopyFiles && fs.existsSync(dup.filePath)) {
        try {
          fs.unlinkSync(dup.filePath);
          deletedFiles.push(dup.filePath);
        } catch {
          // catalog row still removed; file may remain on disk
        }
      }
    }
  }

  if (!removedIds.size) {
    return { removedRecords: [], removedCount: 0, deletedFiles: [] };
  }

  const filtered = records.filter((r) => !removedIds.has(r.id));
  records.length = 0;
  records.push(...filtered);

  return {
    removedRecords,
    removedCount: removedRecords.length,
    deletedFiles,
  };
}

module.exports = {
  stripWindowsDuplicateBasename,
  isWindowsCopyBasename,
  isWindowsNumberedCopyBasename,
  isRemovableDuplicateBasename,
  canonicalGroupKey,
  dedupeWindowsCopyRecords,
};
