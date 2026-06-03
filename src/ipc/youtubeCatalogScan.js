// Disk-authoritative YouTube catalog sync: scan library folder, repair stale paths,
// merge bridge metadata, and align youtube-catalog.json with files on disk.

const fs = require("fs");
const path = require("path");
const toolPaths = require("./toolPaths");
const {
  stripWindowsDuplicateBasename,
  canonicalGroupKey,
} = require("./youtubeCatalogDedupe");

const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm", ".m4v", ".avi", ".mov"]);
const TRANSCRIPT_EXTS = new Set([".srt", ".vtt", ".ass", ".ssa"]);

const CATALOG_VERSION = 1;
const CATALOG_SCHEMA = "yt-saver-youtube-catalog";

function normalizePath(p) {
  if (!p || typeof p !== "string") return "";
  return path.normalize(p);
}

function pathKey(filePath) {
  return normalizePath(filePath).toLowerCase();
}

function basenameNoExt(filePath) {
  const base = path.basename(filePath || "");
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function defaultCatalog() {
  return {
    version: CATALOG_VERSION,
    schema: CATALOG_SCHEMA,
    updatedAt: new Date().toISOString(),
    records: [],
  };
}

function loadCatalogFile(catalogPath) {
  try {
    if (!fs.existsSync(catalogPath)) return defaultCatalog();
    const parsed = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    if (Array.isArray(parsed?.records)) return parsed;
  } catch {
    // fall through
  }
  return defaultCatalog();
}

function getMirrorCatalogPath() {
  return path.join(toolPaths.resolveBridgeRoot(), "youtube-catalog.json");
}

function saveCatalogFile(catalogPath, catalog) {
  catalog.version = CATALOG_VERSION;
  catalog.schema = CATALOG_SCHEMA;
  catalog.updatedAt = new Date().toISOString();
  const payload = JSON.stringify(catalog, null, 2);
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(catalogPath, payload, "utf8");

  const mirror = getMirrorCatalogPath();
  if (path.resolve(catalogPath) !== path.resolve(mirror)) {
    try {
      fs.mkdirSync(path.dirname(mirror), { recursive: true });
      fs.writeFileSync(mirror, payload, "utf8");
    } catch {
      // mirror is best-effort
    }
  }
}

function walkMediaFiles(root, maxDepth = 12) {
  const videos = [];
  const transcripts = [];
  if (!root || !fs.existsSync(root)) {
    return { videos, transcripts };
  }

  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name === "youtube-catalog.json" || name.startsWith(".")) continue;
      const fullPath = path.join(dir, name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(name).toLowerCase();
      if (VIDEO_EXTS.has(ext)) videos.push(fullPath);
      else if (TRANSCRIPT_EXTS.has(ext)) transcripts.push(fullPath);
    }
  };

  walk(root, 0);
  return { videos, transcripts };
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

function buildIndexByPath(records) {
  const byPath = new Map();
  for (const r of records) {
    if (!r?.filePath) continue;
    const key = pathKey(r.filePath);
    const prev = byPath.get(key);
    if (!prev || (prev.metadataTestClone && !r.metadataTestClone)) {
      byPath.set(key, r);
    }
  }
  return byPath;
}

function buildCanonicalIndex(records, assetType) {
  const index = new Map();
  for (const r of records) {
    if (!r?.filePath || r.assetType !== assetType || r.metadataTestClone) continue;
    const key = canonicalGroupKey(r);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(r);
  }
  return index;
}

function loadBridgeCatalogRecords() {
  const mirror = getMirrorCatalogPath();
  const catalog = loadCatalogFile(mirror);
  return Array.isArray(catalog.records) ? catalog.records : [];
}

function loadBridgeCatalogByPath() {
  return buildIndexByPath(loadBridgeCatalogRecords());
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function fileExistsOnDisk(filePath) {
  if (!filePath) return false;
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function adoptRecordForCatalog(record, filePath) {
  const now = new Date().toISOString();
  const stats = safeStat(filePath);
  const ext = path.extname(filePath).toLowerCase() || null;
  return {
    ...record,
    filePath: normalizePath(filePath),
    fileName: path.basename(filePath),
    directory: normalizePath(path.dirname(filePath)),
    extension: ext || record.extension || null,
    size: stats?.size ?? record.size ?? null,
    mtime: stats?.mtimeMs ?? record.mtime ?? null,
    status: record.status || "completed",
    updatedAt: now,
    completedAt: record.completedAt || now,
  };
}

function createVideoRecord(filePath, youtubeRoot) {
  const now = new Date().toISOString();
  const stats = safeStat(filePath);
  const { channelName, channelKey } = deriveChannelFromDir(filePath, youtubeRoot);
  const title = basenameNoExt(filePath);
  return {
    id: `yt-scan-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    status: "completed",
    videoId: null,
    watchUrl: null,
    shortUrl: null,
    thumbnailUrl: null,
    title,
    normalizedTitle: null,
    channelId: null,
    channelName,
    channelKey,
    assetType: "video",
    fileName: path.basename(filePath),
    filePath: normalizePath(filePath),
    intendedPath: null,
    directory: normalizePath(path.dirname(filePath)),
    extension: path.extname(filePath).toLowerCase() || null,
    size: stats?.size ?? null,
    mtime: stats?.mtimeMs ?? null,
    source: "disk-scan",
    quality: null,
    libraryEntryId: null,
    requestedAt: now,
    completedAt: now,
    updatedAt: now,
  };
}

function createTranscriptRecord(filePath, youtubeRoot) {
  const now = new Date().toISOString();
  const stats = safeStat(filePath);
  const { channelName, channelKey } = deriveChannelFromDir(filePath, youtubeRoot);
  return {
    id: `yt-scan-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    status: "completed",
    videoId: null,
    watchUrl: null,
    shortUrl: null,
    thumbnailUrl: null,
    title: basenameNoExt(filePath),
    normalizedTitle: null,
    channelId: null,
    channelName,
    channelKey,
    assetType: "transcript",
    fileName: path.basename(filePath),
    filePath: normalizePath(filePath),
    intendedPath: null,
    directory: normalizePath(path.dirname(filePath)),
    extension: path.extname(filePath).toLowerCase() || null,
    size: stats?.size ?? null,
    mtime: stats?.mtimeMs ?? null,
    source: "disk-scan",
    quality: null,
    libraryEntryId: null,
    requestedAt: now,
    completedAt: now,
    updatedAt: now,
  };
}

function pickBestCatalogMatch(candidates, filePath) {
  const library = (candidates || []).filter((r) => !r.metadataTestClone);
  if (!library.length) return null;
  const exists = library.filter((r) => fileExistsOnDisk(r.filePath));
  const pool = exists.length ? exists : library;
  const exact = pool.find((r) => pathKey(r.filePath) === pathKey(filePath));
  if (exact) return exact;
  return pool.sort((a, b) => {
    const score = (r) =>
      (r.videoId ? 4 : 0) +
      (r.thumbnailUrl ? 2 : 0) +
      (r.metadataEnrichedAt ? 1 : 0) +
      (fileExistsOnDisk(r.filePath) ? 8 : 0);
    return score(b) - score(a);
  })[0];
}

function findCatalogMatchForDiskFile(filePath, assetType, byPath, canonicalIndex, bridgeByPath) {
  const key = pathKey(filePath);
  if (byPath.has(key)) return { record: byPath.get(key), source: "path" };

  const bridge = bridgeByPath.get(key);
  if (bridge && bridge.assetType === assetType) {
    return { record: bridge, source: "bridge-path" };
  }

  const probe = { filePath, directory: path.dirname(filePath), assetType };
  const cKey = canonicalGroupKey(probe);
  if (cKey && canonicalIndex.has(cKey)) {
    const match = pickBestCatalogMatch(canonicalIndex.get(cKey), filePath);
    if (match) return { record: match, source: "canonical" };
  }

  if (bridge && bridge.assetType === assetType) {
    return { record: bridge, source: "bridge" };
  }

  return null;
}

/**
 * Rebuild catalog video/transcript rows so every on-disk file has an entry and stale
 * ghost rows (missing files in folders that were re-scanned) are removed.
 */
function syncCatalogFromDisk(youtubeRoot, catalogPath) {
  const root = normalizePath(youtubeRoot);
  const catalog = loadCatalogFile(catalogPath);
  const bridgeByPath = loadBridgeCatalogByPath();
  const byPath = buildIndexByPath(catalog.records);
  const videoCanonical = buildCanonicalIndex(catalog.records, "video");
  const transcriptCanonical = buildCanonicalIndex(catalog.records, "transcript");

  const { videos, transcripts } = walkMediaFiles(root);
  const diskVideoKeys = new Set(videos.map(pathKey));
  const diskTranscriptKeys = new Set(transcripts.map(pathKey));

  let videosAdded = 0;
  let transcriptsAdded = 0;
  let pathsRepaired = 0;
  let restoredFromBridge = 0;
  let ghostsRemoved = 0;

  const claimedIds = new Set();
  const claimedCanonical = new Set();
  const claimedVideoIds = new Set();
  const nextRecords = [];

  const upsertDiskFile = (filePath, assetType, createBare, canonicalIndex) => {
    const match = findCatalogMatchForDiskFile(
      filePath,
      assetType,
      byPath,
      canonicalIndex,
      bridgeByPath,
    );

    let record;
    if (match?.record) {
      const prevPath = match.record.filePath;
      record = adoptRecordForCatalog(match.record, filePath);
      if (match.source.startsWith("bridge")) restoredFromBridge += 1;
      if (pathKey(prevPath) !== pathKey(filePath)) pathsRepaired += 1;
    } else {
      record = createBare(filePath, root);
      if (assetType === "video") videosAdded += 1;
      else transcriptsAdded += 1;
    }

    const folderChannel = deriveChannelFromDir(filePath, root);
    record.channelName = folderChannel.channelName;
    record.channelKey = folderChannel.channelKey;

    if (claimedIds.has(record.id)) {
      const bare = createBare(filePath, root);
      record = {
        ...record,
        id: bare.id,
        filePath: record.filePath,
        fileName: record.fileName,
        title: record.title || bare.title,
      };
      record = adoptRecordForCatalog(record, filePath);
      if (assetType === "video") videosAdded += 1;
      else transcriptsAdded += 1;
    }

    claimedIds.add(record.id);
    const cKey = canonicalGroupKey(record);
    if (cKey) claimedCanonical.add(cKey);
    if (record.videoId) claimedVideoIds.add(String(record.videoId));
    nextRecords.push(record);
    byPath.set(pathKey(filePath), record);
  };

  for (const filePath of videos) {
    upsertDiskFile(filePath, "video", createVideoRecord, videoCanonical);
  }
  for (const filePath of transcripts) {
    upsertDiskFile(
      filePath,
      "transcript",
      createTranscriptRecord,
      transcriptCanonical,
    );
  }

  const keptOrphans = [];
  for (const r of catalog.records) {
    if (claimedIds.has(r.id)) continue;

    if (r.metadataTestClone) {
      keptOrphans.push(r);
      continue;
    }

    const completedVideo =
      r.assetType === "video" &&
      r.status === "completed" &&
      r.filePath &&
      VIDEO_EXTS.has((r.extension || path.extname(r.filePath)).toLowerCase());

    if (completedVideo && !fileExistsOnDisk(r.filePath)) {
      const cKey = canonicalGroupKey(r);
      const vid = r.videoId ? String(r.videoId) : "";
      if (
        (cKey && claimedCanonical.has(cKey)) ||
        (vid && claimedVideoIds.has(vid))
      ) {
        ghostsRemoved += 1;
        continue;
      }
    }

    if (
      r.assetType === "transcript" &&
      r.filePath &&
      !fileExistsOnDisk(r.filePath) &&
      !diskTranscriptKeys.has(pathKey(r.filePath))
    ) {
      ghostsRemoved += 1;
      continue;
    }

    keptOrphans.push(r);
  }

  catalog.records = [...nextRecords, ...keptOrphans];

  const changed =
    videosAdded > 0 ||
    transcriptsAdded > 0 ||
    pathsRepaired > 0 ||
    ghostsRemoved > 0 ||
    restoredFromBridge > 0;

  if (changed) {
    saveCatalogFile(catalogPath, catalog);
  }

  const catalogVideos = catalog.records.filter(
    (r) => r.assetType === "video" && r.status === "completed",
  ).length;

  return {
    ok: true,
    folder: root,
    videosAdded,
    transcriptsAdded,
    pathsRepaired,
    restoredFromBridge,
    ghostsRemoved,
    videosOnDisk: videos.length,
    transcriptsOnDisk: transcripts.length,
    catalogVideos,
    catalogPath,
    saved: changed,
  };
}

module.exports = {
  syncCatalogFromDisk,
  walkMediaFiles,
  loadCatalogFile,
  saveCatalogFile,
};
