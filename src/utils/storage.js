// localStorage-based persistence (works in both Vite dev and prod)

export const STORAGE_PREFIX = "streamstein_";
const LEGACY_PREFIX = "streambert_";

export const ANILIST_CACHE_KEY = `${STORAGE_PREFIX}anilistCache`;
export const EG_CACHE_KEY = `${STORAGE_PREFIX}episodeGroupCache`;
export const ANISKIP_CACHE_KEY = `${STORAGE_PREFIX}aniskipCache`;
export const TMDB_LANG_KEY = `${STORAGE_PREFIX}tmdbLang`;
export const TRENDING_CACHE_KEY = `${STORAGE_PREFIX}trendingCache`;
export const LAST_VERSION_KEY = `${STORAGE_PREFIX}lastVersion`;

const LEGACY_STANDALONE_KEYS = {
  streambert_anilistCache: ANILIST_CACHE_KEY,
  streambert_episodeGroupCache: EG_CACHE_KEY,
  streambert_aniskipCache: ANISKIP_CACHE_KEY,
  streambert_tmdbLang: TMDB_LANG_KEY,
  streambert_trendingCache: TRENDING_CACHE_KEY,
  streambert_lastVersion: LAST_VERSION_KEY,
};

/** Copy streambert_* localStorage into streamstein_* (from migrated LevelDB profile). */
export function migrateLegacyStorageKeys() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(LEGACY_PREFIX)) {
        const newKey = STORAGE_PREFIX + key.slice(LEGACY_PREFIX.length);
        if (localStorage.getItem(newKey) == null) {
          localStorage.setItem(newKey, localStorage.getItem(key));
        }
      }
    }
    for (const [oldKey, newKey] of Object.entries(LEGACY_STANDALONE_KEYS)) {
      if (
        localStorage.getItem(oldKey) != null &&
        localStorage.getItem(newKey) == null
      ) {
        localStorage.setItem(newKey, localStorage.getItem(oldKey));
      }
    }
  } catch {}
}

migrateLegacyStorageKeys();

const PREFIX = STORAGE_PREFIX;

export const storage = {
  get(key) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {}
  },
  remove(key) {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {}
  },
  clearAll() {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith(PREFIX))
        .forEach((k) => localStorage.removeItem(k));
    } catch {}
  },
};

export const STORAGE_KEYS = {
  API_KEY: "apikey",
  PLAYER_SOURCE: "playerSource",
  ALLMANGA_DUB_MODE: "allmangaDubMode",
  WATCH_PROGRESS: "progress",
  WATCHED: "watched",
  HISTORY: "history",
  SAVED: "saved",
  SAVED_ORDER: "savedOrder",
  LOCAL_FILES: "localFiles",
  DOWNLOAD_PATH: "downloadPath",
  DOWNLOADER_FOLDER: "downloaderFolder",
  START_PAGE: "startPage",
  AGE_LIMIT: "ageLimit",
  RATING_COUNTRY: "ratingCountry",
  WATCHED_THRESHOLD: "watchedThreshold",
  HOME_ROW_ORDER: "homeRowOrder",
  HOME_ROW_VISIBLE: "homeRowVisible",
  HOME_VIEW_MODE: "homeViewMode",
  AUTO_CHECK_UPDATES: "autoCheckUpdates",
  INVIDIOUS_BASE: "invidiousBase",
  SUBTITLE_ENABLED: "subtitleDownload",
  SUBTITLE_LANG: "subtitleLang",
  SUBDL_API_KEY: "subdlApiKey",
  WYZIE_API_KEY: "wyzieApiKey",
  ACCENT_COLOR: "accentColor",
  FONT_SIZE: "fontSize",
  COMPACT_MODE: "compactMode",
  REDUCE_ANIMATIONS: "reduceAnimations",
  LIBRARY_SORT: "librarySort",
  HISTORY_ENABLED: "historyEnabled",
  NOTIFY_DOWNLOAD_COMPLETE: "notifyDownloadComplete",
  NOTIFY_NEW_EPISODE: "notifyNewEpisode",
  TMDB_LANG: "tmdbLang",
  INTRO_SKIP_MODE: "introSkipMode",
  DL_SORT_BY: "dlSortBy",
  DL_SORT_DIR: "dlSortDir",
  DL_SHOW_UNTRACKED: "dlShowUntracked",
  DOWNLOAD_MAX_CONCURRENT: "downloadMaxConcurrent",
  CAST_AUTO_DISCOVER: "castAutoDiscover",
  CAST_ENABLE_DLNA: "castEnableDlna",
  CAST_AUTO_STOP: "castAutoStopOnPlayerStop",
  CAST_PREFERRED_DEVICE_ID: "castPreferredDeviceId",
  CAST_RECENT_DEVICE_IDS: "castRecentDeviceIds",
  SERIES_DL_SOURCES: "seriesDlSources",
  SERIES_DL_SKIP_EXISTING: "seriesDlSkipExisting",
  EPISODE_RELEASE_CACHE: "episodeReleaseCache",
};

export const getApiKey = () => storage.get(STORAGE_KEYS.API_KEY);

export const isElectron =
  typeof window !== "undefined" && !!window.electron;

export function formatBytes(bytes) {
  if (bytes == null) return "…";
  if (bytes === -1) return null;
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const _isElectronSecure =
  typeof window !== "undefined" && !!window.electron?.secureGet;

export const secureStorage = {
  get: async (key) => {
    if (!_isElectronSecure) return null;
    return window.electron.secureGet(key);
  },
  async set(key, value) {
    if (!_isElectronSecure) return;
    return window.electron.secureSet(key, value ?? "");
  },
};

export async function clearAppCaches() {
  if (isElectron) {
    try {
      await window.electron.clearAppCache();
    } catch {}
  }
  localStorage.removeItem(ANILIST_CACHE_KEY);
  localStorage.removeItem(EG_CACHE_KEY);
  localStorage.removeItem(ANISKIP_CACHE_KEY);
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("dlDur_")) localStorage.removeItem(key);
  }
}
