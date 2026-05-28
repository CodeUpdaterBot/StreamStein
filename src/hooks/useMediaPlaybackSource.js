import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { storage } from "../utils/storage";
import {
  findLocalDownloadCandidate,
  buildMediaPlaybackDescriptor,
  resolveEffectivePlaybackMode,
  canTogglePlaybackMode,
  playbackModeStorageKey,
} from "../utils/mediaPlayback";

/**
 * Resolves local .mp4 vs stream playback for Movie/TV detail players.
 */
export function useMediaPlaybackSource({
  playing,
  progressKey,
  mediaType,
  tmdbId,
  season,
  episode,
  downloads,
  streamAvailable = true,
}) {
  const [fileExists, setFileExists] = useState(null);
  const [localPlayerUrl, setLocalPlayerUrl] = useState(null);
  const [userPreference, setUserPreference] = useState(() => {
    const key = playbackModeStorageKey(progressKey);
    const v = storage.get(key);
    return v === "local" || v === "stream" ? v : null;
  });
  const [localFailed, setLocalFailed] = useState(false);
  const localFailedRef = useRef(false);

  const localDownload = useMemo(
    () =>
      findLocalDownloadCandidate(downloads, {
        mediaType,
        tmdbId,
        season,
        episode,
      }),
    [downloads, mediaType, tmdbId, season, episode],
  );

  const descriptor = useMemo(
    () =>
      buildMediaPlaybackDescriptor(localDownload, fileExists === true, {
        streamAvailable,
      }),
    [localDownload, fileExists, streamAvailable],
  );

  const effectiveMode = useMemo(() => {
    if (localFailed) return "stream";
    return resolveEffectivePlaybackMode(descriptor, userPreference);
  }, [descriptor, userPreference, localFailed]);

  const isLocalMode = effectiveMode === "local" && descriptor?.hasLocal;

  useEffect(() => {
    if (!localDownload?.filePath) {
      setFileExists(false);
      return;
    }
    let mounted = true;
    setFileExists(null);
    const check = window.electron?.localMediaFileExists
      ? window.electron.localMediaFileExists(localDownload.filePath)
      : window.electron?.fileExists?.(localDownload.filePath);
    Promise.resolve(check)
      .then((exists) => {
        if (mounted) setFileExists(!!exists);
      })
      .catch(() => {
        if (mounted) setFileExists(false);
      });
    return () => {
      mounted = false;
    };
  }, [localDownload?.filePath, localDownload?.id]);

  const reportLocalPlaybackError = useCallback(() => {
    if (localFailedRef.current) return;
    localFailedRef.current = true;
    setLocalFailed(true);
    setLocalPlayerUrl(null);
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[playback] Local file failed; falling back to stream");
    }
  }, []);

  useEffect(() => {
    if (!playing) {
      setLocalPlayerUrl(null);
      return;
    }
    setLocalFailed(false);
    localFailedRef.current = false;
  }, [playing, progressKey, localDownload?.filePath]);

  useEffect(() => {
    const key = playbackModeStorageKey(progressKey);
    const v = storage.get(key);
    setUserPreference(v === "local" || v === "stream" ? v : null);
  }, [progressKey]);

  useEffect(() => {
    if (!playing || !isLocalMode || !localDownload?.filePath) {
      setLocalPlayerUrl(null);
      return;
    }
    if (!window.electron?.localMediaGetUrl) {
      reportLocalPlaybackError();
      return;
    }

    let mounted = true;
    setLocalPlayerUrl(null);
    const startTime = storage.get("dlTime_" + progressKey) || 0;

    window.electron
      .localMediaGetUrl(localDownload.filePath, startTime)
      .then((r) => {
        if (!mounted) return;
        if (r?.ok && r.url) {
          setLocalPlayerUrl(r.url);
        } else if (r?.superseded) {
          // A newer local media request is already in flight; don't fall back to Stream.
          return;
        } else {
          reportLocalPlaybackError();
        }
      })
      .catch(() => {
        if (mounted) reportLocalPlaybackError();
      });

    return () => {
      mounted = false;
    };
  }, [
    playing,
    isLocalMode,
    localDownload?.filePath,
    progressKey,
    reportLocalPlaybackError,
  ]);

  const setPlaybackMode = useCallback(
    (mode) => {
      if (mode !== "local" && mode !== "stream") return;
      setUserPreference(mode);
      setLocalFailed(false);
      localFailedRef.current = false;
      setLocalPlayerUrl(null);
      storage.set(playbackModeStorageKey(progressKey), mode);
    },
    [progressKey],
  );

  const isCheckingLocal =
    playing &&
    isLocalMode &&
    (fileExists === null || (fileExists === true && !localPlayerUrl));

  return {
    descriptor,
    effectiveMode,
    isLocalMode,
    isCheckingLocal,
    canToggle: canTogglePlaybackMode(descriptor) && !localFailed,
    localDownload,
    localPath: descriptor?.localPath ?? null,
    localPlayerUrl,
    setPlaybackMode,
    reportLocalPlaybackError,
    userPreference,
    localFailed,
  };
}
