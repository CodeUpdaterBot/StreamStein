// ── YouTube comments capture ─────────────────────────────────────────────────
// Fetches a YouTube video's comments with the bundled yt-dlp and stores them as a
// sidecar document beside the video:
//
//   C:\...\YouTube\<channel>\<video>.mp4
//   C:\...\YouTube\<channel>\<video>.comments.json   ← this module
//
// Naming follows the transcript convention (`<basename>.vtt` sits beside the mp4),
// and the file is registered in `youtube-catalog.json` as a first-class asset with
// `assetType: "comments"`, exactly like transcripts are (`assetType: "transcript"`).
// That keeps one mechanism for "video → sibling assets" instead of a second one.
//
// Why yt-dlp and not youtubei.js: measured on a real video (2026-11-11). yt-dlp
// 2026.10.26 returned the complete thread structure — 94 comments matching the
// reported count, with parent links, pins, likes and timestamps, in 11-13 s and
// 61 KB of JSON when printed directly. The youtubei.js route (already a bridge
// dependency) came back with Google's bot wall: HTTP 400 "your computer or network
// may be sending automated queries", even though the bridge's own Innertube client
// works for playback. yt-dlp is also the tool this app already ships and updates.
//
// Comment extraction is SLOW on big videos (yt-dlp walks the reply continuations),
// so everything here is capped, progress-reporting and cancellable.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const toolPaths = require("./toolPaths");
const { stripWindowsDuplicateBasename } = require("./youtubeCatalogDedupe");
const { loadCatalogFile, saveCatalogFile } = require("./youtubeCatalogScan");

const COMMENTS_SCHEMA = "streamstein-youtube-comments";
const COMMENTS_VERSION = 1;
const SIDECAR_SUFFIX = ".comments.json";

// Per-video ceiling. The user asked for complete threads, so the ceiling is high
// (10k) rather than yt-dlp's 100 default; the library-wide budget lives in the
// catch-up script, which stops the whole run before this ever becomes the limiting
// factor for a normal library.
const DEFAULT_MAX_COMMENTS = 10000;
/**
 * yt-dlp's own comment ordering. Deliberately not `top`: the sorted endpoints
 * return fewer comments (measured 94 vs 77 and 695 vs 625 on real videos), and the
 * viewer re-sorts from the stored data anyway.
 */
const DEFAULT_COMMENT_SORT = "default";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// ── Paths ────────────────────────────────────────────────────────────────────

function basenameNoExt(filePath) {
  const base = path.basename(filePath || "");
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** `<dir>/<basename>.comments.json` — the sidecar that belongs to a video file. */
function commentsPathFor(videoFilePath) {
  if (!videoFilePath || typeof videoFilePath !== "string") return null;
  const dir = path.dirname(videoFilePath);
  return path.join(dir, `${basenameNoExt(videoFilePath)}${SIDECAR_SUFFIX}`);
}

function isCommentsFile(filePath) {
  return typeof filePath === "string" && filePath.toLowerCase().endsWith(SIDECAR_SUFFIX);
}

/**
 * The key that links a video record to its sibling assets (`<dir>::<basename>`).
 * The comments sidecar is named `<video>.comments.json`, so its own basename has
 * the suffix stripped to land on the same key the transcript index uses.
 */
function commentsAssetKey(filePath, directory) {
  const dir = path.normalize(directory || path.dirname(filePath || ""));
  const base = stripWindowsDuplicateBasename(basenameNoExt(filePath)).replace(
    /\.comments$/i,
    "",
  );
  return `${dir}::${base.toLowerCase()}`;
}

/**
 * Index of comments sidecars in a catalog, keyed the same way the transcript index
 * is (`<dir>::<basename>`), so the library projection can attach `commentsPath` to
 * a video without touching the disk.
 */
function buildCommentsIndex(records) {
  const index = new Map();
  for (const r of records || []) {
    if (!r) continue;
    const isComments =
      r.assetType === "comments" || isCommentsFile(r.filePath || "");
    if (!isComments) continue;
    if (r.status && r.status !== "completed") continue;
    if (!r.filePath) continue;
    index.set(commentsAssetKey(r.filePath, r.directory), r);
  }
  return index;
}

/** The key that links a video record to its sibling assets. */
function siblingKey(filePath, directory) {
  return commentsAssetKey(filePath, directory);
}

// ── Parsing / normalising (pure) ─────────────────────────────────────────────

const toIso = (unixSeconds) => {
  const n = Number(unixSeconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
};

const toLikeCount = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * Turn yt-dlp's flat comment list into the stored document.
 *
 * yt-dlp emits threads and their replies in one flat array linked by `parent`
 * (root for top-level, otherwise the parent comment id). Real threads nest deeper
 * than one level — measured: 40 top-level, 29 at depth 1, 19 at depth 2, 6 at
 * depth 3 — so the viewer needs a tree, and the tree is built here once rather
 * than in every view that reads the file.
 */
function parseYtDlpComments(payload, meta = {}) {
  const raw = Array.isArray(payload?.comments) ? payload.comments : [];
  const notes = [];

  const flat = [];
  const seen = new Set();
  for (const c of raw) {
    const id = typeof c?.id === "string" ? c.id : null;
    const text = typeof c?.text === "string" ? c.text : "";
    if (!id || !text) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const parent = typeof c?.parent === "string" ? c.parent : "root";
    flat.push({
      id,
      parentId: parent === "root" ? null : parent,
      author: {
        name: c.author || null,
        channelId: c.author_id || null,
        url: c.author_url || null,
        thumbnail: c.author_thumbnail || null,
        isUploader: c.author_is_uploader === true,
        isVerified: c.author_is_verified === true,
      },
      text,
      likeCount: toLikeCount(c.like_count),
      publishedAt: toIso(c.timestamp),
      publishedText: c._time_text || null,
      isPinned: c.is_pinned === true,
      isFavorited: c.is_favorited === true,
      replyCount: 0, // filled in below, from the tree we actually have
      depth: 0,
      isReply: parent !== "root",
    });
  }

  const byId = new Map(flat.map((c) => [c.id, c]));
  const children = new Map();
  const roots = [];
  for (const c of flat) {
    const p = c.parentId && byId.has(c.parentId) ? c.parentId : null;
    if (p === null) {
      if (c.parentId) notes.push(`reply ${c.id} had a parent outside this fetch; shown as top-level`);
      c.parentId = null;
      c.isReply = false;
      roots.push(c);
      continue;
    }
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(c);
  }

  // Display order: each thread, then its replies depth-first. Children keep the
  // order yt-dlp returned them in, which is the order YouTube shows them.
  const ordered = [];
  const visit = (comment, depth) => {
    comment.depth = depth;
    const kids = children.get(comment.id) || [];
    comment.replyCount = kids.length;
    ordered.push(comment);
    for (const kid of kids) visit(kid, depth + 1);
  };
  for (const root of roots) visit(root, 0);

  // Anything unreachable (a cycle) must not be silently dropped.
  if (ordered.length < flat.length) {
    const placed = new Set(ordered.map((c) => c.id));
    const strays = flat.filter((c) => !placed.has(c.id));
    notes.push(`${strays.length} comment(s) were not reachable from a thread root`);
    for (const s of strays) {
      s.parentId = null;
      s.isReply = false;
      s.depth = 0;
      ordered.push(s);
    }
  }

  const reportedCount = Number(payload?.comment_count);
  const maxDepth = ordered.reduce((m, c) => Math.max(m, c.depth || 0), 0);
  const limit = Number(meta.limit ?? DEFAULT_MAX_COMMENTS);
  const truncated =
    (Number.isFinite(reportedCount) && reportedCount > ordered.length) ||
    (Number.isFinite(limit) && ordered.length >= limit);

  return {
    schema: COMMENTS_SCHEMA,
    version: COMMENTS_VERSION,
    videoId: payload?.id || meta.videoId || null,
    title: payload?.title || meta.title || null,
    channel: {
      name: payload?.channel || payload?.uploader || meta.channelName || null,
      id: payload?.channel_id || meta.channelId || null,
    },
    watchUrl: meta.watchUrl || (payload?.id ? `https://www.youtube.com/watch?v=${payload.id}` : null),
    videoFilePath: meta.videoFilePath || null,
    fetchedAt: meta.fetchedAt || new Date().toISOString(),
    fetchedBy: {
      tool: "yt-dlp",
      version: meta.ytDlpVersion || null,
      path: meta.ytDlpPath || null,
    },
    sort: meta.sort || "default",
    limit,
    stats: {
      reportedCount: Number.isFinite(reportedCount) ? reportedCount : null,
      stored: ordered.length,
      topLevel: ordered.filter((c) => !c.isReply).length,
      replies: ordered.filter((c) => c.isReply).length,
      maxDepth,
      likesTotal: ordered.reduce((n, c) => n + (c.likeCount || 0), 0),
      pinned: ordered.filter((c) => c.isPinned).length,
      truncated,
    },
    notes,
    warnings: Array.isArray(meta.warnings) ? meta.warnings : [],
    comments: ordered,
  };
}

/** Write atomically, so a killed fetch never leaves a half-written sidecar. */
function writeCommentsDocument(filePath, doc) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
  return filePath;
}

/**
 * Cross-process lock around the catalog read-modify-write.
 *
 * The catch-up can run several workers in parallel, and the app itself writes the same
 * catalog when it captures comments on a download. Three read-modify-write cycles
 * interleaving lose records — a worker reads the catalog, another appends and saves,
 * the first then saves its stale copy and the second's record is gone. The lock is a
 * create-exclusive file beside the catalog, which is atomic on Windows and POSIX alike,
 * with a stale-lock steal so a killed process cannot wedge the library forever.
 */
const CATALOG_LOCK_STALE_MS = 60_000;
const CATALOG_LOCK_WAIT_MS = 20_000;

function withCatalogLock(catalogPath, fn) {
  const lockPath = `${catalogPath}.lock`;
  const deadline = Date.now() + CATALOG_LOCK_WAIT_MS;
  let fd = null;

  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx");
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      // Steal a lock whose owner died mid-write.
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > CATALOG_LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // lock vanished: retry immediately
      }
      if (Date.now() > deadline) {
        throw new Error(`catalog lock busy for ${CATALOG_LOCK_WAIT_MS}ms: ${lockPath}`);
      }
      // Busy-wait in short sleeps; this is a file-system lock, not a hot path.
      const until = Date.now() + 120;
      while (Date.now() < until) {
        /* spin briefly */
      }
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* someone stole it after the stale window */
    }
  }
}

function readCommentsFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || !Array.isArray(parsed.comments)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── yt-dlp invocation ────────────────────────────────────────────────────────

/**
 * yt-dlp versions before the 2024 comment-API changes return ZERO comments on a
 * video that has them, without erroring — measured here: a stale 2023.11.16 copy
 * on PATH returned 0 comments for a video the bundled 2026.10.26 returned 94 for.
 * A silent zero is worse than a failure, so the version is checked and reported.
 */
const MIN_COMMENT_CAPABLE_VERSION = "2024.01.01";

/** `<userData>/tools/<platform>-<arch>/yt-dlp[.exe]` — where the app keeps its own copy. */
function managedYtDlpCandidates() {
  const arch =
    process.arch === "arm64" ? "arm64" : process.arch === "ia32" ? "ia32" : "x64";
  const key = `${process.platform}-${arch}`;
  const exe = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const out = [];
  for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
    if (!base) continue;
    for (const appName of ["streamstein", "Streamstein"]) {
      out.push(path.join(base, appName, "tools", key, exe));
    }
  }
  return out;
}

/** Every yt-dlp we can see, best-last-known first. */
function ytDlpCandidates(explicit) {
  const list = [];
  const push = (candidate) => {
    if (!candidate) return;
    if (candidate !== "yt-dlp" && !fs.existsSync(candidate)) return;
    if (list.includes(candidate)) return;
    list.push(candidate);
  };
  push(explicit);
  for (const managed of managedYtDlpCandidates()) push(managed);
  try {
    push(toolPaths.resolveTool("yt-dlp"));
  } catch {
    /* no electron binding — fall through */
  }
  push("yt-dlp");
  return list;
}

function versionRank(version) {
  const m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})/.exec(String(version || ""));
  if (!m) return 0;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

function ytDlpVersion(binary) {
  const cache = (ytDlpVersion.cache ||= new Map());
  if (cache.has(binary)) return cache.get(binary);
  let version = null;
  try {
    const { spawnSync } = require("child_process");
    const out = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    const first = (out.stdout || "").trim().split("\n")[0].trim();
    version = first || null;
  } catch {
    version = null;
  }
  cache.set(binary, version);
  return version;
}

/**
 * Pick the newest usable yt-dlp. The app's managed copy normally wins, but this
 * still resolves correctly when called outside Electron (dev CLI, maintenance
 * scripts) where `toolPaths` has no app binding and would otherwise hand back
 * whatever ancient `yt-dlp` happens to sit on PATH.
 */
function resolveYtDlpPath(explicit) {
  const candidates = ytDlpCandidates(explicit);
  let best = null;
  for (const candidate of candidates) {
    const version = ytDlpVersion(candidate);
    const rank = versionRank(version);
    if (!best || rank > best.rank) best = { path: candidate, version, rank };
    if (explicit && candidate === explicit) break; // an explicit choice is not second-guessed
  }
  if (!best) return { path: "yt-dlp", version: null };
  return { path: best.path, version: best.version };
}

const PRINT_FIELDS =
  "%(.{id,title,channel,channel_id,uploader,upload_date,duration,comment_count,comments})j";

/**
 * Optional cookie file for yt-dlp.
 *
 * YouTube rate-limits anonymous comment API access with HTTP 403 once it decides the IP
 * is a bot (measured 2026-11-11: a 3-worker run earned a hard 403 that survived a
 * 20-minute pause). A logged-in cookies.txt restores access and is also the only way to
 * reach age-restricted and members-only videos.
 *
 * Note on getting the file on this machine: `--cookies-from-browser chrome` CANNOT work
 * here. Chrome 157 encrypts cookies with App-Bound Encryption, so the DB cannot be
 * decrypted out-of-process, and Chrome 136+ refuses remote debugging on the default
 * profile — so the file has to be produced inside the browser (a "cookies.txt"
 * exporter extension) and saved to one of the paths below.
 */
function resolveCookiesFile() {
  const candidates = [
    process.env.STREAMSTEIN_YT_COOKIES,
    process.env.APPDATA ? path.join(process.env.APPDATA, "streamstein", "youtube-cookies.txt") : null,
    path.join(process.env.USERPROFILE || process.env.HOME || ".", "streamstein-cookies.txt"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      // A cookies.txt that lost its login (or was truncated to the header) must not be
      // passed to yt-dlp: it silently degrades to anonymous access and looks like the
      // cookie support "does not work".
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.size > 512) {
        const head = fs.readFileSync(candidate, "utf8").slice(0, 4096);
        if (/\tSID\t|\t__Secure-1PSID\t|\tLOGIN_INFO\t/.test(head) || head.includes(".youtube.com")) {
          return candidate;
        }
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function buildArgs({ watchUrl, maxComments, sort }) {
  const args = [
    "--skip-download",
    "--no-playlist",
    "--no-warnings",
    "--write-comments",
    "--no-write-info-json",
    "--newline",
    // Same client hint the bridge uses for downloads; the comment API is served
    // fine through it and it avoids the web-client SABR paths.
    "--extractor-args",
    "youtube:player_client=android,ios,tv,web",
  ];
  const cookiesFile = resolveCookiesFile();
  if (cookiesFile) {
    args.push("--cookies", cookiesFile);
  }
  if (Number.isFinite(maxComments) && maxComments > 0) {
    args.push(
      "--extractor-args",
      `youtube:max_comments=${Math.floor(maxComments)},all,all,all`,
    );
  }
  // Ordering is NOT passed by default, and that is deliberate: yt-dlp's own default
  // yields strictly MORE comments than the sorted endpoints. Measured on two real
  // videos (2026-11-11): 94 vs 77 and 695 vs 625 — i.e. `comment_sort=top` silently
  // costs 11-22% of the thread. The viewer sorts client-side from the stored data
  // (Top / Newest / Most liked), so yt-dlp's ordering buys us nothing.
  if (sort === "top" || sort === "new" || sort === "old") {
    args.push("--extractor-args", `youtube:comment_sort=${sort}`);
  }
  args.push("--print", PRINT_FIELDS, watchUrl);
  return args;
}

/**
 * Fetch comments for one video and store them beside it.
 *
 * Returns a summary (never throws for the caller's benefit): `{ ok, ... }`.
 * `onProgress({phase, detail})` fires for the UI; `signal` can cancel.
 */
function fetchCommentsForVideo(options = {}) {
  const {
    videoFilePath,
    videoId,
    watchUrl,
    title,
    channelName,
    youtubeFolder,
    catalogPath,
    maxComments = DEFAULT_MAX_COMMENTS,
    sort = DEFAULT_COMMENT_SORT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    ytDlpCommand,
    onProgress,
    registerAsset = true,
  } = options;

  const url =
    watchUrl ||
    (videoId ? `https://www.youtube.com/watch?v=${videoId}` : null);

  return new Promise((resolve) => {
    if (!url) {
      resolve({ ok: false, error: "No watch URL or videoId given." });
      return;
    }
    if (!videoFilePath) {
      resolve({ ok: false, error: "No video file path given — comments belong beside the video." });
      return;
    }

    const resolved = resolveYtDlpPath(ytDlpCommand);
    const ytDlpPath = resolved.path;
    const ytDlpResolvedVersion = resolved.version;
    const target = commentsPathFor(videoFilePath);
    const args = buildArgs({ watchUrl: url, maxComments, sort });
    const started = Date.now();
    const progress = (phase, detail) => {
      try {
        onProgress?.({ phase, detail });
      } catch {
        /* progress is best-effort */
      }
    };

    progress("starting", { ytDlpPath, ytDlpVersion: ytDlpResolvedVersion, url });

    let child;
    try {
      child = spawn(ytDlpPath, args, { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: `Could not start yt-dlp: ${err?.message || err}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      progress("timeout", { timeoutMs });
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const extracted = /Extracted (\d+) comments/.exec(trimmed);
        if (extracted) {
          progress("extracted", { comments: Number(extracted[1]) });
          continue;
        }
        const downloading = /Downloading comment(?:s| API JSON)/i.exec(trimmed);
        if (downloading) progress("fetching", { line: trimmed.slice(0, 160) });
      }
    });

    child.on("error", (err) => {
      finish({ ok: false, error: `yt-dlp failed to run: ${err?.message || err}` });
    });

    child.on("close", (code) => {
      if (settled && code === null) return;
      if (code !== 0 && !stdout.trim()) {
        finish({
          ok: false,
          error: `yt-dlp exited with ${code}`,
          stderr: stderr.slice(-4000),
        });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(stdout.trim());
      } catch (err) {
        finish({
          ok: false,
          error: `Could not parse yt-dlp output as JSON: ${err?.message || err}`,
          stderr: stderr.slice(-4000),
        });
        return;
      }

      progress("storing", { target });

      let doc;
      try {
        doc = parseYtDlpComments(payload, {
          videoId,
          title,
          channelName,
          watchUrl: url,
          videoFilePath,
          sort,
          limit: maxComments,
          ytDlpVersion: ytDlpResolvedVersion,
          ytDlpPath,
          fetchedAt: new Date().toISOString(),
        });
        // Never report a silent zero: an old extractor and a comments-disabled
        // video look identical from here, so say so.
        if (versionRank(ytDlpResolvedVersion) < versionRank(MIN_COMMENT_CAPABLE_VERSION)) {
          doc.warnings.push(
            `yt-dlp ${ytDlpResolvedVersion || "unknown"} predates ${MIN_COMMENT_CAPABLE_VERSION}; comment extraction may silently return nothing`,
          );
        }
        if (doc.stats.stored === 0) {
          doc.warnings.push(
            "No comments were retrieved — the video may have comments disabled, or the extractor has no comment access right now.",
          );
        }
        writeCommentsDocument(target, doc);
      } catch (err) {
        finish({ ok: false, error: `Could not store comments: ${err?.message || err}` });
        return;
      }

      let asset = null;
      if (registerAsset && youtubeFolder) {
        try {
          asset = registerCommentsAsset({
            catalogPath,
            youtubeFolder,
            videoFilePath,
            target,
            doc,
          });
        } catch (err) {
          asset = { ok: false, error: err?.message || String(err) };
        }
      }

      finish({
        ok: true,
        path: target,
        schema: doc.schema,
        stats: doc.stats,
        notes: doc.notes,
        warnings: doc.warnings,
        ytDlp: { path: ytDlpPath, version: ytDlpResolvedVersion },
        elapsedMs: Date.now() - started,
        asset,
      });
    });
  });
}

// ── Catalog registration ─────────────────────────────────────────────────────

function catalogPathFor(youtubeFolder) {
  if (!youtubeFolder) return null;
  return path.join(youtubeFolder, "youtube-catalog.json");
}

/**
 * Register (or refresh) the sidecar as an `assetType: "comments"` record, the same
 * way transcripts are registered, so the library projection and the bridge's disk
 * sync both know about it.
 */
function registerCommentsAsset({ catalogPath, youtubeFolder, videoFilePath, target, doc }) {
  const file = catalogPath || catalogPathFor(youtubeFolder);
  if (!file) return { ok: false, error: "No catalog path." };

  // Serialised against other workers and the app — see withCatalogLock.
  return withCatalogLock(file, () => {
  const catalog = loadCatalogFile(file);
  const records = Array.isArray(catalog.records) ? catalog.records : [];
  const stat = fs.statSync(target);
  const watchUrl = doc.watchUrl || null;

  let record = records.find(
    (r) =>
      (r.assetType === "comments" || isCommentsFile(r.filePath || "")) &&
      r.filePath &&
      path.normalize(r.filePath).toLowerCase() === path.normalize(target).toLowerCase(),
  );

  const now = new Date().toISOString();
  if (!record) {
    record = {
      id: `yt-comments-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      status: "completed",
      assetType: "comments",
      videoId: doc.videoId || null,
      watchUrl,
      title: doc.title || basenameNoExt(videoFilePath),
      normalizedTitle: (doc.title || basenameNoExt(videoFilePath)).toLowerCase(),
      channelId: doc.channel?.id || null,
      channelName: doc.channel?.name || null,
      channelKey: doc.channel?.name || null,
      fileName: path.basename(target),
      filePath: target,
      directory: path.dirname(target),
      extension: path.extname(target).toLowerCase(),
      videoFilePath,
      source: "comments-fetch",
      requestedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    records.push(record);
  }

  // Keep the counts and freshness on the record: the tile does not have to open
  // the sidecar to show "412 comments".
  record.status = "completed";
  record.assetType = "comments";
  record.videoId = doc.videoId || record.videoId || null;
  record.title = doc.title || record.title || null;
  record.watchUrl = watchUrl || record.watchUrl || null;
  record.channelId = doc.channel?.id || record.channelId || null;
  record.channelName = doc.channel?.name || record.channelName || null;
  record.filePath = target;
  record.directory = path.dirname(target);
  record.fileName = path.basename(target);
  record.extension = path.extname(target).toLowerCase();
  record.videoFilePath = videoFilePath;
  record.size = stat.size;
  record.mtime = stat.mtimeMs;
  record.commentsCount = doc.stats?.stored ?? null;
  record.commentsReportedCount = doc.stats?.reportedCount ?? null;
  record.commentsFetchedAt = doc.fetchedAt || now;
  record.updatedAt = now;

  catalog.records = records;
  saveCatalogFile(file, catalog);
  return { ok: true, recordId: record.id, record };
  });
}

/** Remove a comments sidecar and its catalog record. */
function deleteCommentsForVideo({ youtubeFolder, catalogPath, videoFilePath, commentsFilePath }) {
  const file = catalogPath || catalogPathFor(youtubeFolder);
  const target = commentsFilePath || (videoFilePath ? commentsPathFor(videoFilePath) : null);
  const result = { ok: true, deleted: false, filePath: target };

  if (target && fs.existsSync(target)) {
    try {
      fs.unlinkSync(target);
      result.deleted = true;
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  if (file && target) {
    try {
      withCatalogLock(file, () => {
      const catalog = loadCatalogFile(file);
      const before = Array.isArray(catalog.records) ? catalog.records.length : 0;
      catalog.records = (catalog.records || []).filter(
        (r) =>
          !(
            (r.assetType === "comments" || isCommentsFile(r.filePath || "")) &&
            r.filePath &&
            path.normalize(r.filePath).toLowerCase() === path.normalize(target).toLowerCase()
          ),
      );
      if (catalog.records.length !== before) {
        saveCatalogFile(file, catalog);
        result.recordRemoved = true;
      }
      });
    } catch (err) {
      result.catalogError = err?.message || String(err);
    }
  }
  return result;
}

// ── IPC ──────────────────────────────────────────────────────────────────────

function register() {
  const { ipcMain } = require("electron");

  ipcMain.handle("youtube-comments-fetch", async (event, args = {}) => {
    const onProgress = (payload) => {
      try {
        if (!event?.sender?.isDestroyed?.()) {
          event.sender.send("youtube-comments-progress", {
            videoFilePath: args.videoFilePath || null,
            ...payload,
          });
        }
      } catch {
        /* renderer may be gone */
      }
    };
    return fetchCommentsForVideo({ ...args, onProgress });
  });

  ipcMain.handle("youtube-comments-read", async (_event, { filePath, videoFilePath } = {}) => {
    const target = filePath || (videoFilePath ? commentsPathFor(videoFilePath) : null);
    if (!target) return { ok: false, error: "No comments path." };
    const doc = readCommentsFile(target);
    if (!doc) return { ok: false, error: "No comments stored for this video yet.", path: target };
    return { ok: true, path: target, document: doc };
  });

  ipcMain.handle("youtube-comments-delete", async (_event, args = {}) =>
    deleteCommentsForVideo(args),
  );

  ipcMain.handle("youtube-comments-exists", async (_event, { filePath, videoFilePath } = {}) => {
    const target = filePath || (videoFilePath ? commentsPathFor(videoFilePath) : null);
    if (!target) return { ok: false, exists: false };
    if (!fs.existsSync(target)) return { ok: true, exists: false, path: target };
    const doc = readCommentsFile(target);
    return {
      ok: true,
      exists: true,
      path: target,
      stats: doc?.stats || null,
      fetchedAt: doc?.fetchedAt || null,
    };
  });
}

module.exports = {
  register,
  COMMENTS_SCHEMA,
  COMMENTS_VERSION,
  SIDECAR_SUFFIX,
  DEFAULT_MAX_COMMENTS,
  DEFAULT_COMMENT_SORT,
  MIN_COMMENT_CAPABLE_VERSION,
  commentsPathFor,
  isCommentsFile,
  buildCommentsIndex,
  commentsAssetKey,
  siblingKey,
  parseYtDlpComments,
  writeCommentsDocument,
  readCommentsFile,
  buildArgs,
  fetchCommentsForVideo,
  registerCommentsAsset,
  deleteCommentsForVideo,
  catalogPathFor,
  withCatalogLock,
  resolveYtDlpPath,
  ytDlpCandidates,
  versionRank,
};
