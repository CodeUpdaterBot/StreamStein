import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ChevronDownIcon,
  CloseIcon,
  CommentsIcon,
  HeartIcon,
  PinIcon,
  RefreshCwIcon,
  SearchIcon,
  VerifiedBadgeIcon,
} from "./Icons";

/**
 * Comment viewer for one library video.
 *
 * Reads the sidecar written by `src/ipc/youtubeComments.js`
 * (`<video>.comments.json`, schema `streamstein-youtube-comments`), which stores
 * the comments **as they were at fetch time** — that is the point of the feature:
 * a thread worth keeping, pinned to the moment it was captured, including replies
 * nested several levels deep (real threads go 3+ levels).
 *
 * The document is a flat list in display order with `depth` and `parentId`, so the
 * tree is rebuilt here for rendering and can be collapsed per branch.
 */

const TEXT_PREVIEW_CHARS = 420;
const REPLIES_PREVIEW = 2;
const THREADS_PAGE = 60;
const SEARCH_RESULT_CAP = 200;

const formatCount = (n) => {
  const value = Number(n) || 0;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(value);
};

const formatWhen = (iso, fallback) => {
  if (fallback) return fallback;
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
};

const formatDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const initialsOf = (name) => {
  const cleaned = String(name || "?").replace(/^@/, "").trim();
  if (!cleaned) return "?";
  return cleaned.slice(0, 2).toUpperCase();
};

function Avatar({ author, size = 36 }) {
  const [failed, setFailed] = useState(false);
  const src = author?.thumbnail;
  const style = { width: size, height: size, minWidth: size };
  if (!src || failed) {
    return (
      <div className="yt-comments__avatar yt-comments__avatar--initials" style={style}>
        {initialsOf(author?.name)}
      </div>
    );
  }
  return (
    <img
      className="yt-comments__avatar"
      style={style}
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function AuthorLine({ author, publishedAt, publishedText, isPinned, depth }) {
  return (
    <div className="yt-comments__authorline">
      <span className="yt-comments__author" title={author?.name || ""}>
        {author?.name || "Unknown"}
      </span>
      {author?.isVerified && (
        <span className="yt-comments__badge yt-comments__badge--verified" title="Verified channel">
          <VerifiedBadgeIcon size={12} />
        </span>
      )}
      {author?.isUploader && <span className="yt-comments__badge yt-comments__badge--owner">Creator</span>}
      {isPinned && (
        <span className="yt-comments__badge yt-comments__badge--pinned" title="Pinned by the creator">
          <PinIcon size={11} />
          Pinned
        </span>
      )}
      {depth > 1 && <span className="yt-comments__badge yt-comments__badge--depth">level {depth}</span>}
      <span className="yt-comments__when">{formatWhen(publishedAt, publishedText)}</span>
    </div>
  );
}

function CommentBody({ text }) {
  const [open, setOpen] = useState(false);
  const isLong = text.length > TEXT_PREVIEW_CHARS;
  const shown = !isLong || open ? text : `${text.slice(0, TEXT_PREVIEW_CHARS).trimEnd()}…`;
  return (
    <div className="yt-comments__text">
      {shown}
      {isLong && (
        <button
          type="button"
          className="yt-comments__more"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** One comment row; `children` are rendered by the caller under it. */
function CommentRow({ comment, depth, children, muted }) {
  return (
    <div
      className={`yt-comments__row yt-comments__row--d${Math.min(depth, 3)}${muted ? " yt-comments__row--muted" : ""}`}
    >
      <Avatar author={comment.author} size={depth === 0 ? 36 : 28} />
      <div className="yt-comments__main">
        <AuthorLine
          author={comment.author}
          publishedAt={comment.publishedAt}
          publishedText={comment.publishedText}
          isPinned={comment.isPinned}
          depth={depth}
        />
        <CommentBody text={comment.text} />
        <div className="yt-comments__meta">
          {comment.likeCount > 0 && (
            <span className="yt-comments__likes" title={`${comment.likeCount} likes`}>
              <HeartIcon size={12} />
              {formatCount(comment.likeCount)}
            </span>
          )}
          {comment.author?.isFavorited && <span className="yt-comments__chip">♥ creator</span>}
        </div>
      </div>
      {children}
    </div>
  );
}

/** A thread: root comment plus its collapsible reply tree. */
function Thread({ root, childrenByParent, sortMode }) {
  const [expanded, setExpanded] = useState(false);
  const [deepOpen, setDeepOpen] = useState({});

  const replies = useMemo(() => childrenByParent.get(root.id) || [], [childrenByParent, root.id]);
  const totalReplies = useMemo(() => {
    let total = 0;
    const walk = (id) => {
      const kids = childrenByParent.get(id) || [];
      for (const kid of kids) {
        total += 1;
        walk(kid.id);
      }
    };
    walk(root.id);
    return total;
  }, [childrenByParent, root.id]);

  const visibleReplies = expanded ? replies : replies.slice(0, REPLIES_PREVIEW);

  const renderReply = (reply, depth) => {
    const kids = childrenByParent.get(reply.id) || [];
    const isDeepOpen = deepOpen[reply.id] === true;
    return (
      <CommentRow key={reply.id} comment={reply} depth={depth}>
        {kids.length > 0 && (
          <>
            <button
              type="button"
              className="yt-comments__toggle yt-comments__toggle--nested"
              onClick={() => setDeepOpen((prev) => ({ ...prev, [reply.id]: !isDeepOpen }))}
            >
              <ChevronDownIcon size={12} className={isDeepOpen ? "is-open" : ""} />
              {isDeepOpen ? "Hide" : `Show ${kids.length}`} {kids.length === 1 ? "reply" : "replies"}
            </button>
            {isDeepOpen && (
              <div className="yt-comments__replies yt-comments__replies--deep">
                {kids.map((kid) => renderReply(kid, depth + 1))}
              </div>
            )}
          </>
        )}
      </CommentRow>
    );
  };

  return (
    <div className={`yt-comments__thread${root.isPinned ? " yt-comments__thread--pinned" : ""}`}>
      <CommentRow comment={root} depth={0} />
      {replies.length > 0 && (
        <div className="yt-comments__replywrap">
          {visibleReplies.map((reply) => renderReply(reply, 1))}
          {replies.length > REPLIES_PREVIEW && (
            <button
              type="button"
              className="yt-comments__toggle"
              onClick={() => setExpanded((v) => !v)}
            >
              <ChevronDownIcon size={13} className={expanded ? "is-open" : ""} />
              {expanded ? "Hide replies" : `Show ${replies.length === 1 ? "1 reply" : `${replies.length} replies`}`}
              {!expanded && totalReplies > replies.length ? ` (${totalReplies} total)` : ""}
            </button>
          )}
        </div>
      )}
      {sortMode === "newest" && root.replyCount > 0 && replies.length === 0 && (
        <div className="yt-comments__replywrap yt-comments__replywrap--note">
          {root.replyCount} repl{root.replyCount === 1 ? "y" : "ies"} were not captured in this fetch.
        </div>
      )}
    </div>
  );
}

export default function YoutubeCommentsModal({ video, onClose, onFetched }) {
  const [doc, setDoc] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [progressLine, setProgressLine] = useState(null);
  const [fetchError, setFetchError] = useState(null);
  const [justFetched, setJustFetched] = useState(null);
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState("top");
  const [threadsShown, setThreadsShown] = useState(THREADS_PAGE);
  const [removing, setRemoving] = useState(false);
  const searchRef = useRef(null);

  const commentsPath = video?.commentsPath || null;
  const videoFilePath = video?.filePath || null;

  /**
   * The name the sidecar will actually get: `<video basename>.comments.json`.
   * Derived from the real file path when there is one, so the empty state names
   * the file honestly instead of chopping a long title mid-word.
   */
  const sidecarName = useMemo(() => {
    if (commentsPath) return commentsPath.split(/[\\/]/).pop();
    const base = (videoFilePath || video?.title || "video")
      .split(/[\\/]/)
      .pop()
      .replace(/\.[^.]+$/, "")
      .trim();
    return `${base}.comments.json`;
  }, [commentsPath, videoFilePath, video?.title]);

  const load = useCallback(async () => {
    if (!videoFilePath && !commentsPath) {
      setLoading(false);
      setLoadError("This video has no file path, so its comments cannot be located.");
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const result = await window.electron?.readYoutubeComments?.({
        filePath: commentsPath,
        videoFilePath,
      });
      if (result?.ok) {
        setDoc(result.document);
      } else {
        setDoc(null);
        setLoadError(result?.error || "Could not read the stored comments.");
      }
    } catch (err) {
      setDoc(null);
      setLoadError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [commentsPath, videoFilePath]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live progress from the main process while yt-dlp walks the threads.
  useEffect(() => {
    const api = window.electron;
    if (!api?.onYoutubeCommentsProgress) return undefined;
    const handler = (payload) => {
      if (payload?.videoFilePath && videoFilePath && payload.videoFilePath !== videoFilePath) return;
      const detail = payload?.detail || {};
      const line =
        payload.phase === "starting"
          ? `Starting yt-dlp ${detail.ytDlpVersion ? `(${detail.ytDlpVersion})` : ""}…`
          : payload.phase === "fetching"
            ? "Downloading comment threads…"
            : payload.phase === "extracted"
              ? `Extracted ${detail.comments} comments…`
              : payload.phase === "storing"
                ? "Writing comments file…"
                : payload.phase === "timeout"
                  ? "Timed out — stopping yt-dlp."
                  : null;
      if (line) setProgressLine(line);
    };
    const h = api.onYoutubeCommentsProgress(handler);
    return () => api.offYoutubeCommentsProgress?.(h);
  }, [videoFilePath]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const runFetch = useCallback(async () => {
    if (!videoFilePath) return;
    setFetching(true);
    setFetchError(null);
    setJustFetched(null);
    setProgressLine("Starting yt-dlp…");
    try {
      const result = await window.electron?.fetchYoutubeComments?.({
        videoFilePath,
        videoId: video?.videoId || undefined,
        watchUrl: video?.watchUrl || undefined,
        title: video?.title || undefined,
        channelName: video?.channelName || undefined,
        youtubeFolder: video?.youtubeFolder || undefined,
      });
      if (!result?.ok) {
        setFetchError(result?.error || "The fetch failed.");
        return;
      }
      setJustFetched(result);
      await load();
      onFetched?.(result);
    } catch (err) {
      setFetchError(err?.message || String(err));
    } finally {
      setFetching(false);
      setProgressLine(null);
    }
  }, [load, onFetched, video, videoFilePath]);

  const runDelete = useCallback(async () => {
    setRemoving(true);
    try {
      await window.electron?.deleteYoutubeComments?.({
        videoFilePath,
        filePath: commentsPath,
        youtubeFolder: video?.youtubeFolder || undefined,
      });
      setDoc(null);
      setJustFetched(null);
      setLoadError("No comments stored for this video yet.");
      onFetched?.(null);
    } finally {
      setRemoving(false);
    }
  }, [commentsPath, onFetched, video, videoFilePath]);

  const comments = doc?.comments || [];

  const childrenByParent = useMemo(() => {
    const map = new Map();
    for (const c of comments) {
      if (!c.isReply || !c.parentId) continue;
      if (!map.has(c.parentId)) map.set(c.parentId, []);
      map.get(c.parentId).push(c);
    }
    return map;
  }, [comments]);

  const roots = useMemo(() => {
    const list = comments.filter((c) => !c.isReply);
    if (sortMode === "newest") {
      return [...list].sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
    }
    if (sortMode === "liked") {
      return [...list].sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
    }
    return [...list].sort((a, b) => Number(b.isPinned) - Number(a.isPinned));
  }, [comments, sortMode]);

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return comments
      .filter(
        (c) =>
          c.text?.toLowerCase().includes(q) || c.author?.name?.toLowerCase().includes(q),
      )
      .slice(0, SEARCH_RESULT_CAP);
  }, [comments, query]);

  const stats = doc?.stats;

  return (
    <div className="yt-comments__overlay" onClick={onClose} role="presentation">
      <div
        className="yt-comments__modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Comments for ${video?.title || "video"}`}
      >
        <header className="yt-comments__header">
          <div className="yt-comments__headmain">
            {video?.thumbnailUrl ? (
              <img className="yt-comments__thumb" src={video.thumbnailUrl} alt="" referrerPolicy="no-referrer" />
            ) : (
              <span className="yt-comments__thumb yt-comments__thumb--placeholder">
                <CommentsIcon size={18} />
              </span>
            )}
            <div className="yt-comments__headtext">
              <div className="yt-comments__eyebrow">
                <CommentsIcon size={13} />
                Comments
                {doc?.fetchedAt && <span className="yt-comments__fetched">captured {formatDate(doc.fetchedAt)}</span>}
              </div>
              <h2 className="yt-comments__title" title={video?.title || doc?.title || ""}>
                {video?.title || doc?.title || "Video"}
              </h2>
              <div className="yt-comments__subtitle">
                {video?.channelName || doc?.channel?.name || ""}
                {stats
                  ? ` · ${formatCount(stats.stored)} stored${stats.reportedCount ? ` of ${formatCount(stats.reportedCount)}` : ""}`
                  : ""}
                {doc?.fetchedBy?.version ? ` · yt-dlp ${doc.fetchedBy.version}` : ""}
              </div>
            </div>
          </div>
          <button type="button" className="icon-btn yt-comments__close" onClick={onClose} title="Close (Esc)">
            <CloseIcon />
          </button>
        </header>

        {stats && (
          <div className="yt-comments__chips">
            <span className="yt-comments__chip">{formatCount(stats.topLevel)} threads</span>
            <span className="yt-comments__chip">{formatCount(stats.replies)} replies</span>
            <span className="yt-comments__chip">depth {stats.maxDepth}</span>
            <span className="yt-comments__chip">
              <HeartIcon size={11} /> {formatCount(stats.likesTotal)}
            </span>
            {stats.pinned > 0 && (
              <span className="yt-comments__chip">
                <PinIcon size={11} /> {stats.pinned} pinned
              </span>
            )}
            {stats.truncated && (
              <span className="yt-comments__chip yt-comments__chip--warn" title={`Fetch capped at ${doc.limit} comments`}>
                capped at {formatCount(doc.limit)}
              </span>
            )}
            {doc?.notes?.length > 0 && (
              <span className="yt-comments__chip yt-comments__chip--warn" title={doc.notes.join("\n")}>
                {doc.notes.length} note{doc.notes.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
        )}

        <div className="yt-comments__toolbar">
          <div className="yt-comments__search">
            <SearchIcon />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search these comments…"
              spellCheck={false}
            />
            {query && (
              <button type="button" className="yt-comments__searchclear" onClick={() => setQuery("")} title="Clear">
                <CloseIcon />
              </button>
            )}
          </div>

          <div className="yt-comments__segmented" role="group" aria-label="Sort comments">
            {[
              ["top", "Top"],
              ["newest", "Newest"],
              ["liked", "Most liked"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`yt-comments__seg${sortMode === value ? " is-active" : ""}`}
                onClick={() => setSortMode(value)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="yt-comments__toolbar-right">
            {doc && (
              <button
                type="button"
                className="btn btn-ghost btn--sm"
                onClick={runDelete}
                disabled={fetching || removing}
                title="Delete the stored comments for this video"
              >
                Remove
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary btn--sm"
              onClick={runFetch}
              disabled={fetching}
              title={doc ? "Fetch the comments again and replace what is stored" : "Fetch this video's comments"}
            >
              <RefreshCwIcon size={14} className={fetching ? "spin" : ""} />
              {fetching ? "Fetching…" : doc ? "Refetch" : "Fetch comments"}
            </button>
          </div>
        </div>

        {fetching && (
          <div className="yt-comments__progress">
            <span className="yt-comments__spinner" />
            {progressLine || "Fetching comments…"}
            <span className="yt-comments__progress-hint">
              Large threads take a while — yt-dlp walks every reply continuation.
            </span>
          </div>
        )}

        {fetchError && <div className="yt-comments__error">{fetchError}</div>}

        {justFetched?.warnings?.length > 0 && (
          <div className="yt-comments__warn">{justFetched.warnings.join(" ")}</div>
        )}

        <div className="yt-comments__body">
          {loading && <div className="yt-comments__state">Loading stored comments…</div>}

          {!loading && !doc && (
            <div className="yt-comments__state yt-comments__state--empty">
              <div className="yt-comments__empty-icon">
                <CommentsIcon size={30} />
              </div>
              <div className="yt-comments__empty-title">
                {loadError && !loadError.startsWith("No comments stored")
                  ? "Comments unavailable"
                  : "No comments captured yet"}
              </div>
              <p className="yt-comments__empty-text">
                {loadError || "No comments stored for this video yet."}
                <br />
                Fetching stores every comment and reply chain as it stands right now, in a{" "}
                <code>{sidecarName}</code> beside the video.
              </p>
              <button type="button" className="btn btn-primary" onClick={runFetch} disabled={fetching}>
                <CommentsIcon size={15} />
                {fetching ? "Fetching…" : "Fetch comments now"}
              </button>
            </div>
          )}

          {!loading && doc && searchResults && (
            <div className="yt-comments__results">
              <div className="yt-comments__results-count">
                {searchResults.length} match{searchResults.length === 1 ? "" : "es"}
                {searchResults.length >= SEARCH_RESULT_CAP ? ` (first ${SEARCH_RESULT_CAP})` : ""} for “{query.trim()}”
              </div>
              {searchResults.map((c) => (
                <CommentRow key={c.id} comment={c} depth={0} muted={c.isReply}>
                  {c.isReply && <div className="yt-comments__path">reply in thread</div>}
                </CommentRow>
              ))}
            </div>
          )}

          {!loading && doc && !searchResults && roots.length === 0 && (
            <div className="yt-comments__state">
              This video has no comments stored — the thread may be disabled or empty.
            </div>
          )}

          {!loading && doc && !searchResults && roots.length > 0 && (
            <>
              {roots.slice(0, threadsShown).map((root) => (
                <Thread key={root.id} root={root} childrenByParent={childrenByParent} sortMode={sortMode} />
              ))}
              {roots.length > threadsShown && (
                <button
                  type="button"
                  className="btn btn-secondary yt-comments__more-threads"
                  onClick={() => setThreadsShown((n) => n + THREADS_PAGE)}
                >
                  Show {Math.min(THREADS_PAGE, roots.length - threadsShown)} more threads —{" "}
                  {roots.length - threadsShown} left
                </button>
              )}
            </>
          )}
        </div>

        <footer className="yt-comments__footer">
          <span className="yt-comments__footer-note">
            Stored beside the video{commentsPath ? `: ${commentsPath}` : ""}
          </span>
          {video?.watchUrl && (
            <button
              type="button"
              className="btn btn-ghost btn--sm"
              onClick={() => window.electron?.openExternal?.(video.watchUrl)}
            >
              Open on YouTube
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
