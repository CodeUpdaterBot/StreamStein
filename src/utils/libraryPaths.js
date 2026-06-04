// Library folder paths — persisted like the TMDB token (main-process secure store + localStorage mirror).
import { storage, STORAGE_KEYS, secureStorage, isElectron } from "./storage";

export const LIBRARY_SECURE_KEYS = {
  MOVIES: "libraryMoviesPath",
  YOUTUBE: "libraryYoutubePath",
  SETUP_DONE: "setupWizardComplete",
};

function trimPath(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Sync read from localStorage (may be stale until resolveLibraryPaths runs). */
export function getStoredMoviesPath() {
  const primary = storage.get(STORAGE_KEYS.DOWNLOAD_PATH);
  const legacy = storage.get(STORAGE_KEYS.DOWNLOADER_FOLDER);
  return trimPath(primary) || trimPath(legacy) || "";
}

export function getStoredYoutubePath() {
  return trimPath(storage.get(STORAGE_KEYS.YOUTUBE_FOLDER));
}

export function hasStoredLibraryFolders() {
  return Boolean(getStoredMoviesPath()) && Boolean(getStoredYoutubePath());
}

function mirrorToLocalStorage({ movies, youtube, setupDone }) {
  if (movies !== undefined) {
    storage.set(STORAGE_KEYS.DOWNLOAD_PATH, trimPath(movies));
  }
  if (youtube !== undefined) {
    storage.set(STORAGE_KEYS.YOUTUBE_FOLDER, trimPath(youtube));
  }
  if (setupDone) {
    storage.set(STORAGE_KEYS.SETUP_WIZARD_COMPLETE, 1);
  }
}

/**
 * Load paths from the main process (authoritative), then mirror to localStorage.
 */
export async function resolveLibraryPaths() {
  let movies = "";
  let youtube = "";
  let setupDone = false;

  if (isElectron && window.electron?.getLibraryPaths) {
    try {
      const res = await window.electron.getLibraryPaths();
      if (res?.ok) {
        movies = trimPath(res.movies);
        youtube = trimPath(res.youtube);
        setupDone = !!res.setupDone;
      }
    } catch {
      // fall through to local mirrors
    }
  }

  if (!movies) movies = getStoredMoviesPath();
  if (!youtube) youtube = getStoredYoutubePath();
  if (!setupDone) {
    setupDone = !!storage.get(STORAGE_KEYS.SETUP_WIZARD_COMPLETE);
  }
  if (!setupDone && movies && youtube) {
    setupDone = true;
  }

  if (
    isElectron &&
    window.electron?.saveLibraryPaths &&
    (movies || youtube || setupDone)
  ) {
    try {
      const res = await window.electron.saveLibraryPaths({
        movies: movies || undefined,
        youtube: youtube || undefined,
        setupWizardComplete: setupDone,
      });
      if (res?.ok) {
        movies = trimPath(res.movies);
        youtube = trimPath(res.youtube);
        setupDone = !!res.setupDone;
      }
    } catch {
      // keep merged local values
    }
  }

  mirrorToLocalStorage({ movies, youtube, setupDone });

  return {
    movies,
    youtube,
    setupDone,
  };
}

/**
 * Write paths via main process (durable), mirror to localStorage, sync bridge.
 */
export async function persistLibraryPaths({
  movies,
  youtube,
  markComplete = false,
} = {}) {
  const payload = {};
  if (movies !== undefined) payload.movies = trimPath(movies);
  if (youtube !== undefined) payload.youtube = trimPath(youtube);
  if (markComplete) payload.setupWizardComplete = true;

  let resolved = {
    movies: payload.movies ?? getStoredMoviesPath(),
    youtube: payload.youtube ?? getStoredYoutubePath(),
    setupDone: markComplete || !!storage.get(STORAGE_KEYS.SETUP_WIZARD_COMPLETE),
  };

  if (isElectron && window.electron?.saveLibraryPaths) {
    try {
      const res = await window.electron.saveLibraryPaths(payload);
      if (res?.ok) {
        resolved = {
          movies: trimPath(res.movies),
          youtube: trimPath(res.youtube),
          setupDone: !!res.setupDone,
        };
      }
    } catch {
      // fall through to renderer-only writes below
    }
  } else {
    if (movies !== undefined) {
      storage.set(STORAGE_KEYS.DOWNLOAD_PATH, trimPath(movies));
    }
    if (youtube !== undefined) {
      storage.set(STORAGE_KEYS.YOUTUBE_FOLDER, trimPath(youtube));
    }
    if (markComplete) {
      storage.set(STORAGE_KEYS.SETUP_WIZARD_COMPLETE, 1);
      if (isElectron) {
        await secureStorage.set(LIBRARY_SECURE_KEYS.SETUP_DONE, "1");
      }
    }
    if (movies !== undefined) {
      if (trimPath(movies)) {
        await secureStorage.set(LIBRARY_SECURE_KEYS.MOVIES, trimPath(movies));
      }
    }
    if (youtube !== undefined) {
      if (trimPath(youtube)) {
        await secureStorage.set(LIBRARY_SECURE_KEYS.YOUTUBE, trimPath(youtube));
      }
    }
  }

  mirrorToLocalStorage(resolved);

  if (
    isElectron &&
    window.electron?.notifyLibraryPathsChanged &&
    (movies !== undefined || youtube !== undefined || markComplete)
  ) {
    try {
      await window.electron.notifyLibraryPathsChanged({
        movies: resolved.movies,
        youtube: resolved.youtube,
        setupWizardComplete: resolved.setupDone,
      });
    } catch {
      // bridge may be offline
    }
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("streamstein-library-paths-changed"));
  }

  return resolved;
}

export async function markSetupWizardComplete() {
  return persistLibraryPaths({ markComplete: true });
}

export function isLibrarySetupSatisfied(paths) {
  if (!paths) return false;
  if (paths.setupDone) return true;
  return Boolean(trimPath(paths.movies)) && Boolean(trimPath(paths.youtube));
}
