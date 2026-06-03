#!/usr/bin/env node
/**
 * One-shot helper: fill missing YouTube metadata in youtube-catalog.json
 * (videoId, watchUrl, thumbnailUrl, channelName, etc.) for legacy scans.
 *
 * Usage (from project root):
 *   node scripts/enrich-youtube-catalog.js
 *   node scripts/enrich-youtube-catalog.js --dry-run
 *   node scripts/enrich-youtube-catalog.js --limit 10
 *   node scripts/enrich-youtube-catalog.js 10
 *
 * With npm you MUST pass a double-dash before flags:
 *   npm run enrich-youtube-catalog -- --limit 10
 *   npm run enrich-youtube-catalog -- 10
 *
 * Saves after each match (safe to Ctrl+C). Creates one backup before first write.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const toolPaths = require("./toolPaths");
const {
  normalizeMatchConfig,
  buildSearchQueries,
  buildLooseSearchQueries,
  pickBestCandidateWithConfig,
  describeMatchConfig,
  describeDurationMatch,
  formatDurationClock,
  DEFAULT_MATCH_CONFIG,
} = require("./youtubeEnrichMatch");
const {
  ensureRecordDurationSeconds,
  parseDurationSeconds,
} = require("./youtubeDurationProbe");
const {
  stripWindowsDuplicateBasename,
  isWindowsCopyBasename,
  isWindowsNumberedCopyBasename,
  dedupeWindowsCopyRecords,
} = require("./youtubeCatalogDedupe");

const DEFAULT_YT_FOLDER = path.join(os.homedir(), "Downloads", "YouTube");

function getMirrorCatalogPath() {
  return path.join(toolPaths.resolveBridgeRoot(), "youtube-catalog.json");
}

const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm", ".m4v", ".avi", ".mov"]);

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    limit: Infinity,
    delayMs: 1500,
    folder: process.env.YOUTUBE_FOLDER || DEFAULT_YT_FOLDER,
    catalog: null,
    minScore: 0.55,
    verbose: false,
    matchConfig: null,
    recordId: process.env.STREAMSTEIN_ENRICH_RECORD_ID || null,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a === "--limit" || a === "-n" || a === "-l") {
      opts.limit = Number(argv[++i]);
      if (!Number.isFinite(opts.limit) || opts.limit < 1) {
        console.error(`Invalid limit: ${argv[i]}`);
        process.exit(1);
      }
    } else if (a === "--delay") {
      opts.delayMs = Number(argv[++i]) || opts.delayMs;
    } else if (a === "--folder") opts.folder = argv[++i] || opts.folder;
    else if (a === "--catalog") opts.catalog = argv[++i] || opts.catalog;
    else if (a === "--min-score") opts.minScore = Number(argv[++i]) || opts.minScore;
    else if (a === "--match-config") {
      const raw = argv[++i];
      if (raw) {
        try {
          opts.matchConfig = JSON.parse(raw);
        } catch {
          console.error("Invalid --match-config JSON");
          process.exit(1);
        }
      }
    }
    else if (a === "--record-id") {
      opts.recordId = argv[++i] || opts.recordId;
    }
    else if (/^\d+$/.test(a)) {
      // npm sometimes forwards bare numbers: `npm run enrich-youtube-catalog -- 10`
      opts.limit = Number(a);
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printHelp();
      process.exit(1);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`Usage: node scripts/enrich-youtube-catalog.js [options] [limit]

Options:
  --limit, -n, -l N   Process at most N video records (default: all)
  N                   Positional limit shorthand (e.g. ...enrich-youtube-catalog.js 10)
  --folder PATH       YouTube library folder (default: ~/Downloads/YouTube)
  --catalog PATH      Explicit youtube-catalog.json path
  --dry-run           Print matches without writing
  --delay MS          Pause between web searches (default: 1500)
  --min-score N       Title match threshold 0-1 (default: 0.55)
  --verbose, -v       Extra logging
  --help, -h          Show this help

npm examples (note the -- before flags):
  npm run enrich-youtube-catalog -- --limit 10
  npm run enrich-youtube-catalog -- 10
  npm run enrich-youtube-catalog -- --dry-run --limit 5

The catalog is saved after each successful match. Ctrl+C keeps completed work.
Restart Streamstein or click Refresh on the YouTube page to reload thumbnails.
`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(value) {
  return new Set(
    normalizeTitle(value)
      .split(" ")
      .filter((w) => w.length > 2),
  );
}

function titleScore(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) {
    if (B.has(t)) inter++;
  }
  return inter / Math.max(A.size, B.size);
}

function channelScore(channelHint, uploader, channel) {
  const hint = normalizeTitle(channelHint);
  if (!hint) return 0.5;
  const hay = normalizeTitle(`${uploader || ""} ${channel || ""}`);
  if (!hay) return 0;
  if (hay.includes(hint) || hint.includes(hay)) return 1;
  const hintTokens = hint.split(" ").filter((w) => w.length > 2);
  if (!hintTokens.length) return 0;
  let hits = 0;
  for (const t of hintTokens) {
    if (hay.includes(t)) hits++;
  }
  return hits / hintTokens.length;
}

function buildUrls(videoId, watchUrl) {
  const id = String(videoId || "").trim();
  if (!id) {
    return {
      watchUrl: watchUrl || null,
      shortUrl: null,
      thumbnailUrl: null,
    };
  }
  return {
    watchUrl: watchUrl || `https://www.youtube.com/watch?v=${id}`,
    shortUrl: `https://youtu.be/${id}`,
    thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  };
}

function needsMetadata(record) {
  if (!record || record.status !== "completed") return false;
  if (!record.videoId && !record.watchUrl) return true;
  if (!record.thumbnailUrl && record.videoId) return true;
  return false;
}

function deriveChannelName(record, youtubeRoot) {
  if (record.channelName) return record.channelName;
  const dir = record.directory;
  if (dir && youtubeRoot) {
    const rel = path.relative(path.normalize(youtubeRoot), path.normalize(dir));
    if (rel && rel !== "." && !rel.startsWith("..")) {
      return rel.split(path.sep)[0];
    }
  }
  if (record.channelKey) {
    return record.channelKey
      .replace(/vtt$/i, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return "";
}

function basenameNoExt(filePath) {
  const base = path.basename(filePath || "");
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function findYtDlp() {
  return toolPaths.resolveTool("yt-dlp");
}

function buildToolSpawnEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  const binDir = process.env.STREAMSTEIN_BIN_DIR;
  if (binDir) {
    const prefix = path.resolve(binDir);
    const pathKey = process.platform === "win32" ? "Path" : "PATH";
    const current = env[pathKey] || env.PATH || "";
    if (!current.toLowerCase().includes(prefix.toLowerCase())) {
      env[pathKey] = `${prefix}${path.delimiter}${current}`;
    }
  }
  const nodePath = process.env.STREAMSTEIN_NODE || process.execPath;
  if (nodePath && fs.existsSync(nodePath)) {
    env.ELECTRON_RUN_AS_NODE = "1";
    env.STREAMSTEIN_NODE = nodePath;
  }
  return env;
}

function runYtDlp(ytDlp, args) {
  const r = spawnSync(ytDlp, args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    env: buildToolSpawnEnv(),
  });
  return {
    ok: r.status === 0,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
    code: r.status,
  };
}

function parseYtDlpSearchResults(stdout) {
  if (!stdout) return [];
  try {
    const parsed = JSON.parse(stdout);
    const entries = Array.isArray(parsed?.entries)
      ? parsed.entries
      : parsed?.id
        ? [parsed]
        : [];
    return entries
      .filter((e) => e && (e.id || e.url))
      .map((e) => ({
        id: e.id || extractVideoId(e.url || e.webpage_url || ""),
        title: e.title || "",
        channel: e.channel || e.uploader || "",
        uploader: e.uploader || e.channel || "",
        durationSeconds: parseDurationSeconds(e.duration),
      }))
      .filter((e) => e.id);
  } catch {
    return [];
  }
}

function extractVideoId(value) {
  const s = String(value || "");
  const m =
    /(?:v=|youtu\.be\/|\/shorts\/)([a-zA-Z0-9_-]{11})/.exec(s) ||
    /^([a-zA-Z0-9_-]{11})$/.exec(s);
  return m ? m[1] : null;
}

function ytDlpSearch(ytDlp, query, limit = 8) {
  const r = runYtDlp(ytDlp, [
    "--flat-playlist",
    "--dump-single-json",
    "--no-warnings",
    "--no-playlist",
    `ytsearch${limit}:${query}`,
  ]);
  if (!r.ok) {
    return { ok: false, error: r.stderr || `exit ${r.code}`, results: [] };
  }
  return { ok: true, results: parseYtDlpSearchResults(r.stdout) };
}

function ytDlpLookup(ytDlp, videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const r = runYtDlp(ytDlp, [
    "--no-warnings",
    "--no-playlist",
    "--skip-download",
    "-j",
    url,
  ]);
  if (!r.ok || !r.stdout) return null;
  try {
    const e = JSON.parse(r.stdout);
    const id = e.id || videoId;
    if (!id) return null;
    return {
      id,
      title: e.title || "",
      channel: e.channel || e.uploader || "",
      uploader: e.uploader || e.channel || "",
      durationSeconds: parseDurationSeconds(e.duration),
    };
  } catch {
    return null;
  }
}

async function ddgYoutubeIds(query, limit = 6) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`site:youtube.com ${query}`)}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const ids = [];
    const seen = new Set();
    for (const m of html.matchAll(/youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/g)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      ids.push(m[1]);
      if (ids.length >= limit) break;
    }
    for (const m of html.matchAll(/youtu\.be\/([a-zA-Z0-9_-]{11})/g)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      ids.push(m[1]);
      if (ids.length >= limit) break;
    }
    return ids;
  } catch {
    return [];
  }
}

function pickBestCandidate(candidates, record, youtubeRoot, matchConfig) {
  return pickBestCandidateWithConfig(candidates, record, youtubeRoot, matchConfig);
}

async function enrichCandidateDurations(ytDlp, candidates, limit = 24) {
  if (!ytDlp) return;
  let looked = 0;
  for (const c of candidates) {
    if (parseDurationSeconds(c.durationSeconds)) continue;
    if (looked >= limit) break;
    const meta = ytDlpLookup(ytDlp, c.id);
    looked++;
    if (meta?.durationSeconds) c.durationSeconds = meta.durationSeconds;
    if (meta?.title && !c.title) c.title = meta.title;
    if (meta?.channel && !c.channel) c.channel = meta.channel;
    if (meta?.uploader && !c.uploader) c.uploader = meta.uploader;
  }
}

async function collectCandidatesForRecord(ytDlp, record, youtubeRoot, matchConfig) {
  const normalized = normalizeMatchConfig(matchConfig);
  const queries = buildSearchQueries(record, youtubeRoot, matchConfig);
  const localDur = parseDurationSeconds(record.durationSeconds);
  const looseQueries =
    normalized.durationMatch.enabled && localDur
      ? buildLooseSearchQueries(record, youtubeRoot, matchConfig)
      : [];
  const allQueries = [...new Set([...queries, ...looseQueries])];
  const seen = new Set();
  const candidates = [];

  const addCandidate = (c) => {
    if (!c?.id || seen.has(c.id)) return;
    seen.add(c.id);
    candidates.push(c);
  };

  if (ytDlp) {
    for (const query of allQueries) {
      const search = ytDlpSearch(ytDlp, query, 10);
      if (search.ok && search.results.length) {
        for (const r of search.results) addCandidate(r);
      }
    }
  }

  for (const query of allQueries) {
    const ids = await ddgYoutubeIds(query, 8);
    for (const id of ids) {
      if (ytDlp) {
        const meta = ytDlpLookup(ytDlp, id);
        if (meta) addCandidate(meta);
      } else {
        addCandidate({ id, title: "", channel: "", uploader: "" });
      }
    }
  }

  if (localDur && normalized.durationMatch.enabled) {
    await enrichCandidateDurations(ytDlp, candidates);
  }

  return candidates;
}

function applyMetadata(record, meta, source) {
  const urls = buildUrls(meta.id, meta.watchUrl);
  record.videoId = meta.id;
  record.watchUrl = urls.watchUrl;
  record.shortUrl = urls.shortUrl;
  record.thumbnailUrl = urls.thumbnailUrl;
  if (meta.channel && !record.channelName) record.channelName = meta.channel;
  if (meta.uploader && !record.channelName) record.channelName = meta.uploader;
  record.updatedAt = new Date().toISOString();
  record.metadataEnrichedAt = record.updatedAt;
  record.metadataEnrichedBy = source;
  return record;
}

function loadCatalog(catalogPath) {
  const raw = fs.readFileSync(catalogPath, "utf8");
  const catalog = JSON.parse(raw);
  if (!Array.isArray(catalog.records)) {
    throw new Error("Invalid catalog: missing records array");
  }
  return catalog;
}

function resolveCatalogPath(opts) {
  if (opts.catalog) return path.resolve(opts.catalog);
  const primary = path.join(path.resolve(opts.folder), "youtube-catalog.json");
  const mirror = getMirrorCatalogPath();
  if (fs.existsSync(primary)) return primary;
  if (fs.existsSync(mirror)) return mirror;
  return primary;
}

function buildSiblingIndex(records) {
  const byLibraryId = new Map();
  const byFileKey = new Map();
  for (const r of records) {
    if (r.libraryEntryId && r.videoId) {
      if (!byLibraryId.has(r.libraryEntryId)) byLibraryId.set(r.libraryEntryId, r);
    }
    if (r.filePath && r.videoId) {
      const key = `${path.normalize(r.directory || path.dirname(r.filePath))}::${basenameNoExt(r.filePath).toLowerCase()}`;
      byFileKey.set(key, r);
    }
  }
  return { byLibraryId, byFileKey };
}

function registerInIndex(index, record) {
  if (record.libraryEntryId && record.videoId) {
    if (!index.byLibraryId.has(record.libraryEntryId)) {
      index.byLibraryId.set(record.libraryEntryId, record);
    }
  }
  if (record.filePath && record.videoId) {
    const key = `${path.normalize(record.directory || path.dirname(record.filePath))}::${basenameNoExt(record.filePath).toLowerCase()}`;
    if (!index.byFileKey.has(key)) index.byFileKey.set(key, record);
  }
}

function copyFromSibling(record, index) {
  if (record.libraryEntryId) {
    const sib = index.byLibraryId.get(record.libraryEntryId);
    if (sib?.videoId) return sib;
  }
  if (record.filePath) {
    const key = `${path.normalize(record.directory || path.dirname(record.filePath))}::${basenameNoExt(record.filePath).toLowerCase()}`;
    const sib = index.byFileKey.get(key);
    if (sib?.videoId) return sib;
  }
  return null;
}

function isSameLogicalFile(recordA, recordB) {
  if (!recordA?.filePath || !recordB?.filePath) return false;
  const dirA = path.normalize(recordA.directory || path.dirname(recordA.filePath));
  const dirB = path.normalize(recordB.directory || path.dirname(recordB.filePath));
  if (dirA !== dirB) return false;
  const baseA = stripWindowsDuplicateBasename(
    basenameNoExt(recordA.filePath),
  ).toLowerCase();
  const baseB = stripWindowsDuplicateBasename(
    basenameNoExt(recordB.filePath),
  ).toLowerCase();
  return baseA === baseB;
}

function syncPairedRecords(records, record, meta, source, { singleRecord = false } = {}) {
  const paired = records.filter((r) => {
    if (r.id === record.id || r.assetType !== "video") return false;
    if (r.libraryEntryId && r.libraryEntryId === record.libraryEntryId) {
      return true;
    }
    if (!isSameLogicalFile(r, record)) return false;
    if (singleRecord) {
      const base = basenameNoExt(r.filePath);
      return (
        isWindowsCopyBasename(base) ||
        isWindowsNumberedCopyBasename(base)
      );
    }
    return true;
  });
  for (const p of paired) {
    applyMetadata(p, meta, source);
  }
  return paired.length;
}

function dedupeAfterMetadataWrite(catalog, writer, opts, recordIdFilter) {
  if (recordIdFilter) {
    return { removedCount: 0, removedRecords: [], deletedFiles: [] };
  }
  const result = dedupeWindowsCopyRecords(catalog.records, {
    deleteCopyFiles: true,
  });
  if (result.removedCount > 0) {
    writer.save();
    const names = result.removedRecords
      .map((r) => path.basename(r.filePath || r.title || r.id))
      .join(", ");
    if (opts.verbose) {
      console.log(
        `  deduped ${result.removedCount} Windows copy duplicate(s): ${names}`,
      );
    }
    if (result.deletedFiles.length && opts.verbose) {
      console.log(`  removed copy file(s) from disk`);
    }
  }
  return result;
}

function createCatalogWriter(catalogPath, catalog, dryRun) {
  let backupPath = null;
  let savedCount = 0;

  function writeCatalog() {
    if (dryRun) return;

    catalog.updatedAt = new Date().toISOString();
    const payload = JSON.stringify(catalog, null, 2);

    if (!backupPath) {
      backupPath = `${catalogPath}.bak-${Date.now()}`;
      fs.copyFileSync(catalogPath, backupPath);
      console.log(`Backup created: ${backupPath}`);
    }

    fs.writeFileSync(catalogPath, payload, "utf8");
    savedCount++;

    const mirror = getMirrorCatalogPath();
    if (
      path.resolve(catalogPath) !== path.resolve(mirror) &&
      fs.existsSync(path.dirname(mirror))
    ) {
      fs.writeFileSync(mirror, payload, "utf8");
    }
  }

  return {
    save() {
      writeCatalog();
    },
    get savedCount() {
      return savedCount;
    },
    get backupPath() {
      return backupPath;
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  toolPaths.publishBundledEnv();

  let matchConfig = normalizeMatchConfig(DEFAULT_MATCH_CONFIG);
  if (process.env.STREAMSTEIN_ENRICH_MATCH) {
    try {
      matchConfig = normalizeMatchConfig(
        JSON.parse(process.env.STREAMSTEIN_ENRICH_MATCH),
      );
    } catch {
      console.warn("Warning: invalid STREAMSTEIN_ENRICH_MATCH env — using defaults.");
    }
  } else if (opts.matchConfig) {
    matchConfig = normalizeMatchConfig(opts.matchConfig);
  }
  if (Number.isFinite(opts.minScore)) {
    matchConfig = { ...matchConfig, minScore: opts.minScore };
  }

  const catalogPath = resolveCatalogPath(opts);
  const youtubeRoot = path.resolve(opts.folder);

  if (!fs.existsSync(catalogPath)) {
    console.error(`Catalog not found: ${catalogPath}`);
    console.error("Set --folder or --catalog to your youtube-catalog.json location.");
    process.exit(1);
  }

  const catalog = loadCatalog(catalogPath);
  const ytDlp = findYtDlp();
  let index = buildSiblingIndex(catalog.records);
  const writer = createCatalogWriter(catalogPath, catalog, opts.dryRun);

  const recordIdFilter = opts.recordId ? String(opts.recordId).trim() : "";

  if (!opts.dryRun && !recordIdFilter) {
    const initialDedupe = dedupeWindowsCopyRecords(catalog.records, {
      deleteCopyFiles: true,
    });
    if (initialDedupe.removedCount > 0) {
      writer.save();
      index = buildSiblingIndex(catalog.records);
      console.log(
        `Removed ${initialDedupe.removedCount} duplicate Windows "Copy" catalog entries before sync.`,
      );
    }
  }

  let targets = catalog.records.filter((r) => {
    if (r.assetType !== "video") return false;
    const ext = (r.extension || path.extname(r.filePath || "")).toLowerCase();
    if (r.filePath && !VIDEO_EXTS.has(ext)) return false;
    if (recordIdFilter) {
      return r.id === recordIdFilter;
    }
    return needsMetadata(r);
  });

  if (recordIdFilter && !targets.length) {
    console.error(`No catalog video record found for id: ${recordIdFilter}`);
    console.log(
      "__STREAMSTEIN_ENRICH_SUMMARY__" +
        JSON.stringify({
          updated: 0,
          skipped: 1,
          processed: 0,
          dryRun: opts.dryRun,
          interrupted: false,
          catalogPath,
          backupPath: null,
          savedCount: 0,
          targetsTotal: 0,
          recordId: recordIdFilter,
          mode: "single",
          error: "record_not_found",
        }),
    );
    process.exit(0);
  }

  if (recordIdFilter) {
    opts.limit = 1;
    opts.delayMs = Math.min(opts.delayMs, 800);
  }

  const limitLabel = recordIdFilter
    ? "1 (single video)"
    : Number.isFinite(opts.limit)
      ? String(opts.limit)
      : "all";

  console.log(`Catalog: ${catalogPath}`);
  console.log(`YouTube folder: ${youtubeRoot}`);
  console.log(
    recordIdFilter
      ? `Single-video metadata sync: ${targets[0]?.title || targets[0]?.fileName || recordIdFilter}`
      : `Records needing metadata: ${targets.length}`,
  );
  console.log(`Process limit: ${limitLabel}`);
  console.log(`Matching: ${describeMatchConfig(matchConfig)} (threshold ${matchConfig.minScore})`);
  console.log(describeDurationMatch(matchConfig));
  console.log(`yt-dlp: ${ytDlp || "(not found — will use DuckDuckGo only)"}`);
  if (opts.dryRun) {
    console.log("DRY RUN — catalog will not be written\n");
  } else {
    console.log("Saving to catalog after each match (Ctrl+C safe)\n");
  }

  let updated = 0;
  let skipped = 0;
  let processed = 0;
  let interrupted = false;

  const onSignal = () => {
    interrupted = true;
    console.log("\n\nInterrupted — finishing current item then exiting…");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  for (const record of targets) {
    if (interrupted || processed >= opts.limit) break;
    processed++;

    const title = record.title || record.fileName || basenameNoExt(record.filePath);
    const channelHint = deriveChannelName(record, youtubeRoot);
    const label = `[${channelHint || "?"}] ${title}`;

    const sibling = copyFromSibling(record, index);
    if (sibling?.videoId) {
      const meta = {
        id: sibling.videoId,
        watchUrl: sibling.watchUrl,
        channel: sibling.channelName,
        uploader: sibling.channelName,
      };
      applyMetadata(record, meta, "sibling");
      syncPairedRecords(catalog.records, record, meta, "sibling", {
        singleRecord: Boolean(recordIdFilter),
      });
      registerInIndex(index, record);
      writer.save();
      console.log(`✓ sibling  ${label} → ${sibling.videoId}  (saved)`);
      updated++;
      continue;
    }

    const probedDur = ensureRecordDurationSeconds(record, {
      save: () => writer.save(),
    });
    if (probedDur && opts.verbose) {
      console.log(
        `  local duration: ${formatDurationClock(probedDur)} (${probedDur}s)`,
      );
    }

    const queryPreview = buildSearchQueries(record, youtubeRoot, matchConfig).join(" | ");
    let best = null;
    let source = null;

    const candidates = await collectCandidatesForRecord(
      ytDlp,
      record,
      youtubeRoot,
      matchConfig,
    );
    best = pickBestCandidate(candidates, record, youtubeRoot, matchConfig);
    if (best) {
      source = ytDlp ? "yt-dlp+match" : "duckduckgo";
    }

    if (!best && opts.verbose && queryPreview) {
      console.log(`  search queries: ${queryPreview}`);
    }

    if (!best) {
      console.log(
        `✗ no match ${label} (best score below ${matchConfig.minScore})`,
      );
      skipped++;
      if (processed < opts.limit && !interrupted) await sleep(opts.delayMs);
      continue;
    }

    applyMetadata(
      record,
      {
        id: best.id,
        channel: best.channel,
        uploader: best.uploader,
      },
      source,
    );

    syncPairedRecords(
      catalog.records,
      record,
      { id: best.id, channel: best.channel, uploader: best.uploader },
      source,
      { singleRecord: Boolean(recordIdFilter) },
    );
    registerInIndex(index, record);
    writer.save();
    const dedupeResult = dedupeAfterMetadataWrite(
      catalog,
      writer,
      opts,
      recordIdFilter,
    );
    if (dedupeResult.removedCount > 0) {
      index = buildSiblingIndex(catalog.records);
    }

    const durNote =
      best.durationMatched && parseDurationSeconds(record.durationSeconds)
        ? ` · duration ${formatDurationClock(record.durationSeconds)}`
        : "";
    const scoreNote = `score ${best.combined.toFixed(2)}${
      best.durationMatched ? " (duration-confirmed)" : ""
    }`;
    console.log(`✓ ${source}  ${label} → ${best.id} (${scoreNote}${durNote})  (saved)`);
    updated++;

    if (processed < opts.limit && !interrupted) await sleep(opts.delayMs);
  }

  if (!opts.dryRun && !interrupted && !recordIdFilter) {
    const finalDedupe = dedupeWindowsCopyRecords(catalog.records, {
      deleteCopyFiles: true,
    });
    if (finalDedupe.removedCount > 0) {
      writer.save();
      console.log(
        `Final dedupe: removed ${finalDedupe.removedCount} Windows copy duplicate(s).`,
      );
    }
  }

  console.log("");
  if (updated === 0) {
    console.log("No records updated.");
  } else if (opts.dryRun) {
    console.log(`Dry run complete — would update ${updated} record(s).`);
  } else {
    console.log(`Updated ${updated} record(s), skipped ${skipped}, processed ${processed}.`);
    console.log(`Catalog writes: ${writer.savedCount}`);
    if (writer.backupPath) console.log(`Backup: ${writer.backupPath}`);
    console.log(`Catalog: ${catalogPath}`);
    console.log("\nReload Streamstein or click Refresh on the YouTube page to see thumbnails.");
  }

  if (interrupted) {
    console.log("(Stopped early — all completed matches were already saved.)");
  }

  if (processed >= opts.limit && targets.length > processed) {
    console.log(`\nLimit of ${opts.limit} reached. Run again to continue remaining records.`);
  }

  console.log(
    "__STREAMSTEIN_ENRICH_SUMMARY__" +
      JSON.stringify({
        updated,
        skipped,
        processed,
        dryRun: opts.dryRun,
        interrupted,
        catalogPath,
        backupPath: writer.backupPath || null,
        savedCount: writer.savedCount,
        targetsTotal: targets.length,
        recordId: recordIdFilter || null,
        mode: recordIdFilter ? "single" : "batch",
      }),
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err?.message || err);
    console.log(
      "__STREAMSTEIN_ENRICH_SUMMARY__" +
        JSON.stringify({
          updated: 0,
          skipped: 0,
          processed: 0,
          dryRun: false,
          interrupted: false,
          error: err?.message || String(err),
        }),
    );
    process.exit(0);
  });
}

module.exports = { main, parseArgs };
