// ── Streambert → Streamstein profile migration (main process) ───────────────
// Must run via configureUserDataPath(app) before app.whenReady().
//
// Files under userData (secure-store.json, Local Storage, downloads.json) live
// in %APPDATA%\streambert. Renaming the app alone uses an empty streamstein
// folder. OS-encrypted secrets must be decrypted while userData points at the
// legacy profile, then re-encrypted via .secret-migration.json (see storage.js).

const fs = require("fs");
const path = require("path");
const { safeStorage } = require("electron");

const NEW_PROFILE_DIR = "streamstein";
const LEGACY_DIR_PATTERN = /^streambert$/i;
const MIGRATION_MARKER = ".migrated-from-streambert.json";
const SECRET_MIGRATION_FILE = ".secret-migration.json";

const SKIP_DIR_NAMES = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "ShaderCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "Service Worker",
  "Session Storage",
  "blob_storage",
  "Shared Dictionary",
  "SharedStorage",
  "VideoDecodeStats",
]);

const ESSENTIAL_FILES = [
  "secure-store.json",
  "downloads.json",
  "scheduled-backup-settings.json",
  "Preferences",
  "Local State",
  ".secret-migration.json",
];

const COPY_FILE_MAX_BYTES = 25 * 1024 * 1024;
const SYMLINK_DIR_BYTES = 80 * 1024 * 1024;

function dirSizeBytes(dirPath, depth = 0) {
  if (depth > 6) return 0;
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of entries) {
    const full = path.join(dirPath, ent.name);
    try {
      if (ent.isDirectory()) total += dirSizeBytes(full, depth + 1);
      else total += fs.statSync(full).size;
    } catch {}
  }
  return total;
}

function isProfileEmpty(dir) {
  if (!dir || !fs.existsSync(dir)) return true;
  for (const f of ESSENTIAL_FILES) {
    if (f === SECRET_MIGRATION_FILE) continue;
    if (fs.existsSync(path.join(dir, f))) return false;
  }
  if (fs.existsSync(path.join(dir, "Local Storage"))) return false;
  if (fs.existsSync(path.join(dir, "Partitions"))) return false;
  return true;
}

function findLegacyUserDataDir(appData) {
  const candidates = [];
  try {
    for (const name of fs.readdirSync(appData)) {
      if (name === NEW_PROFILE_DIR) continue;
      if (LEGACY_DIR_PATTERN.test(name)) {
        candidates.push(path.join(appData, name));
      }
    }
  } catch {}

  let best = null;
  let bestScore = 0;
  for (const dir of candidates) {
    if (!fs.existsSync(dir) || isProfileEmpty(dir)) continue;
    let score = 0;
    if (fs.existsSync(path.join(dir, "secure-store.json"))) score += 10;
    if (fs.existsSync(path.join(dir, "Local Storage"))) {
      score += 5 + Math.min(5, dirSizeBytes(path.join(dir, "Local Storage")) / 1e6);
    }
    if (fs.existsSync(path.join(dir, "downloads.json"))) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = dir;
    }
  }
  return best;
}

function withUserData(app, userDataDir, fn) {
  const previous = app.getPath("userData");
  try {
    app.setPath("userData", userDataDir);
    return fn();
  } finally {
    app.setPath("userData", previous);
  }
}

/** Decrypt secure-store.json for whichever userData directory is currently set. */
function readSecureStorePlaintext(app) {
  const file = path.join(app.getPath("userData"), "secure-store.json");
  if (!fs.existsSync(file)) return {};
  let store;
  try {
    store = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  const plain = {};
  for (const [k, raw] of Object.entries(store)) {
    if (!raw) continue;
    try {
      plain[k] =
        safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(raw, "base64"))
          : Buffer.from(raw, "base64").toString("utf8");
    } catch (e) {
      console.warn(`[migration] could not decrypt legacy key "${k}":`, e.message);
    }
  }
  return plain;
}

function readLegacySecrets(app, legacyDir) {
  return withUserData(app, legacyDir, () => readSecureStorePlaintext(app));
}

function hasUsableApiKey(secrets) {
  const k = secrets?.apikey;
  return typeof k === "string" && k.trim().length > 8;
}

function writeMarker(newDir, legacyDir) {
  try {
    fs.writeFileSync(
      path.join(newDir, MIGRATION_MARKER),
      JSON.stringify(
        { from: legacyDir, at: new Date().toISOString(), version: 2 },
        null,
        2,
      ),
      "utf8",
    );
  } catch (e) {
    console.warn("[migration] could not write marker:", e.message);
  }
}

function shouldMigrateFiles(legacyDir, newDir) {
  if (!legacyDir) return false;
  if (!fs.existsSync(newDir)) return true;
  if (isProfileEmpty(newDir) && !isProfileEmpty(legacyDir)) return true;
  return false;
}

function shouldSkipFileMigration(legacyDir, newDir) {
  if (!fs.existsSync(path.join(newDir, MIGRATION_MARKER))) return false;
  return !shouldMigrateFiles(legacyDir, newDir);
}

function copyFileSafe(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function symlinkDirSafe(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) return;
  const type = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(src, dest, type);
}

function copyTreeSafe(src, dest, opts = {}) {
  const { forceCopy = false } = opts;
  if (fs.existsSync(dest) && !opts.replace) return;

  const base = path.basename(src);
  if (!forceCopy && SKIP_DIR_NAMES.has(base)) return;

  let st;
  try {
    st = fs.statSync(src);
  } catch {
    return;
  }

  if (st.isDirectory()) {
    if (!forceCopy && SKIP_DIR_NAMES.has(base)) return;

    const bytes = dirSizeBytes(src);
    if (!forceCopy && bytes >= SYMLINK_DIR_BYTES) {
      try {
        if (fs.existsSync(dest)) {
          fs.rmSync(dest, { recursive: true, force: true });
        }
        symlinkDirSafe(src, dest);
        console.log(
          `[migration] symlinked ${base} (${Math.round(bytes / 1048576)} MiB)`,
        );
        return;
      } catch (e) {
        console.warn(`[migration] symlink ${base} failed, copying:`, e.message);
      }
    }

    if (opts.replace && fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.mkdirSync(dest, { recursive: true });
    let entries;
    try {
      entries = fs.readdirSync(src, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      copyTreeSafe(path.join(src, ent.name), path.join(dest, ent.name), opts);
    }
    return;
  }

  if (st.size > COPY_FILE_MAX_BYTES) {
    console.warn(`[migration] skipped large file ${base}`);
    return;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function mergeLocalStorage(legacyDir, newDir) {
  const lsSrc = path.join(legacyDir, "Local Storage");
  const lsDest = path.join(newDir, "Local Storage");
  if (!fs.existsSync(lsSrc)) return;

  const srcBytes = dirSizeBytes(lsSrc);
  const destBytes = fs.existsSync(lsDest) ? dirSizeBytes(lsDest) : 0;
  if (!fs.existsSync(lsDest) || destBytes < srcBytes - 512) {
    console.log("[migration] copying Local Storage (settings & history)");
    copyTreeSafe(lsSrc, lsDest, { forceCopy: true, replace: true });
  }
}

function mergeMissingFiles(legacyDir, newDir) {
  for (const f of ESSENTIAL_FILES) {
    if (f === "secure-store.json" || f === SECRET_MIGRATION_FILE) continue;
    const src = path.join(legacyDir, f);
    const dest = path.join(newDir, f);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      copyFileSafe(src, dest);
    }
  }
  mergeLocalStorage(legacyDir, newDir);
}

function migrateProfile(legacyDir, newDir) {
  console.log("[migration] Streambert → Streamstein (profile files)");
  console.log(`[migration]   from: ${legacyDir}`);
  console.log(`[migration]   to:   ${newDir}`);

  fs.mkdirSync(newDir, { recursive: true });

  for (const f of ESSENTIAL_FILES) {
    if (f === "secure-store.json" || f === SECRET_MIGRATION_FILE) continue;
    const src = path.join(legacyDir, f);
    if (fs.existsSync(src)) copyFileSafe(src, path.join(newDir, f));
  }

  let entries;
  try {
    entries = fs.readdirSync(legacyDir, { withFileTypes: true });
  } catch (e) {
    console.warn("[migration] readdir failed:", e.message);
    writeMarker(newDir, legacyDir);
    return;
  }

  for (const ent of entries) {
    if (ent.name === MIGRATION_MARKER || ent.name === SECRET_MIGRATION_FILE) {
      continue;
    }
    if (ESSENTIAL_FILES.includes(ent.name)) continue;

    const src = path.join(legacyDir, ent.name);
    const dest = path.join(newDir, ent.name);

    if (ent.isDirectory()) {
      if (ent.name === "Local Storage") {
        copyTreeSafe(src, dest, { forceCopy: true, replace: true });
        continue;
      }
      if (SKIP_DIR_NAMES.has(ent.name)) continue;
      copyTreeSafe(src, dest);
    } else if (ent.isFile() && !fs.existsSync(dest)) {
      copyTreeSafe(src, dest);
    }
  }

  writeMarker(newDir, legacyDir);
}

/**
 * Decrypt secrets from Streambert and re-encrypt for Streamstein.
 * secure-store.json must be read with matching Chromium "Local State" (os_crypt).
 */
function importLegacySecrets(app, legacyDir, newDir) {
  fs.mkdirSync(newDir, { recursive: true });

  const legacyLocalState = path.join(legacyDir, "Local State");
  const legacySecure = path.join(legacyDir, "secure-store.json");
  if (fs.existsSync(legacyLocalState)) {
    copyFileSafe(legacyLocalState, path.join(newDir, "Local State"));
  }
  if (fs.existsSync(legacySecure)) {
    copyFileSafe(legacySecure, path.join(newDir, "secure-store.json"));
  }

  let legacySecrets = withUserData(app, newDir, () =>
    readSecureStorePlaintext(app),
  );
  if (!hasUsableApiKey(legacySecrets)) {
    legacySecrets = readLegacySecrets(app, legacyDir);
  }

  if (!Object.keys(legacySecrets).length) {
    console.log("[migration] no legacy secrets found to import");
    return;
  }

  const current = withUserData(app, newDir, () => readSecureStorePlaintext(app));

  const toImport = {};
  for (const [k, v] of Object.entries(legacySecrets)) {
    if (v && !current[k]) toImport[k] = v;
  }

  if (!Object.keys(toImport).length) {
    if (hasUsableApiKey(current)) {
      console.log("[migration] secrets already present in Streamstein profile");
    }
    return;
  }

  const mf = path.join(newDir, SECRET_MIGRATION_FILE);
  fs.writeFileSync(mf, JSON.stringify(toImport), { mode: 0o600 });
  console.log(
    "[migration] imported secrets:",
    Object.keys(toImport).join(", "),
  );
}

function configureUserDataPath(app) {
  const appData = app.getPath("appData");
  const newDir = path.join(appData, NEW_PROFILE_DIR);
  const legacyDir = findLegacyUserDataDir(appData);

  if (legacyDir) {
    const skipFiles = shouldSkipFileMigration(legacyDir, newDir);
    if (!skipFiles) {
      migrateProfile(legacyDir, newDir);
    } else {
      console.log("[migration] repairing profile from Streambert");
      mergeMissingFiles(legacyDir, newDir);
    }
    importLegacySecrets(app, legacyDir, newDir);
  }

  fs.mkdirSync(newDir, { recursive: true });
  app.setPath("userData", newDir);

  try {
    const { applySecretMigrationIfNeeded } = require("./storage");
    applySecretMigrationIfNeeded();
  } catch (e) {
    console.warn("[migration] applySecretMigrationIfNeeded failed:", e.message);
  }
}

module.exports = {
  configureUserDataPath,
  NEW_PROFILE_DIR,
  MIGRATION_MARKER,
};
