import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CATALOG_VERSION = 1;
const CATALOG_SCHEMA = "yt-saver-youtube-catalog";

/**
 * @typedef {Object} YoutubeCatalogRecord
 * @property {string} id
 * @property {string} status - pending | completed | failed
 * @property {string|null} videoId
 * @property {string|null} watchUrl
 * @property {string|null} shortUrl
 * @property {string|null} thumbnailUrl
 * @property {string|null} title
 * @property {string|null} normalizedTitle
 * @property {string|null} channelId
 * @property {string|null} channelName
 * @property {string|null} channelKey
 * @property {string} assetType - video | transcript | audio
 * @property {string|null} fileName
 * @property {string|null} filePath
 * @property {string|null} intendedPath
 * @property {string|null} directory
 * @property {string|null} extension
 * @property {number|null} size
 * @property {number|null} mtime
 * @property {string|null} source
 * @property {string|null} quality
 * @property {string|null} libraryEntryId
 * @property {string} requestedAt
 * @property {string|null} completedAt
 * @property {string} updatedAt
 */

export function createYoutubeCatalogStore(options = {}) {
  const downloadsDir = options.downloadsDir || path.join(os.homedir(), "Downloads");
  const projectRoot = options.projectRoot || process.cwd();
  const mirrorToProject = options.mirrorToProject === true;

  let libraryFolder =
    (typeof options.libraryFolder === "string" && options.libraryFolder.trim()) ||
    path.join(downloadsDir, "YouTube");

  let primaryPath = "";
  let mirrorPath = null;
  let catalogPaths = [];

  function rebuildPaths() {
    primaryPath = path.join(libraryFolder, "youtube-catalog.json");
    mirrorPath =
      mirrorToProject && projectRoot
        ? path.join(projectRoot, "youtube-catalog.json")
        : null;
    catalogPaths = [primaryPath];
  }

  rebuildPaths();

  function normalizeFsPath(p) {
    if (!p || typeof p !== "string") return "";
    return path.normalize(p);
  }

  function defaultCatalog() {
    return {
      version: CATALOG_VERSION,
      schema: CATALOG_SCHEMA,
      updatedAt: new Date().toISOString(),
      records: []
    };
  }

  function loadCatalog() {
    for (const filePath of catalogPaths) {
      try {
        if (!fs.existsSync(filePath)) continue;
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.records)) {
          return parsed;
        }
      } catch {
        // try next path
      }
    }
    return defaultCatalog();
  }

  function saveCatalog(catalog) {
    catalog.version = CATALOG_VERSION;
    catalog.schema = CATALOG_SCHEMA;
    catalog.updatedAt = new Date().toISOString();
    const payload = JSON.stringify(catalog);
    const saveTargets = mirrorPath ? [primaryPath, mirrorPath] : [primaryPath];
    for (const filePath of saveTargets) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, payload, "utf8");
      } catch {
        // mirror is best-effort
      }
    }
  }

  function setLibraryFolder(folder) {
    const trimmed = typeof folder === "string" ? folder.trim() : "";
    if (!trimmed) return;
    libraryFolder = trimmed;
    rebuildPaths();
  }

  function getLibraryFolder() {
    return libraryFolder;
  }

  function buildYoutubeUrls(videoId, watchUrl) {
    const id = typeof videoId === "string" ? videoId.trim() : "";
    if (!id) {
      return {
        watchUrl: typeof watchUrl === "string" ? watchUrl : null,
        shortUrl: null,
        thumbnailUrl: null
      };
    }
    return {
      watchUrl: watchUrl || `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
      shortUrl: `https://youtu.be/${encodeURIComponent(id)}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`
    };
  }

  function resolveToAbsolute(filePathOrHint) {
    if (!filePathOrHint || typeof filePathOrHint !== "string") return null;
    const trimmed = filePathOrHint.trim();
    if (!trimmed) return null;
    if (path.isAbsolute(trimmed)) return normalizeFsPath(trimmed);
    return normalizeFsPath(path.join(downloadsDir, trimmed.replace(/\\/g, path.sep)));
  }

  function findRecordIndex(catalog, { filePath, videoId, assetType, intendedPath }) {
    const normPath = filePath ? normalizeFsPath(filePath) : "";
    const normIntended = intendedPath ? normalizeFsPath(intendedPath) : "";
    for (let i = catalog.records.length - 1; i >= 0; i--) {
      const r = catalog.records[i];
      if (normPath && r.filePath && normalizeFsPath(r.filePath) === normPath) {
        return i;
      }
      if (
        normIntended &&
        r.intendedPath &&
        normalizeFsPath(r.intendedPath) === normIntended &&
        r.assetType === assetType
      ) {
        return i;
      }
      if (
        videoId &&
        r.videoId === videoId &&
        r.assetType === assetType &&
        r.status === "pending" &&
        !r.filePath
      ) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Record or update a download in the YouTube catalog (for StreamStein and other tools).
   * @param {Object} input
   * @returns {YoutubeCatalogRecord|null}
   */
  function recordDownload(input = {}) {
    const catalog = loadCatalog();
    const now = new Date().toISOString();
    const videoId = typeof input.videoId === "string" ? input.videoId.trim() : "";
    const urls = buildYoutubeUrls(videoId, input.watchUrl);
    const assetType =
      input.assetType === "transcript"
        ? "transcript"
        : input.assetType === "audio"
          ? "audio"
          : "video";
    const filePath = resolveToAbsolute(input.path || input.filePath);
    const intendedPath = resolveToAbsolute(input.intendedPath || input.filenameHint);
    const status =
      input.status === "pending" || input.status === "failed"
        ? input.status
        : "completed";

    let idx = findRecordIndex(catalog, {
      filePath,
      videoId: videoId || null,
      assetType,
      intendedPath
    });

    const baseName = filePath
      ? path.basename(filePath)
      : intendedPath
        ? path.basename(intendedPath)
        : null;

    /** @type {YoutubeCatalogRecord} */
    let record =
      idx >= 0
        ? catalog.records[idx]
        : {
            id: `yt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            status: "pending",
            videoId: videoId || null,
            watchUrl: urls.watchUrl,
            shortUrl: urls.shortUrl,
            thumbnailUrl: urls.thumbnailUrl,
            title: null,
            normalizedTitle: null,
            channelId: null,
            channelName: null,
            channelKey: null,
            assetType,
            fileName: null,
            filePath: null,
            intendedPath: null,
            directory: null,
            extension: null,
            size: null,
            mtime: null,
            source: null,
            quality: null,
            libraryEntryId: null,
            requestedAt: now,
            completedAt: null,
            updatedAt: now
          };

    if (videoId) record.videoId = videoId;
    if (urls.watchUrl) record.watchUrl = urls.watchUrl;
    if (urls.shortUrl) record.shortUrl = urls.shortUrl;
    if (urls.thumbnailUrl) record.thumbnailUrl = urls.thumbnailUrl;
    if (typeof input.title === "string" && input.title) record.title = input.title;
    if (typeof input.normalizedTitle === "string" && input.normalizedTitle) {
      record.normalizedTitle = input.normalizedTitle;
    }
    if (typeof input.channelId === "string" && input.channelId) {
      record.channelId = input.channelId;
    }
    if (typeof input.channelName === "string" && input.channelName) {
      record.channelName = input.channelName;
    }
    if (typeof input.channelKey === "string" && input.channelKey) {
      record.channelKey = input.channelKey;
    }
    if (typeof input.source === "string" && input.source) record.source = input.source;
    if (typeof input.quality === "string" && input.quality) record.quality = input.quality;
    if (typeof input.libraryEntryId === "string" && input.libraryEntryId) {
      record.libraryEntryId = input.libraryEntryId;
    }

    if (intendedPath) record.intendedPath = intendedPath;
    if (filePath) {
      record.filePath = filePath;
      record.fileName = baseName;
      record.directory = path.dirname(filePath);
      record.extension = path.extname(filePath).toLowerCase() || null;
    } else if (intendedPath && !record.fileName) {
      record.fileName = baseName;
      record.directory = path.dirname(intendedPath);
      record.extension = path.extname(intendedPath).toLowerCase() || null;
    }

    if (typeof input.size === "number") record.size = input.size;
    if (typeof input.mtime === "number") record.mtime = input.mtime;

    record.status = status;
    record.updatedAt = now;
    if (status === "completed") {
      record.completedAt = now;
    }
    if (!record.requestedAt) record.requestedAt = now;

    if (idx >= 0) {
      catalog.records[idx] = record;
    } else {
      catalog.records.push(record);
    }

    saveCatalog(catalog);
    return record;
  }

  function getCatalogPaths() {
    return {
      primary: primaryPath,
      mirror: mirrorPath,
      libraryFolder,
      paths: catalogPaths,
    };
  }

  return {
    loadCatalog,
    saveCatalog,
    recordDownload,
    getCatalogPaths,
    setLibraryFolder,
    getLibraryFolder,
    resolveToAbsolute,
    buildYoutubeUrls,
  };
}
