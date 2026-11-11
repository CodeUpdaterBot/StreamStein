/**
 * Comments extraction probe — youtubei.js path.
 *
 * Lives inside the bridge folder on purpose: `youtubei.js@16.0.1` is already a
 * dependency of the yt-saver bridge (see server.js `getInnertube()`), so this
 * resolves the same module the production code will use, with no install.
 *
 * Usage:
 *   node tools/comments-probe-youtubei.mjs <videoId|url> [maxPages] [sort]
 *   sort: top (default) | new
 *
 * Prints a summary and, with --write <file>, dumps the extracted threads.
 * This is a PROBE: it exists to compare against yt-dlp on real videos before the
 * format is frozen. The production fetch lives in the bridge server route.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Innertube, UniversalCache } from 'youtubei.js';

const args = process.argv.slice(2);
const writeIdx = args.indexOf('--write');
const writeTo = writeIdx >= 0 ? args[writeIdx + 1] : null;
if (writeIdx >= 0) args.splice(writeIdx, 2);

const input = args[0];
if (!input) {
  console.error('usage: node comments-probe-youtubei.mjs <videoId|url> [maxPages] [top|new] [--write file]');
  process.exit(2);
}
const maxPages = Number(args[1] || 3);
const sort = args[2] === 'new' ? 'new' : 'top';

const videoId = (() => {
  const m = String(input).match(/(?:v=|\/shorts\/|youtu\.be\/|\/embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : String(input).trim();
})();

const started = Date.now();

const yt = await Innertube.create({
  client_type: 'WEB',
  device_category: 'DESKTOP',
  lang: 'en',
  location: 'US',
  cache: new UniversalCache(false),
  generate_session_locally: true,
  retrieve_player: false,
});

/** Pull the fields we intend to store, from whatever shape youtubei hands back. */
const mapComment = (c, { isReply = false } = {}) => {
  const text =
    c?.content?.toString?.() ??
    c?.content?.text ??
    '';
  const author = c?.author ?? {};
  return {
    id: c?.comment_id ?? c?.id ?? null,
    text,
    author: {
      name: author?.name ?? null,
      channelId: author?.id ?? null,
      isVerified: author?.is_verified === true,
      isOwner: c?.author_is_uploader === true,
      isHearted: c?.is_hearted === true,
      thumbnail: author?.thumbnails?.[0]?.url ?? null,
      isModerator: c?.author_is_moderator === true ?? undefined,
    },
    likeCount: typeof c?.like_count === 'number' ? c.like_count : Number(c?.like_count ?? 0) || 0,
    replyCount: Number(c?.reply_count ?? 0) || 0,
    publishedText: c?.published_time_text ?? c?.published?.toString?.() ?? null,
    publishedAt: c?.published_time ?? null,
    isPinned: c?.is_pinned === true,
    isEdited: c?.is_edited === true,
    isReply,
  };
};

const videoInfo = await yt.getBasicInfo(videoId);
const reportedCount = videoInfo?.basic_info?.comment_count ?? null;

let page = await yt.getComments(videoId, sort);
const threads = [];
const seenThreads = new Set();
let pagesFetched = 0;

while (page && pagesFetched < maxPages) {
  pagesFetched += 1;
  const contents = page.contents ?? [];
  for (const item of contents) {
    // CommentThread / CommentView shapes vary by client; take what is there.
    const comment = item?.comment ?? item;
    if (!comment?.comment_id && !comment?.content) continue;
    if (seenThreads.has(comment.comment_id)) continue;
    seenThreads.add(comment.comment_id);
    threads.push(mapComment(comment));
  }
  if (!page.has_continuation) break;
  const next = await page.getContinuation();
  if (!next) break;
  page = next;
}

const summary = {
  videoId,
  sort,
  reportedCount,
  threadsFetched: threads.length,
  pagesFetched,
  hasContinuationLeft: page?.has_continuation === true,
  elapsedMs: Date.now() - started,
  sample: threads.slice(0, 3),
};

console.log(JSON.stringify(summary, null, 2).slice(0, 2500));

if (writeTo) {
  fs.mkdirSync(path.dirname(writeTo), { recursive: true });
  fs.writeFileSync(writeTo, JSON.stringify({ videoId, sort, reportedCount, threads }, null, 2), 'utf8');
  console.log(`\nwrote ${threads.length} threads -> ${writeTo}`);
}
