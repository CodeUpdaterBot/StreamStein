import fs from "node:fs";
import path from "node:path";

const SCHEDULE_MS = {
  "6h": 6 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  daily: 86_400_000,
  "3d": 3 * 86_400_000,
  weekly: 604_800_000
};

const DEFAULT_SELECTION = {
  limit: 20,
  skipFirst: 0,
  skipLast: 0,
  ranges: "",
  excludedVideoIds: [],
  onlyMissing: true,
  missingTranscripts: false
};

export function parseChannelRangeSelection(input, total) {
  const set = new Set();
  if (!input || typeof input !== "string") return set;
  const parts = input.split(",");
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const single = part.match(/^(\d+)$/);
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let start = Number(range[1]);
      let end = Number(range[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (start > end) [start, end] = [end, start];
      for (let i = start; i <= end; i++) {
        if (i >= 1 && i <= total) set.add(i);
      }
    } else if (single) {
      const idx = Number(single[1]);
      if (Number.isFinite(idx) && idx >= 1 && idx <= total) {
        set.add(idx);
      }
    }
  }
  return set;
}

export function formatVideoEntry(raw, index = 0) {
  if (!raw) return null;
  const id = typeof raw === "string" ? raw : raw.id || raw.videoId;
  if (!id) return null;
  const rawTitle = raw.title || raw.recordedTitle || `Video ${index + 1}`;
  return {
    id,
    videoId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: rawTitle,
    normalizedTitle:
      raw.normalizedTitle ||
      (typeof rawTitle === "string"
        ? rawTitle
            .toLowerCase()
            .replace(/[^\w\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        : "")
  };
}

export function normalizeVideoList(input) {
  if (!Array.isArray(input)) return [];
  const result = [];
  input.forEach((item, idx) => {
    const entry = formatVideoEntry(item, idx);
    if (entry) result.push(entry);
  });
  return result;
}

export function applyChannelSelection(entries, selection = {}) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  const total = list.length;
  if (!total) return [];

  const rangesStr = typeof selection.ranges === "string" ? selection.ranges.trim() : "";
  if (rangesStr) {
    const keepSet = parseChannelRangeSelection(rangesStr, total);
    if (!keepSet.size) return [];
    const result = [];
    for (let i = 1; i <= total; i++) {
      if (keepSet.has(i)) result.push(list[i - 1]);
    }
    return result;
  }

  const skipFirst = clampNumber(selection.skipFirst, 0, total, 0);
  const skipLast = clampNumber(selection.skipLast, 0, total, 0);
  const start = Math.min(skipFirst, total);
  const endCut = Math.min(skipLast, total - start);
  return list.slice(start, total - endCut);
}

export function deriveChannelHint(channelUrl) {
  try {
    const u = new URL(channelUrl);
    const withoutVideos = u.pathname.replace(/\/(videos?|streams?)\/?$/i, "");
    const parts = withoutVideos.split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "";
    return last.replace(/^@/, "");
  } catch {
    return "";
  }
}

export function normalizeChannelUrl(urlStr) {
  const u = new URL(urlStr);
  if (u.hostname !== "www.youtube.com" && u.hostname !== "youtube.com") {
    throw new Error("Not a YouTube URL.");
  }
  if (!u.pathname.endsWith("/videos")) {
    u.pathname = u.pathname.endsWith("/") ? `${u.pathname}videos` : `${u.pathname}/videos`;
  }
  return u.toString();
}

export function shouldRunChannel(sub, now = Date.now()) {
  if (!sub?.enabled) return false;
  const interval = SCHEDULE_MS[sub.schedule] || SCHEDULE_MS.daily;
  if (!sub.lastRun) return true;
  const diff = now - new Date(sub.lastRun).getTime();
  return diff >= interval;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function defaultStoreData() {
  return { version: 1, updatedAt: new Date().toISOString(), channels: {} };
}

export function createChannelAutoUpdateStore(storePath) {
  function load() {
    try {
      if (!fs.existsSync(storePath)) return defaultStoreData();
      const raw = fs.readFileSync(storePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.channels === "object") {
        return parsed;
      }
    } catch {
      // rebuild below
    }
    return defaultStoreData();
  }

  function save(data) {
    data.version = 1;
    data.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2), "utf8");
    return data;
  }

  function listAll() {
    const data = load();
    return Object.values(data.channels || {});
  }

  function get(channelKey) {
    if (!channelKey) return null;
    const data = load();
    return data.channels?.[channelKey] || null;
  }

  function upsert(payload) {
    const channelKey = typeof payload?.channelKey === "string" ? payload.channelKey.trim() : "";
    if (!channelKey) throw new Error("channelKey is required");

    const data = load();
    const prev = data.channels[channelKey] || {};
    const selection = {
      ...DEFAULT_SELECTION,
      ...(prev.selection || {}),
      ...(payload.selection || {})
    };

    data.channels[channelKey] = {
      channelKey,
      channelUrl: payload.channelUrl || prev.channelUrl || "",
      channelName: payload.channelName || prev.channelName || "",
      channelId: payload.channelId || prev.channelId || null,
      enabled: payload.enabled !== undefined ? Boolean(payload.enabled) : Boolean(prev.enabled),
      schedule:
        typeof payload.schedule === "string" && SCHEDULE_MS[payload.schedule]
          ? payload.schedule
          : prev.schedule || "daily",
      lastRun: payload.lastRun !== undefined ? payload.lastRun : prev.lastRun || null,
      lastStatus: payload.lastStatus !== undefined ? payload.lastStatus : prev.lastStatus || "idle",
      lastError: payload.lastError !== undefined ? payload.lastError : prev.lastError || null,
      selection
    };

    save(data);
    return data.channels[channelKey];
  }

  function remove(channelKey) {
    const data = load();
    if (data.channels?.[channelKey]) {
      delete data.channels[channelKey];
      save(data);
      return true;
    }
    return false;
  }

  function disable(channelKey) {
    const existing = get(channelKey);
    if (!existing) return null;
    return upsert({ ...existing, enabled: false, lastStatus: "disabled" });
  }

  function listEnabled() {
    return listAll().filter((sub) => sub.enabled);
  }

  function updateRunResult(channelKey, { lastStatus, lastError = null, lastRun = new Date().toISOString() }) {
    const existing = get(channelKey);
    if (!existing) return null;
    return upsert({
      ...existing,
      lastRun,
      lastStatus,
      lastError
    });
  }

  return {
    storePath,
    load,
    save,
    listAll,
    get,
    upsert,
    remove,
    disable,
    listEnabled,
    updateRunResult
  };
}

export function createChannelAutoUpdateRunner({ store, log, deps }) {
  const running = new Set();
  let schedulerTimer = null;

  async function runChannelUpdate(channelKey, { force = false } = {}) {
    if (running.has(channelKey)) {
      return { ok: false, error: "already-running" };
    }

    const sub = store.get(channelKey);
    if (!sub) return { ok: false, error: "not-found" };
    if (!sub.enabled && !force) return { ok: false, error: "not-enabled" };
    if (!force && !shouldRunChannel(sub)) return { ok: false, error: "not-due" };

    running.add(channelKey);
    const logger = log || console;

    try {
      const channelUrl = sub.channelUrl || "";
      if (!channelUrl) {
        store.updateRunResult(channelKey, {
          lastStatus: "error",
          lastError: "Missing channel URL"
        });
        return { ok: false, error: "missing-channel-url" };
      }

      logger.info?.({ channelKey, channelUrl }, "Channel auto-update run started");

      const rawVideos = await deps.listChannelVideos(channelUrl, 500);
      let videos = normalizeVideoList(rawVideos);
      if (!videos.length) {
        store.updateRunResult(channelKey, {
          lastStatus: "ok-no-videos",
          lastError: null
        });
        return { ok: true, queued: 0, message: "No videos found on channel" };
      }

      const selection = { ...DEFAULT_SELECTION, ...(sub.selection || {}) };
      const excluded = new Set(
        Array.isArray(selection.excludedVideoIds) ? selection.excludedVideoIds : []
      );
      let workingList = applyChannelSelection(videos, selection).filter(
        (video) => !excluded.has(video.id)
      );

      if (!workingList.length) {
        store.updateRunResult(channelKey, {
          lastStatus: "ok-no-selection",
          lastError: null
        });
        return { ok: true, queued: 0, message: "Selection filters excluded all videos" };
      }

      const transcriptsOnlyMode = Boolean(selection.missingTranscripts);
      const limit = clampNumber(selection.limit, 1, 500, 20);

      await deps.rescanLibrary({ reason: "channel-auto-update" });
      const channelHint = deriveChannelHint(channelUrl);
      const matchResult = deps.checkLibraryMatches(workingList, {
        channelHint,
        includeLoose: true
      });
      const matchById = new Map();
      (matchResult.videos || []).forEach((match) => {
        if (match?.videoId) matchById.set(match.videoId, match);
      });

      const downloadTranscripts = deps.getDownloadTranscripts?.() !== false;
      const maxQuality = deps.getMaxQuality?.() || "1080";
      const delaySeconds = deps.getDelaySeconds?.() || 15;
      const channelName = sub.channelName || channelHint || "";

      const queue = [];
      for (const video of workingList) {
        const match = matchById.get(video.id) || {};
        const hasVideo = Boolean(match.hasVideo);
        const hasTranscript = Boolean(match.hasTranscript);

        let wantVideo;
        let wantTranscript;

        if (transcriptsOnlyMode) {
          wantVideo = false;
          wantTranscript = downloadTranscripts && hasVideo && !hasTranscript;
        } else {
          wantVideo = !hasVideo;
          wantTranscript = downloadTranscripts && !hasTranscript;
        }

        if (selection.onlyMissing && !transcriptsOnlyMode && hasVideo && !wantTranscript) {
          continue;
        }

        if (!wantVideo && !wantTranscript) continue;

        queue.push({ video, match, wantVideo, wantTranscript });
      }

      const toDownload = queue.slice(0, limit);
      if (!toDownload.length) {
        store.updateRunResult(channelKey, {
          lastStatus: "ok-no-new",
          lastError: null
        });
        return { ok: true, downloaded: 0, skipped: workingList.length, message: "Nothing new to download" };
      }

      let downloaded = 0;
      const skipped = workingList.length - queue.length;

      for (let i = 0; i < toDownload.length; i++) {
        const { video, match, wantVideo, wantTranscript } = toDownload[i];
        const watchUrl = `https://www.youtube.com/watch?v=${video.id}`;

        const titleLabel = match.recordedTitle || video.title || `YouTube video ${video.id}`;
        const safeTitle = deps.sanitizeFileName(titleLabel);

        if (wantVideo) {
          const videoPath = deps.resolveOutputPath(`${safeTitle}.mp4`, channelName);
          await deps.downloadVideoToFile(watchUrl, videoPath, maxQuality);
          const stat = deps.safeStat(videoPath);
          deps.registerLibraryFile({
            videoId: video.id,
            title: titleLabel,
            normalizedTitle: deps.normalizeTitleKey(titleLabel),
            path: videoPath,
            type: "video",
            size: stat?.size ?? null,
            mtime: stat?.mtimeMs ?? null,
            source: "channel-auto-update",
            quality: maxQuality,
            channelId: sub.channelId || null,
            channelName: channelName || null,
            watchUrl
          });
          downloaded++;
        }

        if (wantTranscript) {
          const transcriptPath = deps.resolveOutputPath(`${safeTitle}.vtt`, channelName);
          await deps.downloadTranscriptToFile(watchUrl, transcriptPath);
          const stat = deps.safeStat(transcriptPath);
          deps.registerLibraryFile({
            videoId: video.id,
            title: titleLabel,
            normalizedTitle: deps.normalizeTitleKey(titleLabel),
            path: transcriptPath,
            type: "transcript",
            size: stat?.size ?? null,
            mtime: stat?.mtimeMs ?? null,
            source: "channel-auto-update",
            channelId: sub.channelId || null,
            channelName: channelName || null,
            watchUrl
          });
          downloaded++;
        }

        if (i < toDownload.length - 1 && delaySeconds > 0) {
          await deps.sleepMs(delaySeconds * 1000);
        }
      }

      const status = downloaded > 0 ? "ok" : "ok-no-new";

      store.updateRunResult(channelKey, {
        lastStatus: status,
        lastError: null
      });

      logger.info?.(
        { channelKey, downloaded, skipped },
        "Channel auto-update run completed"
      );

      return { ok: true, downloaded, skipped };
    } catch (err) {
      const message = err?.message || String(err);
      logger.error?.({ channelKey, error: message }, "Channel auto-update run failed");
      store.updateRunResult(channelKey, {
        lastStatus: "error",
        lastError: message
      });
      return { ok: false, error: message };
    } finally {
      running.delete(channelKey);
    }
  }

  async function tick() {
    const enabled = store.listEnabled();
    for (const sub of enabled) {
      if (!shouldRunChannel(sub) || running.has(sub.channelKey)) continue;
      // eslint-disable-next-line no-await-in-loop
      await runChannelUpdate(sub.channelKey);
    }
  }

  function startScheduler(intervalMs = 15 * 60 * 1000) {
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = setInterval(() => {
      void tick();
    }, intervalMs);
    void tick();
  }

  function stopScheduler() {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
  }

  return {
    runChannelUpdate,
    tick,
    startScheduler,
    stopScheduler,
    isRunning: (channelKey) => running.has(channelKey)
  };
}
