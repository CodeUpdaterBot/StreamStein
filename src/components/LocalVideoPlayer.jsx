import { useEffect, useMemo, useRef, useState, useCallback } from "react";

const PROGRESS_TICK_MS = 5000;
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
export default function LocalVideoPlayer({
  filePath,
  sourceUrl,
  startTime = 0,
  poster,
  subtitlePaths = [],
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
  const didResumeRef = useRef(false);
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
  }, [filePath]);

  useEffect(() => {
    let cancelled = false;
    setMediaUrl(null);
    setTracks([]);
    setLoadError(null);
    setPlaybackError(null);
    didResumeRef.current = false;

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
    };

    const onTime = () => reportProgress();

    const onErr = () => {
      const msg = mediaErrorMessage(v);
      setPlaybackError(msg);
      onErrorRef.current?.(new Error(msg));
    };

    const onCanPlay = () => {
      v.play().catch(() => {});
    };

    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("loadeddata", onMeta);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("error", onErr);
    v.addEventListener("canplay", onCanPlay);

    v.src = mediaUrl;
    v.load();
    v.play().catch(() => {});

    const tick = setInterval(reportProgress, PROGRESS_TICK_MS);

    return () => {
      clearInterval(tick);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("loadeddata", onMeta);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("error", onErr);
      v.removeEventListener("canplay", onCanPlay);
      try {
        v.pause();
        v.removeAttribute("src");
        v.load();
      } catch {}
    };
  }, [mediaUrl, reportProgress]);

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
        <span>Loading local file…</span>
      </div>
    );
  }

  return (
    <div
      className={`local-video-player ${className}`}
      style={{ position: "absolute", inset: 0, background: "#000" }}
    >
      {playbackError && (
        <div className="local-video-player__error-overlay">
          <span>{playbackError}</span>
          <span className="local-video-player__error-hint">
            Try Stream mode, or re-download this file.
          </span>
          <FfmpegInstallHint />
        </div>
      )}
      <video
        ref={videoRef}
        className="local-video-player__video"
        poster={poster || undefined}
        controls
        autoPlay
        playsInline
        preload="auto"
        key={mediaUrl}
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
    </div>
  );
}
