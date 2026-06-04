// YouTube library IPC — reads the youtube-catalog.json maintained by the
// YouTube Downloader Extension (yt-saver-bridge).

const { ipcMain, app } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  getResolvedLibraryPaths,
  resolveYoutubeFolderArg,
} = require("./libraryPathsMain");
const { stripWindowsDuplicateBasename } = require("./youtubeCatalogDedupe");
const { syncCatalogFromDisk } = require("./youtubeCatalogScan");
const {
  cloneCatalogRecordForMetadataTest,
} = require("./youtubeCatalogTestClone");
const {
  getCatalogRecord,
  updateCatalogRecord,
} = require("./youtubeCatalogEdit");

const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm", ".m4v", ".avi", ".mov"]);
const IN_APP_PLAY_EXTS = new Set([".mp4", ".m4v"]);

function getDefaultYoutubeFolder() {
  try {
    return path.join(app.getPath("downloads"), "YouTube");
  } catch {
    return path.join(os.homedir(), "Downloads", "YouTube");
  }
}

function normalizePath(p) {
  if (!p || typeof p !== "string") return "";
  return path.normalize(p);
}

function readCatalogFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.records)) return parsed;
  } catch {
    // ignore
  }
  return null;
}

function resolveYoutubeFolder(youtubeFolder) {
  const resolved = resolveYoutubeFolderArg(youtubeFolder);
  if (resolved) return resolved;
  return getDefaultYoutubeFolder();
}

function loadRawCatalog(youtubeFolder) {
  const folder = resolveYoutubeFolder(youtubeFolder);
  const primaryPath = path.join(folder, "youtube-catalog.json");

  const catalog = readCatalogFile(primaryPath);
  const catalogPath = primaryPath;

  if (!catalog) {
    return {
      ok: true,
      folder,
      catalogPath: primaryPath,
      catalogExists: false,
      updatedAt: null,
      records: [],
    };
  }

  return {
    ok: true,
    folder,
    catalogPath,
    catalogExists: true,
    updatedAt: catalog.updatedAt || null,
    records: catalog.records,
  };
}

function basenameNoExt(filePath) {
  if (!filePath) return "";
  const base = path.basename(filePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function buildTranscriptIndex(records) {
  const index = new Map();
  for (const r of records) {
    if (r.assetType !== "transcript" || !r.filePath) continue;
    const key = `${normalizePath(r.directory || path.dirname(r.filePath))}::${stripWindowsDuplicateBasename(basenameNoExt(r.filePath)).toLowerCase()}`;
    index.set(key, r.filePath);
  }
  return index;
}

/** Library folder name (first segment under the YouTube root) — used for grouping/search. */
function deriveLibraryChannelName(record, youtubeRoot) {
  const dir = record.directory || (record.filePath ? path.dirname(record.filePath) : "");
  if (dir && youtubeRoot) {
    const rel = path.relative(normalizePath(youtubeRoot), normalizePath(dir));
    if (rel && rel !== "." && !rel.startsWith("..")) {
      const segment = rel.split(path.sep).filter(Boolean)[0];
      if (segment) return segment;
    }
  }
  if (record.channelKey) {
    return record.channelKey
      .replace(/vtt$/i, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return null;
}

/** Display label for the YouTube page — folder name wins over YouTube uploader metadata. */
function deriveChannelLabel(record, youtubeRoot) {
  const libraryChannel = deriveLibraryChannelName(record, youtubeRoot);
  if (libraryChannel) return libraryChannel;
  if (record.channelName) return record.channelName;
  return "Uncategorized";
}

function tryDeleteFile(filePath) {
  if (!filePath || typeof filePath !== "string") {
    return { path: filePath, ok: true, missing: true };
  }
  try {
    if (!fs.existsSync(filePath)) {
      return { path: filePath, ok: true, missing: true };
    }
    fs.unlinkSync(filePath);
    return { path: filePath, ok: true, deleted: true };
  } catch (err) {
    return { path: filePath, ok: false, error: err?.message || String(err) };
  }
}

function enrichVideoRecords(raw, youtubeFolder) {
  const folder = resolveYoutubeFolder(youtubeFolder);
  const catalogRecords = Array.isArray(raw.records) ? raw.records : [];
  const transcriptIndex = buildTranscriptIndex(catalogRecords);

  const videos = catalogRecords
    .filter(
      (r) =>
        r.status === "completed" &&
        r.assetType === "video" &&
        r.filePath &&
        VIDEO_EXTS.has((r.extension || path.extname(r.filePath)).toLowerCase()),
    )
    .map((r) => {
      const ext = (r.extension || path.extname(r.filePath)).toLowerCase();
      const dir = normalizePath(r.directory || path.dirname(r.filePath));
      const tKey = `${dir}::${stripWindowsDuplicateBasename(basenameNoExt(r.filePath)).toLowerCase()}`;
      const transcriptPath = transcriptIndex.get(tKey) || null;
      let fileExists = false;
      try {
        fileExists = fs.existsSync(r.filePath);
      } catch {
        fileExists = false;
      }

      const libraryChannel = deriveLibraryChannelName(r, folder);
      return {
        id: r.id,
        videoId: r.videoId || null,
        title: r.title || r.fileName || path.basename(r.filePath),
        channelName: deriveChannelLabel(r, folder),
        libraryChannel: libraryChannel || deriveChannelLabel(r, folder),
        youtubeChannelName: r.channelName || null,
        channelKey: r.channelKey || null,
        channelId: r.channelId || null,
        watchUrl: r.watchUrl || null,
        shortUrl: r.shortUrl || null,
        thumbnailUrl: r.thumbnailUrl || null,
        filePath: r.filePath,
        fileName: r.fileName || path.basename(r.filePath),
        directory: dir,
        extension: ext,
        size: r.size ?? null,
        mtime: r.mtime ?? null,
        completedAt: r.completedAt || r.updatedAt || null,
        quality: r.quality || null,
        source: r.source || null,
        durationSeconds: r.durationSeconds ?? null,
        metadataTestClone: r.metadataTestClone === true,
        metadataTestSourceId: r.metadataTestSourceId || null,
        transcriptPath,
        fileExists,
        canPlayInApp: IN_APP_PLAY_EXTS.has(ext),
      };
    });

  return videos;
}

const SUBTITLE_EXTS = new Set([".srt", ".vtt", ".ass", ".ssa"]);

function countMediaInFolder(folderPath, maxDepth = 3) {
  let videos = 0;
  let subtitles = 0;
  if (!folderPath || !fs.existsSync(folderPath)) {
    return { ok: false, exists: false, videos: 0, subtitles: 0 };
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
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (VIDEO_EXTS.has(ext)) videos += 1;
        else if (SUBTITLE_EXTS.has(ext)) subtitles += 1;
      }
    }
  };
  walk(folderPath, 0);
  return { ok: true, exists: true, videos, subtitles };
}

function getYoutubeSetupStats(youtubeFolder) {
  const folder = resolveYoutubeFolder(youtubeFolder);
  const raw = loadRawCatalog(folder);
  const records = raw.records || [];
  const catalogVideos = records.filter((r) => r.assetType === "video").length;
  const catalogTranscripts = records.filter(
    (r) => r.assetType === "transcript",
  ).length;
  const fsCounts = countMediaInFolder(folder, 4);
  return {
    ok: true,
    exists: fsCounts.exists,
    folder,
    catalogExists: raw.catalogExists,
    catalogUpdatedAt: raw.updatedAt || null,
    catalogEntries: records.length,
    videos: catalogVideos || fsCounts.videos,
    transcripts: catalogTranscripts || fsCounts.subtitles,
    videosOnDisk: fsCounts.videos,
    transcriptsOnDisk: fsCounts.subtitles,
  };
}

function register() {
  ipcMain.handle("get-setup-folder-stats", (_, { moviesFolder, youtubeFolder } = {}) => {
    try {
      const movies = countMediaInFolder(
        typeof moviesFolder === "string" ? moviesFolder.trim() : "",
      );
      const youtube = getYoutubeSetupStats(youtubeFolder);
      return { ok: true, movies, youtube };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("get-youtube-default-folder", () => ({
    ok: true,
    folder: getDefaultYoutubeFolder(),
  }));

  ipcMain.handle(
    "get-youtube-catalog-record",
    (_, { youtubeFolder, recordId } = {}) => {
      try {
        if (!recordId) {
          return { ok: false, error: "Missing record id." };
        }
        const raw = loadRawCatalog(resolveYoutubeFolderArg(youtubeFolder));
        if (!raw.catalogExists) {
          return { ok: false, error: "Catalog not found." };
        }
        const catalog = readCatalogFile(raw.catalogPath);
        const record = getCatalogRecord(catalog, recordId);
        if (!record) {
          return { ok: false, error: "Entry not found in catalog." };
        }
        let fileExists = false;
        if (record.filePath) {
          try {
            fileExists = fs.existsSync(record.filePath);
          } catch {
            fileExists = false;
          }
        }
        return { ok: true, record, fileExists, catalogPath: raw.catalogPath };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
  );

  ipcMain.handle(
    "update-youtube-catalog-record",
    (_, { youtubeFolder, recordId, patch } = {}) => {
      try {
        if (!recordId) {
          return { ok: false, error: "Missing record id." };
        }
        const raw = loadRawCatalog(resolveYoutubeFolderArg(youtubeFolder));
        if (!raw.catalogExists) {
          return { ok: false, error: "Catalog not found." };
        }
        const result = updateCatalogRecord(
          raw.catalogPath,
          recordId,
          patch || {},
        );
        if (!result.ok) return result;
        const videos = enrichVideoRecords(
          { records: [result.record] },
          raw.folder,
        );
        return {
          ok: true,
          record: result.record,
          video: videos[0] || null,
        };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
  );

  ipcMain.handle(
    "get-youtube-catalog-video",
    (_, { youtubeFolder, recordId } = {}) => {
      try {
        if (!recordId) {
          return { ok: false, error: "Missing record id." };
        }
        const raw = loadRawCatalog(resolveYoutubeFolderArg(youtubeFolder));
        const videos = enrichVideoRecords(raw, raw.folder);
        const video = videos.find((v) => v.id === recordId) || null;
        return { ok: true, video };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
  );

  ipcMain.handle(
    "clone-youtube-catalog-for-metadata-test",
    (_, { youtubeFolder, recordId } = {}) => {
      try {
        if (!recordId) {
          return { ok: false, error: "Missing record id." };
        }
        const folder = resolveYoutubeFolder(youtubeFolder);
        const catalogPath = path.join(folder, "youtube-catalog.json");
        return cloneCatalogRecordForMetadataTest(
          folder,
          catalogPath,
          recordId,
        );
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
  );

  ipcMain.handle("scan-youtube-catalog-from-disk", (_, { youtubeFolder } = {}) => {
    try {
      const folder = resolveYoutubeFolderArg(youtubeFolder);
      const catalogPath = path.join(folder, "youtube-catalog.json");
      const result = syncCatalogFromDisk(folder, catalogPath);
      return result;
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("load-youtube-catalog", (_, { youtubeFolder, skipSync } = {}) => {
    try {
      const folder = resolveYoutubeFolder(youtubeFolder);
      const catalogPath = path.join(folder, "youtube-catalog.json");

      let sync = null;
      if (skipSync !== true) {
        sync = syncCatalogFromDisk(folder, catalogPath);
      }

      const raw = loadRawCatalog(folder);
      const videos = enrichVideoRecords(raw, raw.folder);
      const channels = [...new Set(videos.map((v) => v.channelName))].sort(
        (a, b) => a.localeCompare(b),
      );
      return {
        ok: true,
        folder: raw.folder,
        catalogPath: raw.catalogPath,
        catalogExists: raw.catalogExists,
        updatedAt: raw.updatedAt,
        totalVideos: videos.length,
        missingFiles: videos.filter((v) => !v.fileExists).length,
        channels,
        videos,
        sync,
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("youtube-file-exists", (_, { filePath } = {}) => {
    if (!filePath) return { ok: true, exists: false };
    try {
      return { ok: true, exists: fs.existsSync(filePath) };
    } catch {
      return { ok: true, exists: false };
    }
  });

  ipcMain.handle("remove-youtube-catalog-entry", (_, { youtubeFolder, recordId, extraFilePaths } = {}) => {
    try {
      if (!recordId) {
        return { ok: false, error: "Missing record id." };
      }
      const raw = loadRawCatalog(resolveYoutubeFolderArg(youtubeFolder));
      if (!raw.catalogExists) {
        return { ok: false, error: "Catalog not found." };
      }

      const catalog = readCatalogFile(raw.catalogPath);
      if (!catalog?.records) {
        return { ok: false, error: "Invalid catalog." };
      }

      const target = catalog.records.find((r) => r.id === recordId);
      if (!target) {
        return { ok: false, error: "Entry not found in catalog." };
      }

      const idsToRemove = new Set([recordId]);
      const targetDir = normalizePath(
        target.directory || (target.filePath ? path.dirname(target.filePath) : ""),
      );
      const targetBase = basenameNoExt(target.filePath).toLowerCase();

      for (const r of catalog.records) {
        if (r.id === recordId) continue;
        if (r.assetType !== "transcript") continue;
        let match = false;
        if (target.videoId && r.videoId === target.videoId) match = true;
        if (!match && targetBase && r.filePath) {
          const rDir = normalizePath(r.directory || path.dirname(r.filePath));
          const rBase = basenameNoExt(r.filePath).toLowerCase();
          if (rDir === targetDir && rBase === targetBase) match = true;
        }
        if (match) idsToRemove.add(r.id);
      }

      const recordsToRemove = catalog.records.filter((r) => idsToRemove.has(r.id));
      const skipFileDelete = recordsToRemove.some((r) => r.metadataTestClone === true);
      const filePaths = skipFileDelete
        ? []
        : [
            ...new Set(
              [
                ...recordsToRemove
                  .map((r) => r.filePath)
                  .filter((p) => typeof p === "string" && p.trim()),
                ...(Array.isArray(extraFilePaths) ? extraFilePaths : []),
              ].filter((p) => typeof p === "string" && p.trim()),
            ),
          ];

      const deleteResults = filePaths.map((p) => tryDeleteFile(p));
      const filesDeleted = deleteResults.filter((r) => r.deleted).length;
      const deleteErrors = deleteResults.filter((r) => !r.ok);

      const before = catalog.records.length;
      catalog.records = catalog.records.filter((r) => !idsToRemove.has(r.id));
      const removedCount = before - catalog.records.length;
      catalog.updatedAt = new Date().toISOString();

      const payload = JSON.stringify(catalog, null, 2);
      fs.writeFileSync(raw.catalogPath, payload, "utf8");

      if (deleteErrors.length) {
        const names = deleteErrors
          .map((e) => path.basename(e.path || "") || e.path)
          .join(", ");
        return {
          ok: true,
          removedCount,
          filesDeleted,
          partial: true,
          warning: `Removed from catalog, but could not delete: ${names}`,
          deleteErrors,
        };
      }

      return {
        ok: true,
        removedCount,
        filesDeleted,
        catalogOnly: skipFileDelete,
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

module.exports = { register, getDefaultYoutubeFolder, loadRawCatalog };
