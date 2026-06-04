/**
 * Run: node --test src/utils/mediaPlayback.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findLocalDownloadCandidate,
  buildMediaPlaybackDescriptor,
  resolveEffectivePlaybackMode,
  canTogglePlaybackMode,
  isLocalMp4Path,
} from "./mediaPlayback.js";

describe("mediaPlayback", () => {
  const downloads = [
    {
      id: "1",
      mediaType: "movie",
      tmdbId: 550,
      status: "completed",
      filePath: "C:\\Videos\\fight.mp4",
    },
    {
      id: "3",
      mediaType: "tv",
      tmdbId: 1399,
      season: 1,
      episode: 2,
      status: "completed",
      filePath: "/media/got-s01e02.mp4",
    },
  ];

  it("isLocalMp4Path", () => {
    assert.equal(isLocalMp4Path("/a/b.mp4"), true);
    assert.equal(isLocalMp4Path("/a/b.mkv"), false);
  });

  it("findLocalDownloadCandidate movie", () => {
    const hit = findLocalDownloadCandidate(downloads, {
      mediaType: "movie",
      tmdbId: 550,
    });
    assert.equal(hit?.filePath, "C:\\Videos\\fight.mp4");
  });

  it("prefers local when both available", () => {
    const dl = findLocalDownloadCandidate(downloads, {
      mediaType: "movie",
      tmdbId: 550,
    });
    const desc = buildMediaPlaybackDescriptor(dl, true, {
      streamAvailable: true,
    });
    assert.equal(desc.availability, "both");
    assert.equal(resolveEffectivePlaybackMode(desc, null), "local");
    assert.equal(canTogglePlaybackMode(desc), true);
  });
});
