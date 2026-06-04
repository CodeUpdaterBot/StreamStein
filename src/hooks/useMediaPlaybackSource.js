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
  /** When set, use this completed download entry instead of the downloads registry. */
  localDownloadOverride = null,
}) {
  const [fileExists, setFileExists] = useState(null);
  const [localPlayerUrl, setLocalPlayerUrl] = useState(null);
  const [localPrepareMode, setLocalPrepareMode] = useState(null);
  const [userPreference, setUserPreference] = useState(() => {
    const key = playbackModeStorageKey(progressKey);
    const v = storage.get(key);
    return v === "local" || v === "stream" ? v : null;
  });
  const [localFailed, setLocalFailed] = useState(false);
  const [localLoadError, setLocalLoadError] = useState(null);
  const localFailedRef = useRef(false);

  const localDownload = useMemo(
    () =>
      localDownloadOverride ??
      findLocalDownloadCandidate(downloads, {
        mediaType,
        tmdbId,
        season,
        episode,
      }),
    [
      localDownloadOverride,
      downloads,
      mediaType,
      tmdbId,
      season,
      episode,
    ],
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
      setLocalPrepareMode(null);
      setLocalLoadError(null);
      return;
    }
    setLocalFailed(false);
    setLocalLoadError(null);
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
    setLocalPrepareMode(null);
    setLocalLoadError(null);
    const startTime = storage.get("dlTime_" + progressKey) || 0;

    window.electron
      .localMediaGetUrl(localDownload.filePath, startTime)
      .then((r) => {
        if (!mounted) return;
        if (r?.ok && r.url) {
          setLocalLoadError(null);
          setLocalPrepareMode(r.prepareMode || null);
          setLocalPlayerUrl(r.url);
        } else if (r?.superseded) {
          // A newer local media request is already in flight; don't fall back to Stream.
          return;
        } else {
          const msg = r?.error || "Could not open local file";
          setLocalLoadError(msg);
          if (streamAvailable) {
            reportLocalPlaybackError();
          }
        }
      })
      .catch((err) => {
        if (!mounted) return;
        setLocalLoadError(err?.message || "Could not open local file");
        if (streamAvailable) {
          reportLocalPlaybackError();
        }
      });

    return () => {
      mounted = false;
      window.electron?.localMediaRelease?.();
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
    localPrepareMode,
    localLoadError,
    setLocalLoadError,
    setPlaybackMode,
    reportLocalPlaybackError,
    userPreference,
    localFailed,
  };
}
