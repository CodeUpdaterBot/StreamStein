#!/usr/bin/env node
/**
 * Comments catch-up — fetch and store YouTube comments for the whole library.
 *
 *   node scripts/comments-catchup.cjs [options]
 *
 *     --limit N        stop after N videos (pilot runs)
 *     --max N          comments ceiling PER VIDEO (default 10000)
 *     --max-total N    comments budget for the whole library (default 10000000);
 *                      the run stops cleanly when stored total reaches it
 *     --only-capped    re-fetch only videos a previous run had to cap
 *     --delay MS       base delay between videos (default 3000, jittered ±50%)
 *     --force          refetch even when a sidecar already exists
 *     --dry-run        list what would be fetched, fetch nothing
 *     --sort new|old   process newest/oldest first by catalog completedAt
 *                     (default: library order — channel folder, then filename)
 *
 * Why a script and not the app: this runs for hours and must survive the app being
 * closed, restarted, or updated. It reuses the app's own module
 * (src/ipc/youtubeComments.js), so it writes exactly the same sidecar document and
 * the same catalog records the in-app button writes — there is one implementation,
 * not two.
 *
 * Safe to stop and re-run: everything is recorded in a state file, finished videos
 * are skipped, and the sidecar on disk is the second source of truth.
 *
 * State/log: %APPDATA%/streamstein/comments-catchup/{state.json,catchup.log,summary.json}
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const comments = require("../src/ipc/youtubeComments");

// ── Args ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(name);

const LIMIT = Number(argOf("--limit", 0)) || 0;
const MAX_COMMENTS = Number(argOf("--max", comments.DEFAULT_MAX_COMMENTS));
// Library-wide budget. The per-video ceiling protects one video; this protects the
// whole run from ballooning (10M comments is the agreed ceiling for the library).
const MAX_TOTAL_COMMENTS = Number(argOf("--max-total", 10_000_000));
const BASE_DELAY_MS = Number(argOf("--delay", 3000));
const FORCE = flag("--force");
// Re-fetch only the videos a previous run had to cap, at the new (higher) ceiling.
const ONLY_CAPPED = flag("--only-capped");
// Re-fetch pass for the depth bug: until MAX_REPLY_DEPTH was passed explicitly, yt-dlp
// capped reply chains at depth 3, so every sidecar whose deepest chain reached level 3 is
// provably incomplete (measured: 697 of 1,020 videos sat exactly on that wall, none went
// deeper). Videos whose deepest chain is < 3 never met the cap and are complete, so this
// pass deliberately targets only the ones that lost data.
const ONLY_SHALLOW = flag("--only-shallow");
const OLD_DEPTH_CAP = 3;
const DRY_RUN = flag("--dry-run");
const SORT = argOf("--sort", "library");
// Sharding for parallel workers: --shard 0/3, --shard 1/3, --shard 2/3. Written as a
// single arg because it is passed through a .cmd launcher.
const SHARD_SPEC = String(argOf("--shard", "0/1"));
const [SHARD_INDEX, SHARD_COUNT] = SHARD_SPEC.split("/").map((n) => Number(n) || 0);
if (!Number.isInteger(SHARD_INDEX) || !Number.isInteger(SHARD_COUNT) || SHARD_COUNT < 1 || SHARD_INDEX < 0 || SHARD_INDEX >= SHARD_COUNT) {
  console.error(`bad --shard "${SHARD_SPEC}" — expected i/N with 0 <= i < N, e.g. 0/3`);
  process.exit(2);
}
const SHARD_SUFFIX = SHARD_COUNT > 1 ? `-shard${SHARD_INDEX + 1}of${SHARD_COUNT}` : "";

const YOUTUBE_FOLDER =
  process.env.STREAMSTEIN_YOUTUBE_FOLDER ||
  path.join(os.homedir(), "Downloads", "YouTube");

// ── Paths ────────────────────────────────────────────────────────────────────

function stateDir() {
  const base =
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const dir = path.join(base, "streamstein", "comments-catchup");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const STATE_DIR = stateDir();
const STATE_FILE = path.join(STATE_DIR, `state${SHARD_SUFFIX}.json`);
const LOG_FILE = path.join(STATE_DIR, `catchup${SHARD_SUFFIX}.log`);
const SUMMARY_FILE = path.join(STATE_DIR, `summary${SHARD_SUFFIX}.json`);
// Pre-shard history. A shard has no record of the videos an earlier single-worker run
// captured, so it seeds its comment budget from there to stay conservative.
const LEGACY_STATE_FILE = path.join(STATE_DIR, "state.json");

const loadJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJson = (file, value) => {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
};

let logStream = null;
function log(line) {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const text = `[${stamp}] ${line}`;
  if (!logStream) logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  logStream.write(`${text}\n`);
  console.log(text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── State ────────────────────────────────────────────────────────────────────

const state = loadJson(STATE_FILE, {
  startedAt: null,
  updatedAt: null,
  runs: 0,
  processed: {}, // key = normalized video file path -> record
  failures: {},
});

state.runs = (state.runs || 0) + 1;
state.startedAt = state.startedAt || new Date().toISOString();

const keyOf = (filePath) => path.normalize(filePath).toLowerCase();

// ── Throttle coordination ────────────────────────────────────────────────────
// Running several workers in parallel can earn HTTP 403s from YouTube's comment API
// (measured 2026-11-11: after ~45 min of 3 workers, all three shards started returning
// "Unable to download API page: HTTP Error 403: Forbidden"). A per-worker backoff is not
// enough — the workers keep each other blocked. So a cooldown is written to a shared file
// that EVERY worker checks before each fetch, and they all wait it out together. That
// turns "three workers hammering a blocked endpoint" into one polite queue.
const COOLDOWN_FILE = path.join(STATE_DIR, "cooldown.json");
const THROTTLE_COOLDOWN_MS = 10 * 60 * 1000;
// Rotating the client set is the FIRST response to a 403, not waiting: YouTube grants
// comment access per client and blocks them individually (measured 2026-11-11: web and ios
// were 403 while tv/android_vr/mweb still answered). So a blocked client set is swapped for
// a fresh one, and only a short pause is needed while that happens. The long escalating
// cooldown stays for the case where EVERY set is blocked, which is a real IP-level flag.
const CLIENT_SETS = ["tv,android_vr,mweb", "web,ios,android", "mweb,tv", "android_vr"];
const ROTATE_COOLDOWN_MS = 90 * 1000;
const THROTTLE_PATTERN =
  /http error 403|forbidden|too many requests|http error 429|sign in to confirm you.?re not a bot/i;

function readCooldown() {
  const cd = loadJson(COOLDOWN_FILE, null);
  if (!cd || typeof cd.until !== "number") return null;
  return cd;
}

// ── Client rotation ─────────────────────────────────────────────────────────
// Kept in its own file so rotating never clobbers an in-flight cooldown (and vice versa).
const CLIENT_SET_FILE = path.join(STATE_DIR, "client-set.json");

function clientSetIndex() {
  const d = loadJson(CLIENT_SET_FILE, null);
  return d && Number.isFinite(d.index) ? d.index : 0;
}

/** The client set every worker should use right now. */
function activeClientSet() {
  return CLIENT_SETS[clientSetIndex() % CLIENT_SETS.length];
}

/** Switch every worker to the next client set; returns the one now active. */
function rotateClientSet(reason) {
  const next = clientSetIndex() + 1;
  writeJson(CLIENT_SET_FILE, {
    index: next,
    reason,
    setBy: SHARD_SUFFIX || "single",
    at: new Date().toISOString(),
  });
  return CLIENT_SETS[next % CLIENT_SETS.length];
}

function setCooldown(ms, reason) {
  // If we get blocked again almost immediately after the previous cooldown expired, the
  // pause was too short — escalate rather than cycle 10 minutes at a time making no
  // progress. Capped at 30 min so the run always resumes on its own.
  const prev = readCooldown();
  const sinceExpiry = prev?.until ? Date.now() - prev.until : Infinity;
  const escalate = sinceExpiry >= 0 && sinceExpiry < 5 * 60 * 1000;
  const wait = escalate ? Math.min(ms * 2, 30 * 60 * 1000) : ms;

  const until = Date.now() + wait;
  if (prev && prev.until > until) return; // an existing longer cooldown wins
  writeJson(COOLDOWN_FILE, {
    until,
    reason,
    waitMs: wait,
    escalated: escalate,
    setBy: SHARD_SUFFIX || "single",
    at: new Date().toISOString(),
  });
}

/** Block until any shared cooldown expires, logging once per wait. */
async function waitForCooldown() {
  for (;;) {
    const cd = readCooldown();
    if (!cd || cd.until <= Date.now()) return;
    const wait = cd.until - Date.now();
    if (wait > 1500) {
      log(
        `cooldown active: ${Math.ceil(wait / 1000)}s left (${cd.reason}, set by ${cd.setBy}) — waiting`,
      );
    }
    await sleep(Math.min(wait, 30_000));
  }
}

/** Turn a yt-dlp failure into a short, human-readable permanent-skip reason. */
function shortPermanentReason(detail) {
  if (/members-only|join this channel/i.test(detail)) {
    return "members-only video (needs channel membership cookies)";
  }
  if (/sign in to confirm your age|age-restricted|may be inappropriate for some users/i.test(detail)) {
    return "age-restricted (needs YouTube cookies)";
  }
  if (
    /video unavailable|video is unavailable|removed by the uploader|no longer available|this video is not available/i.test(
      detail,
    )
  ) {
    return "video unavailable (removed or region-blocked)";
  }
  if (/private video/i.test(detail)) return "private video";
  return "permanently unavailable to yt-dlp";
}

async function main() {
// ── Build the work list ──────────────────────────────────────────────────────

const catalogPath = comments.catalogPathFor(YOUTUBE_FOLDER);
const catalog = loadJson(catalogPath, null);
if (!catalog || !Array.isArray(catalog.records)) {
  log(`FATAL no usable catalog at ${catalogPath}`);
  process.exit(2);
}

/** Videos that are on disk (a sidecar needs a real video beside it). */
const videos = catalog.records.filter(
  (r) =>
    r.assetType === "video" &&
    r.status === "completed" &&
    r.filePath &&
    r.filePath.toLowerCase().endsWith(".mp4"),
);

let missing = 0;
const withFile = [];
for (const v of videos) {
  if (fs.existsSync(v.filePath)) withFile.push(v);
  else missing += 1;
}

const basenameNoExt = (filePath) => {
  const base = path.basename(filePath || "");
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
};
const siblingKeyOf = (r) =>
  `${path.normalize(r.directory || path.dirname(r.filePath || ""))}::${basenameNoExt(r.filePath).toLowerCase()}`;

/**
 * 65 video records carry neither a videoId nor a watchUrl — an older importer left
 * them without one. A sibling transcript record usually still has the id, so that
 * is where we recover it. Guessing the video by title search is NOT done on purpose:
 * a wrong match would silently attach a stranger's comments to this video.
 */
const idFromTranscript = new Map();
for (const r of catalog.records) {
  if (r && r.assetType === "transcript" && r.videoId && r.filePath) {
    idFromTranscript.set(siblingKeyOf(r), r.videoId);
  }
}

const fetchable = [];
let noUrl = 0;
state.skippedNoUrl = state.skippedNoUrl || {};
for (const v of withFile) {
  if (v.videoId || v.watchUrl) {
    fetchable.push(v);
    continue;
  }
  const recovered = idFromTranscript.get(siblingKeyOf(v));
  if (recovered) {
    v.videoId = recovered;
    v.videoIdSource = "sibling-transcript";
    fetchable.push(v);
    continue;
  }
  noUrl += 1;
  state.skippedNoUrl[keyOf(v.filePath)] = {
    fileName: v.fileName,
    reason: "no videoId/watchUrl in the catalog and none recoverable from a sibling transcript",
    at: new Date().toISOString(),
  };
}

/** Already captured: sidecar exists on disk, or the state says it is done. */
const alreadyCaptured = new Set();
const existingSidecar = [];
if (!FORCE) {
  for (const v of fetchable) {
    const sidecar = comments.commentsPathFor(v.filePath);
    if (sidecar && fs.existsSync(sidecar)) {
      alreadyCaptured.add(keyOf(v.filePath));
      existingSidecar.push(sidecar);
    }
  }
}

// Sharding happens on the FULL fetchable list, never on "what is left to do": every
// worker must derive the same assignment from the same list, so a video always belongs
// to the same worker no matter what has been captured in the meantime. Workers can then
// run in parallel without ever touching the same video.
const myShard = fetchable.filter((_, i) => i % SHARD_COUNT === SHARD_INDEX);

let queue = myShard.filter((v) => !alreadyCaptured.has(keyOf(v.filePath)));

// Re-capture pass: only the videos a previous run had to cap at the old, lower ceiling.
// Their sidecars exist, so this deliberately ignores the skip above.
if (ONLY_CAPPED) {
  queue = myShard.filter((v) => state.processed[keyOf(v.filePath)]?.truncated === true);
}

// Depth re-fetch pass: videos whose stored thread hit the old depth-3 cap. Reads the sidecar
// because that is where maxDepth is recorded.
if (ONLY_SHALLOW) {
  const hitDepthCap = (filePath) => {
    const sidecar = comments.commentsPathFor(filePath);
    if (!sidecar || !fs.existsSync(sidecar)) return false;
    try {
      const doc = JSON.parse(fs.readFileSync(sidecar, "utf8"));
      const md = doc?.stats?.maxDepth;
      return Number.isFinite(md) && md >= OLD_DEPTH_CAP;
    } catch {
      return false;
    }
  };
  queue = myShard.filter((v) => hitDepthCap(v.filePath));
}

// Videos already known to be permanently unavailable (members-only, removed) are not
// retried on later runs. --force overrides, for the day the user supplies cookies.
const permanentSkips = new Set(Object.keys(state.skippedPermanent || {}));
if (permanentSkips.size > 0 && !FORCE) {
  queue = queue.filter((v) => !permanentSkips.has(keyOf(v.filePath)));
}

if (SORT === "new") {
  queue.sort((a, b) => String(b.completedAt || "").localeCompare(String(a.completedAt || "")));
} else if (SORT === "old") {
  queue.sort((a, b) => String(a.completedAt || "").localeCompare(String(b.completedAt || "")));
} else {
  queue.sort((a, b) =>
    `${a.directory || ""}\u0000${a.fileName || ""}`.localeCompare(
      `${b.directory || ""}\u0000${b.fileName || ""}`,
    ),
  );
}

if (LIMIT > 0) queue = queue.slice(0, LIMIT);

log(
  `start: catalog videos=${videos.length} onDisk=${withFile.length} missingOnDisk=${missing} ` +
    `noUrlSkipped=${noUrl} alreadyCaptured=${alreadyCaptured.size} queue=${queue.length} ` +
    `maxComments=${MAX_COMMENTS} maxTotal=${MAX_TOTAL_COMMENTS} delay=${BASE_DELAY_MS}ms ` +
    `order=${SORT} commentSort=${comments.DEFAULT_COMMENT_SORT} clients=[${activeClientSet()}]` +
    `${FORCE ? " force" : ""}` +
    `${ONLY_CAPPED ? " onlyCapped" : ""}` +
    `${ONLY_SHALLOW ? " onlyShallow(depth<" + OLD_DEPTH_CAP + " skipped)" : ""}` +
    `${SHARD_COUNT > 1 ? ` shard=${SHARD_INDEX + 1}/${SHARD_COUNT}` : ""}` +
    `${permanentSkips.size ? ` permanentSkipped=${permanentSkips.size}` : ""}`,
);

/**
 * Library-wide budget, counted across runs: every comment this state file knows about,
 * plus what is already sitting in sidecars. The per-video ceiling protects one video from
 * being unbounded; this protects the library as a whole.
 *
 * A sharded worker also seeds from the pre-shard state, because videos captured before
 * sharding are invisible to it. That over-counts the library total once per worker, which
 * is the safe direction: the budget stops the run slightly early rather than late.
 */
const legacyState = SHARD_COUNT > 1 ? loadJson(LEGACY_STATE_FILE, { processed: {} }) : { processed: {} };
let storedTotal =
  Object.values(state.processed).reduce((n, v) => n + (v.stored || 0), 0) +
  Object.values(legacyState.processed || {}).reduce((n, v) => n + (v.stored || 0), 0);
log(
  `budget: ${storedTotal.toLocaleString()} comments already stored against a ceiling of ` +
    `${MAX_TOTAL_COMMENTS.toLocaleString()}${SHARD_COUNT > 1 ? ` (shard ${SHARD_INDEX + 1}/${SHARD_COUNT}, includes pre-shard history)` : ""}`,
);

if (DRY_RUN) {
  for (const v of queue.slice(0, 25)) log(`  would fetch: ${v.fileName}`);
  if (queue.length > 25) log(`  … and ${queue.length - 25} more`);
  return;
}

// ── Run ──────────────────────────────────────────────────────────────────────

const run = {
  startedAt: new Date().toISOString(),
  ok: 0,
  zeroComments: 0,
  failed: 0,
  skippedPermanent: 0,
  throttled: 0,
  storedComments: 0,
  consecutiveFailures: 0,
  lastDelayMs: BASE_DELAY_MS,
};

let stopping = false;
const save = () => {
  state.updatedAt = new Date().toISOString();
  writeJson(STATE_FILE, state);
};
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  log(`received ${signal} — stopping after the current video`);
  save();
};

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

/**
 * Adaptive politeness: YouTube starts refusing comment endpoints when hammered, so
 * a run of failures backs the whole queue off instead of grinding through the rest
 * of the library collecting errors.
 */
async function backoff(consecutiveFailures) {
  if (consecutiveFailures < 3) return;
  const pauseMs = Math.min(10 * 60 * 1000, 20000 * (consecutiveFailures - 2));
  log(`backoff: ${consecutiveFailures} consecutive failures — pausing ${Math.round(pauseMs / 1000)}s`);
  await sleep(pauseMs);
}

let index = 0;
const total = queue.length;

for (const video of queue) {
  if (stopping) break;

  // Graceful drain: budget-watch.py writes this when the current egress IP is close to its
  // comment budget. Exit BEFORE starting another fetch so the switch costs no wasted work —
  // being killed mid-fetch loses the fetch AND re-spends budget on a later IP when the video
  // is queued again.
  const drain = loadJson(path.join(STATE_DIR, "drain.json"), null);
  if (drain) {
    log(
      `drain requested (${drain.reason || "budget"}) — stopping after ${index} videos so the ` +
        `VPN can switch IP without wasting the fetch in flight`,
    );
    stopping = true;
    break;
  }

  index += 1;

  const label = `${video.channelName || path.basename(video.directory || "")} / ${video.fileName}`;
  const started = Date.now();

  let attempts = 0;
  let result = null;
  let maxAttempts = 2;
  let throttled = false;
  while (attempts < maxAttempts && !result?.ok) {
    attempts += 1;
    // Never start a fetch while the shared cooldown is active.
    await waitForCooldown();
    result = await comments.fetchCommentsForVideo({
      videoFilePath: video.filePath,
      videoId: video.videoId || undefined,
      watchUrl: video.watchUrl || undefined,
      title: video.title || undefined,
      channelName: video.channelName || undefined,
      youtubeFolder: YOUTUBE_FOLDER,
      maxComments: MAX_COMMENTS,
      clients: activeClientSet(),
    });
    if (!result.ok) {
      const detail = `${result.error || ""} ${result.stderr || ""}`;
      if (THROTTLE_PATTERN.test(detail)) {
        throttled = true;
        maxAttempts = 3;
        const blockedSet = activeClientSet();
        const nextSet = rotateClientSet(`403 on ${blockedSet}`);
        // A fresh client set normally answers straight away, so pause only long enough to
        // let the other workers notice the rotation. Once every set has been tried, the
        // long escalating cooldown takes over — that means a real IP-level flag, not one
        // blocked client.
        const stillRotating = clientSetIndex() <= CLIENT_SETS.length;
        const wait = stillRotating ? ROTATE_COOLDOWN_MS : THROTTLE_COOLDOWN_MS;
        setCooldown(
          wait,
          `HTTP 403/429 on ${blockedSet} -> rotating all workers to ${nextSet}`,
        );
        log(
          `throttled on client set [${blockedSet}] — rotating all workers to [${nextSet}] ` +
            `and pausing ${Math.round(wait / 1000)}s before retrying ${label}`,
        );
      }
      if (attempts < maxAttempts) {
        log(`retry (${attempts}/${maxAttempts}) ${label}: ${result.error}`);
        await sleep(5000);
      }
    }
  }

  const elapsed = Math.round((Date.now() - started) / 1000);
  const key = keyOf(video.filePath);

  if (result?.ok) {
    const stored = result.stats?.stored ?? 0;
    state.processed[key] = {
      videoId: video.videoId || null,
      fileName: video.fileName,
      stored,
      reported: result.stats?.reportedCount ?? null,
      replies: result.stats?.replies ?? null,
      truncated: !!result.stats?.truncated,
      warnings: result.warnings || [],
      path: result.path,
      at: new Date().toISOString(),
      elapsedSec: elapsed,
    };
    delete state.failures[key];

    run.ok += 1;
    run.storedComments += stored;
    storedTotal += stored;
    if (stored === 0) run.zeroComments += 1;
    run.consecutiveFailures = 0;
    run.lastDelayMs = BASE_DELAY_MS;

    log(
      `[${index}/${total}] ok ${stored} comments` +
        `${result.stats?.truncated ? " (capped)" : ""} in ${elapsed}s — ${label}` +
        `${result.warnings?.length ? ` | ${result.warnings.join("; ")}` : ""}`,
    );
  } else {
    // Some errors are permanent and per-video, not transient failures: a members-only
    // video, a removed/private one. Retrying costs a full second fetch each time and
    // pollutes the failure count, which should mean "something to look at". Measured
    // 2026-11-11: 5 of the first 373 videos were members-only (yt-dlp: "Join this
    // channel to get access to members-only content").
    const detail = `${result?.error || ""} ${result?.stderr || ""}`;
    const permanentPattern =
      /members-only|join this channel|sign in to confirm your age|age-restricted|may be inappropriate for some users|video unavailable|video is unavailable|private video|removed by the uploader|no longer available|not available in your country|this video is not available/i;
    if (permanentPattern.test(detail)) {
      const reason = shortPermanentReason(detail);
      state.skippedPermanent = state.skippedPermanent || {};
      state.skippedPermanent[key] = {
        videoId: video.videoId || null,
        fileName: video.fileName,
        reason,
        at: new Date().toISOString(),
      };
      delete state.failures[key];
      run.skippedPermanent += 1;
      run.consecutiveFailures = 0;
      log(`[${index}/${total}] SKIP ${label}: ${reason}`);
    } else if (throttled) {
      // Retries exhausted while YouTube was refusing us with 403/429. That is a rate
      // limit, not a defect in the video, so it must not be counted as a failure — but it
      // must stay visible and retryable. The shared cooldown is already set, so the next
      // fetch (this worker or any other) waits it out instead of deepening the block.
      run.throttled = (run.throttled || 0) + 1;
      state.throttled = state.throttled || {};
      state.throttled[key] = {
        videoId: video.videoId || null,
        fileName: video.fileName,
        error: result?.error || "unknown error",
        stderrTail: String(result?.stderr || "").trim().slice(-400) || null,
        at: new Date().toISOString(),
        attempts,
      };
      delete state.failures[key];
      run.consecutiveFailures = 0;
      log(
        `[${index}/${total}] THROTTLED ${label}: ${result?.error || "unknown error"} ` +
          `(rate limit — will retry on the next pass)`,
      );
    } else {
      run.failed += 1;
      run.consecutiveFailures += 1;
      state.failures[key] = {
        videoId: video.videoId || null,
        fileName: video.fileName,
        error: result?.error || "unknown error",
        // Keep the tail of yt-dlp's own output: it is the only way to tell a transient
        // failure from a permanent class the classifier has not learned yet, without
        // re-running the fetch by hand.
        stderrTail: String(result?.stderr || "").trim().slice(-400) || null,
        at: new Date().toISOString(),
        attempts,
      };
      log(`[${index}/${total}] FAIL ${label}: ${result?.error || "unknown error"}`);
      await backoff(run.consecutiveFailures);
    }
  }

  // Persist after every video: the run is restartable at any moment.
  save();
  writeJson(SUMMARY_FILE, {
    ...run,
    queueLength: total,
    index,
    remaining: total - index,
    storedTotal,
    maxTotalComments: MAX_TOTAL_COMMENTS,
    noUrlSkipped: Object.keys(state.skippedNoUrl || {}).length,
    permanentSkipped: Object.keys(state.skippedPermanent || {}).length,
    throttledTotal: Object.keys(state.throttled || {}).length,
    processedTotal: Object.keys(state.processed).length,
    failedTotal: Object.keys(state.failures).length,
    updatedAt: new Date().toISOString(),
  });

  if (storedTotal >= MAX_TOTAL_COMMENTS) {
    log(
      `budget reached: ${storedTotal.toLocaleString()} comments >= ` +
        `${MAX_TOTAL_COMMENTS.toLocaleString()} — stopping the run cleanly`,
    );
    stopping = true;
  }

  if (index < total && !stopping) {
    const jitter = Math.round(BASE_DELAY_MS * (0.5 + Math.random()));
    run.lastDelayMs = jitter;
    await sleep(jitter);
  }
}

run.finishedAt = new Date().toISOString();
save();
writeJson(SUMMARY_FILE, {
  ...run,
  queueLength: total,
  index,
  remaining: total - index,
  storedTotal,
  maxTotalComments: MAX_TOTAL_COMMENTS,
  noUrlSkipped: Object.keys(state.skippedNoUrl || {}).length,
  throttledTotal: Object.keys(state.throttled || {}).length,
  processedTotal: Object.keys(state.processed).length,
  failedTotal: Object.keys(state.failures).length,
  updatedAt: new Date().toISOString(),
});

log(
  `done: ok=${run.ok} (zero-comment videos=${run.zeroComments}) failed=${run.failed} ` +
    `throttled=${Object.keys(state.throttled || {}).length} ` +
    `noUrlSkipped=${Object.keys(state.skippedNoUrl || {}).length} ` +
    `permanentSkipped=${Object.keys(state.skippedPermanent || {}).length} ` +
    `commentsStored=${run.storedComments} storedTotal=${storedTotal.toLocaleString()} ` +
    `in ${Math.round((Date.now() - new Date(run.startedAt).getTime()) / 1000)}s`,
);
log(`state: ${STATE_FILE}`);
log(`summary: ${SUMMARY_FILE}`);
log(`log: ${LOG_FILE}`);
}

main().catch((err) => {
  log(`FATAL ${err?.stack || err}`);
  save();
  process.exit(1);
});
