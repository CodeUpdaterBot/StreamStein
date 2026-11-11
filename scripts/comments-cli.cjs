#!/usr/bin/env node
/**
 * Dev harness: drive the production comments module by hand.
 *
 *   node scripts/comments-cli.cjs fetch  <videoFilePath> [videoId] [maxComments]
 *   node scripts/comments-cli.cjs read   <videoFilePath>
 *   node scripts/comments-cli.cjs check  <videoFilePath>
 *   node scripts/comments-cli.cjs delete <videoFilePath>
 *
 * Same code path the app's IPC handler uses (`fetchCommentsForVideo`), so a pass
 * here means the feature works before any UI exists.
 */

const path = require("path");
const comments = require("../src/ipc/youtubeComments");

const YOUTUBE_FOLDER = process.env.STREAMSTEIN_YOUTUBE_FOLDER || "C:/Users/PC/Downloads/YouTube";

async function main() {
  const [cmd, filePath, arg3, arg4] = process.argv.slice(2);
  if (!cmd || !filePath) {
    console.error("usage: node scripts/comments-cli.cjs <fetch|read|check|delete> <videoFilePath> [videoId] [maxComments]");
    process.exit(2);
  }

  if (cmd === "fetch") {
    const videoId = arg3 || null;
    const maxComments = arg4 ? Number(arg4) : undefined;
    const started = Date.now();
    const result = await comments.fetchCommentsForVideo({
      videoFilePath: filePath,
      videoId: videoId || undefined,
      watchUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : undefined,
      title: path.basename(filePath).replace(/\.[^.]+$/, ""),
      youtubeFolder: YOUTUBE_FOLDER,
      maxComments,
      onProgress: (p) => {
        const detail = p.detail?.line || p.detail?.comments || p.detail?.target || "";
        console.log(`  [progress ${p.phase}] ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
      },
    });
    console.log(JSON.stringify({ ...result, wallMs: Date.now() - started }, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  if (cmd === "read") {
    const target = comments.commentsPathFor(filePath);
    const doc = comments.readCommentsFile(target);
    if (!doc) {
      console.log(JSON.stringify({ ok: false, path: target, error: "not found" }));
      process.exit(1);
    }
    console.log(JSON.stringify({
      ok: true,
      path: target,
      schema: doc.schema,
      version: doc.version,
      videoId: doc.videoId,
      title: doc.title,
      fetchedAt: doc.fetchedAt,
      stats: doc.stats,
      notes: doc.notes,
      firstThree: doc.comments.slice(0, 3).map((c) => ({
        depth: c.depth,
        isPinned: c.isPinned,
        author: c.author.name,
        likeCount: c.likeCount,
        publishedAt: c.publishedAt,
        replyCount: c.replyCount,
        text: c.text.slice(0, 90),
      })),
    }, null, 2));
    return;
  }

  if (cmd === "check") {
    const target = comments.commentsPathFor(filePath);
    const doc = comments.readCommentsFile(target);
    console.log(JSON.stringify({
      path: target,
      exists: !!doc,
      stats: doc?.stats || null,
    }, null, 2));
    return;
  }

  if (cmd === "delete") {
    const result = comments.deleteCommentsForVideo({
      youtubeFolder: YOUTUBE_FOLDER,
      videoFilePath: filePath,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

main().catch((err) => {
  console.error("FAILED:", err?.stack || err);
  process.exit(1);
});
