// Create a bare-bones catalog clone for metadata-sync testing (same file on disk).

const fs = require("fs");
const path = require("path");
const { probeVideoDurationSeconds } = require("./youtubeDurationProbe");
const { loadCatalogFile, saveCatalogFile } = require("./youtubeCatalogScan");

const META_TEST_SUFFIX_RE = /\s*\[meta test(?:\s*\d+)?\]\s*$/i;

function normalizePath(p) {
  if (!p || typeof p !== "string") return "";
  return path.normalize(p);
}

function deriveChannelFromDir(filePath, youtubeRoot) {
  const rel = path.relative(
    normalizePath(youtubeRoot),
    normalizePath(path.dirname(filePath)),
  );
  const segment =
    rel && rel !== "." && !rel.startsWith("..")
      ? rel.split(path.sep).filter(Boolean)[0]
      : "";
  const channelName = segment || "Uncategorized";
  const channelKey = channelName.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return { channelName, channelKey };
}

function stripMetaTestSuffix(title) {
  return String(title || "Video")
    .replace(META_TEST_SUFFIX_RE, "")
    .trim() || "Video";
}

function buildUniqueTestTitle(records, sourceTitle) {
  const base = stripMetaTestSuffix(sourceTitle);
  const existing = new Set(
    records
      .filter((r) => r.metadataTestClone && r.title)
      .map((r) => String(r.title).toLowerCase()),
  );
  let candidate = `${base} [meta test]`;
  if (!existing.has(candidate.toLowerCase())) return candidate;
  for (let n = 2; n < 100; n += 1) {
    candidate = `${base} [meta test ${n}]`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} [meta test ${Date.now()}]`;
}

function createBareTestClone(source, youtubeRoot, records) {
  const now = new Date().toISOString();
  const filePath = normalizePath(source.filePath);
  const stats = (() => {
    try {
      return fs.statSync(filePath);
    } catch {
      return null;
    }
  })();
  const folderChannel = deriveChannelFromDir(filePath, youtubeRoot);
  const durationSeconds =
    source.durationSeconds != null
      ? source.durationSeconds
      : probeVideoDurationSeconds(filePath);

  const title = buildUniqueTestTitle(
    records,
    source.title || path.basename(filePath),
  );

  return {
    id: `yt-metatest-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    status: "completed",
    videoId: null,
    watchUrl: null,
    shortUrl: null,
    thumbnailUrl: null,
    title,
    normalizedTitle: null,
    channelId: null,
    channelName: folderChannel.channelName,
    channelKey: folderChannel.channelKey,
    assetType: "video",
    fileName: path.basename(filePath),
    filePath,
    intendedPath: null,
    directory: normalizePath(path.dirname(filePath)),
    extension: (source.extension || path.extname(filePath)).toLowerCase() || null,
    size: stats?.size ?? source.size ?? null,
    mtime: stats?.mtimeMs ?? source.mtime ?? null,
    durationSeconds: durationSeconds ?? null,
    source: "metadata-test-clone",
    quality: source.quality || null,
    libraryEntryId: null,
    requestedAt: now,
    completedAt: now,
    updatedAt: now,
    metadataTestClone: true,
    metadataTestSourceId: source.id,
    metadataEnrichedAt: null,
    metadataEnrichedBy: null,
  };
}

/**
 * Add a metadata-test catalog row pointing at the same file as the source video.
 */
function cloneCatalogRecordForMetadataTest(youtubeRoot, catalogPath, sourceRecordId) {
  const root = normalizePath(youtubeRoot);
  const catalog = loadCatalogFile(catalogPath);
  const records = catalog.records || [];

  const source = records.find(
    (r) =>
      r.id === sourceRecordId &&
      r.assetType === "video" &&
      r.status === "completed" &&
      r.filePath,
  );
  if (!source) {
    return { ok: false, error: "Source video not found in catalog." };
  }
  if (!fs.existsSync(source.filePath)) {
    return { ok: false, error: "Source video file is missing on disk." };
  }
  if (source.metadataTestClone) {
    return {
      ok: false,
      error: "Clone a library video, not an existing metadata test entry.",
    };
  }

  const clone = createBareTestClone(source, root, records);
  catalog.records.push(clone);
  saveCatalogFile(catalogPath, catalog);

  return {
    ok: true,
    record: clone,
    recordId: clone.id,
    title: clone.title,
    sourceRecordId: source.id,
  };
}

module.exports = {
  cloneCatalogRecordForMetadataTest,
  stripMetaTestSuffix,
};
