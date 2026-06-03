import { useEffect, useMemo, useRef, useState, useCallback } from "react";

const PROGRESS_TICK_MS = 5000;
/** If metadata duration is far below ffprobe duration, retry with a prepared remux. */
const DURATION_MISMATCH_RATIO = 0.15;
const MIN_PROBE_DURATION_SEC = 180;
/** If direct decode has not started after this, try a prepared remux. */
const LOAD_STALL_MS = 14000;
const FFMPEG_WINDOWS_URL = "https://www.gyan.dev/ffmpeg/builds/";
const FFMPEG_SETUP_SEARCH_URL =
  "https://www.google.com/search?q=install+ffmpeg+windows+10+add+to+PATH";

function mediaErrorMessage(video) {
  const err = video?.error;
  if (!err) return "Playback failed";
  switch (err.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "Playback aborted";
    case MediaError.MEDIA_ERR_NETWORK:
      return "Network error while loading the file";
    case MediaError.MEDIA_ERR_DECODE:
      return "Could not decode video (codec or corrupt file)";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "Video format or codec not supported";
    default:
      return err.message || "Playback failed";
  }
}

function openExternal(url) {
  if (window.electron?.openExternal) {
    window.electron.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function FfmpegInstallHint() {
  return (
    <span className="local-video-player__error-hint">
      Install FFmpeg/FFprobe and restart Streamstein if this file needs codec
      conversion. On Windows, use the FFmpeg builds and put{" "}
      <code>C:\ffmpeg\bin</code> on PATH.{" "}
      <button
        type="button"
        className="local-video-player__error-link"
        onClick={() => openExternal(FFMPEG_WINDOWS_URL)}
      >
        FFmpeg download
      </button>{" "}
      <button
        type="button"
        className="local-video-player__error-link"
        onClick={() => openExternal(FFMPEG_SETUP_SEARCH_URL)}
      >
        setup help
      </button>
    </span>
  );
}

/**
 * Local .mp4 playback using native HTML5 video + loopback HTTP.
 * Streams should stay in the webview, but local files are first-party media and
 * should use Chromium's normal <video> pipeline with byte-range HTTP support.
 */
function loadingLabel(prepareMode) {
  if (!prepareMode) return "Loading local file…";
  if (prepareMode.includes("remux") || prepareMode.includes("transcode")) {
    return "Preparing video for playback…";
  }
  if (prepareMode === "live-transcode") {
    return "Starting playback…";
  }
  return "Opening local file…";
}

export default function LocalVideoPlayer({
  filePath,
  sourceUrl,
  startTime = 0,
  poster,
  subtitlePaths = [],
  prepareMode = null,
  onProgress,
  onError,
  onReady,
  className = "",
}) {
  const videoRef = useRef(null);
  const [mediaUrl, setMediaUrl] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [playbackError, setPlaybackError] = useState(null);
  const [isRemuxing, setIsRemuxing] = useState(false);
  const isRemuxingRef = useRef(false);
  isRemuxingRef.current = isRemuxing;
  const didResumeRef = useRef(false);
  const prepareFallbackRef = useRef(false);
  const durationRepairRef = useRef(false);
  const probedDurationRef = useRef(null);
  const resumeTimeRef = useRef(startTime);
  const onErrorRef = useRef(onError);
  const onProgressRef = useRef(onProgress);
  const onReadyRef = useRef(onReady);
  onErrorRef.current = onError;
  onProgressRef.current = onProgress;
  onReadyRef.current = onReady;
  const subtitleKey = useMemo(
    () =>
      JSON.stringify(
        (subtitlePaths || []).map((sp) =>
          typeof sp === "string" ? sp : `${sp?.path || ""}:${sp?.lang || ""}`,
        ),
      ),
    [subtitlePaths],
  );

  useEffect(() => {
    resumeTimeRef.current = Math.max(0, Number(startTime) || 0);
    durationRepairRef.current = false;
    probedDurationRef.current = null;
  }, [filePath]);

  useEffect(() => {
    if (!filePath || !window.electron?.getVideoDuration) return;
    let cancelled = false;
    window.electron.getVideoDuration(filePath).then((r) => {
      if (!cancelled && r?.ok && r.duration > 0) {
        probedDurationRef.current = r.duration;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  useEffect(() => {
    let cancelled = false;
    setMediaUrl(null);
    setTracks([]);
    setLoadError(null);
    setPlaybackError(null);
    didResumeRef.current = false;
    prepareFallbackRef.current = false;

    if (sourceUrl) {
      setMediaUrl(sourceUrl);
    }

    if (sourceUrl) {
      // The parent already resolved the tokenized HTTP media URL. Continue below
      // only for subtitle track resolution.
    } else if (!filePath || !window.electron?.localMediaGetUrl) {
      const msg = "Local playback unavailable";
      setLoadError(msg);
      onErrorRef.current?.(new Error(msg));
      return;
    }

    (async () => {
      try {
        if (!sourceUrl) {
          const main = await window.electron.localMediaGetUrl(
            filePath,
            resumeTimeRef.current,
          );
          if (cancelled) return;
          if (!main?.ok || !main.url) {
            const err = new Error(main?.error || "Could not open local file");
            setLoadError(err.message);
            onErrorRef.current?.(err);
            return;
          }
          setMediaUrl(main.url);
        }

        const paths = (subtitlePaths || []).filter(
          (sp) => sp && (typeof sp === "string" ? sp : sp.path),
        );
        if (!paths.length) return;

        const resolved = await Promise.all(
          paths.map(async (sp) => {
            const p = typeof sp === "string" ? sp : sp.path;
            const lang = typeof sp === "object" && sp.lang ? sp.lang : "und";
            try {
              const r = await window.electron.localMediaGetUrl(p);
              if (r?.ok && r.url) return { src: r.url, lang, path: p };
            } catch {}
            return null;
          }),
        );
        if (!cancelled) setTracks(resolved.filter(Boolean));
      } catch (e) {
        if (cancelled) return;
        setLoadError(e.message || "Could not open local file");
        onErrorRef.current?.(e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [filePath, sourceUrl, subtitleKey]);

  const reportProgress = useCallback(() => {
    const v = videoRef.current;
    if (!v?.duration || !Number.isFinite(v.duration) || v.duration <= 0) return;
    onProgressRef.current?.({
      currentTime: v.currentTime,
      duration: v.duration,
    });
  }, []);

  const switchToPreparedPlayback = useCallback(
    async (resumeAt) => {
      if (!filePath || !window.electron?.localMediaGetPreparedUrl) return false;
      setIsRemuxing(true);
      setPlaybackError(null);
      try {
        const at = Math.max(0, Number(resumeAt) || 0);
        const r = await window.electron.localMediaGetPreparedUrl(filePath, at);
        if (r?.ok && r.url) {
          prepareFallbackRef.current = true;
          didResumeRef.current = false;
          resumeTimeRef.current = at;
          setMediaUrl(r.url);
          return true;
        }
        const msg = r?.error || "Could not prepare file for playback";
        setPlaybackError(msg);
        onErrorRef.current?.(new Error(msg));
        return false;
      } catch (e) {
        const msg = e?.message || "Could not prepare file for playback";
        setPlaybackError(msg);
        onErrorRef.current?.(e);
        return false;
      } finally {
        setIsRemuxing(false);
      }
    },
    [filePath],
  );

  const maybeRepairTruncatedDuration = useCallback(async () => {
    const v = videoRef.current;
    if (!v || !filePath || durationRepairRef.current) return;
    const probed = probedDurationRef.current;
    const metaDur = v.duration;
    if (!probed || probed < MIN_PROBE_DURATION_SEC) return;
    if (!metaDur || !Number.isFinite(metaDur) || metaDur <= 0) return;
    if (metaDur >= probed * DURATION_MISMATCH_RATIO) return;
    if (prepareFallbackRef.current) return;

    durationRepairRef.current = true;
    const resumeAt = Math.max(0, v.currentTime || resumeTimeRef.current || 0);
    await switchToPreparedPlayback(resumeAt);
  }, [filePath, switchToPreparedPlayback]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !mediaUrl) return;

    const onMeta = () => {
      if (!didResumeRef.current) {
        didResumeRef.current = true;
        const resumeTime = resumeTimeRef.current;
        if (resumeTime > 0 && v.duration > resumeTime) {
          try {
            v.currentTime = resumeTime;
          } catch {}
        }
        onReadyRef.current?.();
      }
      reportProgress();
      void maybeRepairTruncatedDuration();
    };

    const onTime = () => reportProgress();

    const onDurationChange = () => {
      reportProgress();
      void maybeRepairTruncatedDuration();
    };

    const onErr = async () => {
      const err = v?.error;
      const code = err?.code;
      const canRetry =
        filePath &&
        !prepareFallbackRef.current &&
        window.electron?.localMediaGetPreparedUrl &&
        (code === MediaError.MEDIA_ERR_DECODE ||
          code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ||
          code === MediaError.MEDIA_ERR_NETWORK);

      if (canRetry) {
        const ok = await switchToPreparedPlayback(resumeTimeRef.current);
        if (ok) return;
      }

      const msg = mediaErrorMessage(v);
      setPlaybackError(msg);
      onErrorRef.current?.(new Error(msg));
    };

    const onCanPlay = () => {
      v.play().catch(() => {});
    };

    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("loadeddata", onMeta);
    v.addEventListener("durationchange", onDurationChange);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("error", onErr);
    v.addEventListener("canplay", onCanPlay);

    v.src = mediaUrl;
    v.load();
    v.play().catch(() => {});

    const tick = setInterval(reportProgress, PROGRESS_TICK_MS);

    const stallTimer = setTimeout(() => {
      if (prepareFallbackRef.current || isRemuxingRef.current) return;
      if (!v || v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
      void switchToPreparedPlayback(resumeTimeRef.current);
    }, LOAD_STALL_MS);

    return () => {
      clearTimeout(stallTimer);
      clearInterval(tick);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("loadeddata", onMeta);
      v.removeEventListener("durationchange", onDurationChange);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("error", onErr);
      v.removeEventListener("canplay", onCanPlay);
      try {
        v.pause();
        v.removeAttribute("src");
        v.load();
      } catch {}
    };
  }, [mediaUrl, reportProgress, maybeRepairTruncatedDuration, switchToPreparedPlayback]);

  if (loadError) {
    return (
      <div
        className={`local-video-player local-video-player--error ${className}`}
      >
        <span>{loadError}</span>
        <FfmpegInstallHint />
      </div>
    );
  }

  if (!mediaUrl) {
    return (
      <div
        className={`local-video-player local-video-player--loading ${className}`}
      >
        <div className="spinner" />
        <span>
          {isRemuxing
            ? "Preparing compatible playback…"
            : loadingLabel(prepareMode)}
        </span>
        {isRemuxing && (
          <span className="local-video-player__loading-hint">
            Converting this file for in-app playback (once). Long videos may take a
            few minutes; later opens use the cached copy.
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className={`local-video-player ${className}`}
      style={{ position: "absolute", inset: 0, background: "#000" }}
    >
      {isRemuxing && (
        <div className="local-video-player__remux-overlay">
          <div className="spinner" />
          <span>Preparing compatible playback…</span>
          <span className="local-video-player__loading-hint">
            Converting audio/video for this file (once per file). Long videos may
            take several minutes; later opens use the cached copy.
          </span>
        </div>
      )}
      {playbackError && (
        <div className="local-video-player__error-overlay">
          <span>{playbackError}</span>
          <span className="local-video-player__error-hint">
            Try Stream mode, or re-download this file.
          </span>
          <FfmpegInstallHint />
        </div>
      )}
      {mediaUrl && (
      <video
        ref={videoRef}
        className="local-video-player__video"
        poster={poster || undefined}
        controls
        autoPlay
        playsInline
        preload="auto"
        key={mediaUrl}
        style={isRemuxing ? { visibility: "hidden" } : undefined}
      >
        {tracks.map((t) => (
          <track
            key={t.path}
            kind="subtitles"
            src={t.src}
            srcLang={t.lang}
            label={t.lang}
            default={tracks[0] === t}
          />
        ))}
      </video>
      )}
    </div>
  );
}
