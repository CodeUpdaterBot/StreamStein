// Main-process library folder paths (secure store + userData mirror for bridge).
// Source of truth for setup wizard / Settings folder paths (same tier as apikey).

const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { secureStoreGet, secureStoreSet } = require("./storage");

const SECURE_KEYS = {
  MOVIES: "libraryMoviesPath",
  YOUTUBE: "libraryYoutubePath",
  SETUP_DONE: "setupWizardComplete",
};

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function libraryPathsFile() {
  return path.join(app.getPath("userData"), "library-paths.json");
}

function readPathsFile() {
  try {
    const raw = fs.readFileSync(libraryPathsFile(), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeLibraryPathsFile({ movies, youtube, setupWizardComplete } = {}) {
  try {
    const prev = readPathsFile() || {};
    const next = {
      movies:
        movies !== undefined ? trim(movies) : trim(prev.movies) || "",
      youtube:
        youtube !== undefined ? trim(youtube) : trim(prev.youtube) || "",
      setupWizardComplete:
        setupWizardComplete === true ||
        setupWizardComplete === 1 ||
        setupWizardComplete === "1" ||
        (!!prev.setupWizardComplete && setupWizardComplete === undefined),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(libraryPathsFile(), JSON.stringify(next, null, 2), "utf8");
    return next;
  } catch {
    return null;
  }
}

function readSetupDoneFromSecure() {
  const raw = secureStoreGet(SECURE_KEYS.SETUP_DONE);
  return raw === "1" || raw === 1 || raw === true || raw === "true";
}

function getResolvedLibraryPaths() {
  let movies = trim(secureStoreGet(SECURE_KEYS.MOVIES));
  let youtube = trim(secureStoreGet(SECURE_KEYS.YOUTUBE));
  let setupDone = readSetupDoneFromSecure();

  const file = readPathsFile();
  if (file) {
    if (!movies) movies = trim(file.movies);
    if (!youtube) youtube = trim(file.youtube);
    if (!setupDone) {
      setupDone =
        file.setupWizardComplete === true ||
        file.setupWizardComplete === 1 ||
        file.setupWizardComplete === "1";
    }
  }

  if (!setupDone && movies && youtube) {
    setupDone = true;
  }

  return { movies, youtube, setupDone };
}

function saveLibraryPaths({ movies, youtube, setupWizardComplete } = {}) {
  if (movies !== undefined) {
    const m = trim(movies);
    if (m) secureStoreSet(SECURE_KEYS.MOVIES, m);
    else secureStoreSet(SECURE_KEYS.MOVIES, null);
  }
  if (youtube !== undefined) {
    const y = trim(youtube);
    if (y) secureStoreSet(SECURE_KEYS.YOUTUBE, y);
    else secureStoreSet(SECURE_KEYS.YOUTUBE, null);
  }
  if (
    setupWizardComplete === true ||
    setupWizardComplete === 1 ||
    setupWizardComplete === "1"
  ) {
    secureStoreSet(SECURE_KEYS.SETUP_DONE, "1");
  }

  writeLibraryPathsFile({ movies, youtube, setupWizardComplete });

  return getResolvedLibraryPaths();
}

function scoreYoutubeLibraryFolder(folder) {
  if (!folder || !fs.existsSync(folder)) return -1;
  let score = 0;
  try {
    if (fs.existsSync(path.join(folder, "youtube-catalog.json"))) score += 1000;
    const entries = fs.readdirSync(folder, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) score += 5;
      if (e.isFile() && /\.(mp4|mkv|webm|m4v)$/i.test(e.name)) score += 2;
    }
  } catch {
    return -1;
  }
  return score;
}

/** Resolve folder for YouTube IPC — prefers the path that looks most like the real library. */
function resolveYoutubeFolderArg(youtubeFolder) {
  const seen = new Set();
  const candidates = [
    trim(youtubeFolder),
    getResolvedLibraryPaths().youtube,
  ].filter((folder) => {
    if (!folder || seen.has(folder)) return false;
    seen.add(folder);
    return true;
  });

  let best = "";
  let bestScore = -1;
  for (const folder of candidates) {
    const score = scoreYoutubeLibraryFolder(folder);
    if (score > bestScore) {
      bestScore = score;
      best = folder;
    }
  }
  if (best) return best;

  for (const folder of candidates) {
    if (fs.existsSync(folder)) return folder;
  }
  return candidates[0] || "";
}

function register(ipcMain) {
  ipcMain.handle("get-library-paths", () => ({
    ok: true,
    ...getResolvedLibraryPaths(),
  }));

  ipcMain.handle("save-library-paths", (_, paths = {}) => {
    try {
      const resolved = saveLibraryPaths(paths);
      return { ok: true, ...resolved };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("notify-library-paths-changed", async (_, paths = {}) => {
    try {
      const resolved = saveLibraryPaths(paths);
      const ytBridge = require("./ytBridge");
      await ytBridge.syncBridgeLibraryPaths(resolved);
      return { ok: true, ...resolved };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

module.exports = {
  register,
  getResolvedLibraryPaths,
  saveLibraryPaths,
  resolveYoutubeFolderArg,
  writeLibraryPathsFile,
  SECURE_KEYS,
};
