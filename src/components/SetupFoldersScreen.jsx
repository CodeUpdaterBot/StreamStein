import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { StreamsteinLogo, PlayIcon } from "./Icons";
import { isElectron } from "../utils/storage";
import {
  resolveLibraryPaths,
  persistLibraryPaths,
} from "../utils/libraryPaths";

function trimPath(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveFolderStatus({ value, scanning, stats, scanError }) {
  const path = value?.trim() || "";
  if (!path) {
    return {
      state: "idle",
      tooltip: "Choose a folder — we will scan it to confirm your library.",
    };
  }
  if (scanning) {
    return {
      state: "scanning",
      tooltip: "Scanning folder…",
    };
  }
  if (scanError) {
    return {
      state: "error",
      tooltip: scanError,
    };
  }
  if (!stats) {
    return {
      state: "pending",
      tooltip: "Preparing scan…",
    };
  }
  if (!stats.exists) {
    return {
      state: "error",
      tooltip:
        "Folder not found on disk. Check the path, fix typos, or create the folder first.",
    };
  }
  const videoLine =
    stats.videos != null ? `${stats.videos} video${stats.videos === 1 ? "" : "s"}` : null;
  const subLine =
    stats.transcripts != null
      ? `${stats.transcripts} subtitle${stats.transcripts === 1 ? "" : "s"} / transcript${stats.transcripts === 1 ? "" : "s"}`
      : null;
  const catalogLine =
    stats.catalogEntries != null
      ? `${stats.catalogEntries} catalog entries`
      : null;
  const parts = [videoLine, subLine, catalogLine].filter(Boolean);
  return {
    state: "ok",
    tooltip: parts.length
      ? `Folder loaded — ${parts.join(", ")} detected.`
      : "Folder loaded and ready.",
  };
}

function FolderStatusBadge({ status }) {
  const { state, tooltip } = status;

  if (state === "idle") return null;

  return (
    <span
      className={`setup-folder-status setup-folder-status--${state}`}
      title={tooltip}
      aria-label={tooltip}
      role="status"
    >
      {state === "scanning" && <span className="setup-folder-status-spinner" />}
      {state === "ok" && (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path
            d="M2 6.2L5 9.2L10 3.2"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {state === "error" && (
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
          <path
            d="M2.5 2.5L8.5 8.5M8.5 2.5L2.5 8.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      )}
      {state === "pending" && (
        <span className="setup-folder-status-dot" aria-hidden />
      )}
    </span>
  );
}

function StatsLine({ stats }) {
  const items = [];
  if (stats.videos != null) {
    items.push(
      `${stats.videos} video${stats.videos === 1 ? "" : "s"}`,
    );
  }
  if (stats.transcripts != null) {
    items.push(
      `${stats.transcripts} subtitle${stats.transcripts === 1 ? "" : "s"}`,
    );
  }
  if (stats.catalogEntries != null) {
    const catalogNote = stats.catalogExists
      ? "youtube-catalog.json"
      : "no catalog file";
    items.push(`${stats.catalogEntries} catalog · ${catalogNote}`);
  }
  if (
    stats.videosOnDisk != null &&
    stats.videosOnDisk !== stats.videos
  ) {
    items.push(`${stats.videosOnDisk} on disk`);
  }
  if (!items.length) return null;
  return <p className="setup-stats-line">{items.join(" · ")}</p>;
}

function FolderRow({
  title,
  description,
  value,
  onChange,
  onBrowse,
  stats,
  scanning,
  scanError,
  browseLabel = "Browse…",
}) {
  const status = resolveFolderStatus({ value, scanning, stats, scanError });
  const showStats = value.trim() && status.state === "ok";

  return (
    <div
      className={`setup-folder-block${status.state === "ok" ? " setup-folder-block--ok" : ""}${status.state === "error" ? " setup-folder-block--error" : ""}`}
    >
      <div className="setup-folder-heading-row">
        <div className="setup-folder-heading">{title}</div>
        <FolderStatusBadge status={status} />
      </div>
      {status.state !== "ok" && (
        <p className="setup-folder-desc">{description}</p>
      )}
      <div className="setup-folder-row">
        <input
          className="apikey-input setup-folder-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Select a folder…"
        />
        {isElectron && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onBrowse}
          >
            {browseLabel}
          </button>
        )}
      </div>
      {showStats && <StatsLine stats={stats} />}
      {status.state === "error" && value.trim() && (
        <div className="setup-folder-warn">{status.tooltip}</div>
      )}
    </div>
  );
}

export default function SetupFoldersScreen({
  initialMoviesFolder = "",
  initialYoutubeFolder = "",
  prefillDefaults = false,
  onComplete,
  stepLabel,
}) {
  const [moviesFolder, setMoviesFolder] = useState("");
  const [youtubeFolder, setYoutubeFolder] = useState("");
  const [pathsLoaded, setPathsLoaded] = useState(false);
  const [moviesStats, setMoviesStats] = useState(null);
  const [youtubeStats, setYoutubeStats] = useState(null);
  const [moviesScanError, setMoviesScanError] = useState(null);
  const [youtubeScanError, setYoutubeScanError] = useState(null);
  const [scanningMovies, setScanningMovies] = useState(false);
  const [scanningYoutube, setScanningYoutube] = useState(false);
  const scanTimer = useRef(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const stored = await resolveLibraryPaths();
      if (!mounted) return;
      const movies =
        trimPath(stored.movies) ||
        trimPath(initialMoviesFolder) ||
        "";
      const youtube =
        trimPath(stored.youtube) ||
        trimPath(initialYoutubeFolder) ||
        "";
      setMoviesFolder(movies);
      setYoutubeFolder(youtube);
      setPathsLoaded(true);
    })();
    return () => {
      mounted = false;
    };
  }, [initialMoviesFolder, initialYoutubeFolder]);

  useEffect(() => {
    if (!pathsLoaded || !prefillDefaults || !isElectron) return;
    let mounted = true;
    (async () => {
      if (moviesFolder.trim() && youtubeFolder.trim()) return;
      try {
        const [dlDefault, ytDefault] = await Promise.all([
          window.electron.getDefaultDownloaderFolder?.(),
          window.electron.getYoutubeDefaultFolder?.(),
        ]);
        if (!mounted) return;
        if (!moviesFolder.trim() && dlDefault?.folder) {
          setMoviesFolder(dlDefault.folder);
        }
        if (!youtubeFolder.trim() && ytDefault?.folder) {
          setYoutubeFolder(ytDefault.folder);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      mounted = false;
    };
  }, [pathsLoaded, prefillDefaults, moviesFolder, youtubeFolder]);

  const refreshStats = useCallback(async (movies, youtube) => {
    if (!window.electron?.getSetupFolderStats) return;
    const m = movies.trim();
    const y = youtube.trim();
    if (m) {
      setScanningMovies(true);
      setMoviesScanError(null);
    }
    if (y) {
      setScanningYoutube(true);
      setYoutubeScanError(null);
    }
    try {
      const res = await window.electron.getSetupFolderStats({
        moviesFolder: m,
        youtubeFolder: y,
      });
      if (res?.ok) {
        if (m) setMoviesStats(res.movies);
        if (y) {
          setYoutubeStats(res.youtube);
        }
      } else {
        const msg = res?.error || "Could not scan folder.";
        if (m) setMoviesScanError(msg);
        if (y) setYoutubeScanError(msg);
      }
    } catch {
      if (m) setMoviesScanError("Scan failed — check the path and try again.");
      if (y) setYoutubeScanError("Scan failed — check the path and try again.");
    } finally {
      setScanningMovies(false);
      setScanningYoutube(false);
    }
  }, []);

  useEffect(() => {
    if (!isElectron) return;
    clearTimeout(scanTimer.current);
    scanTimer.current = setTimeout(() => {
      refreshStats(moviesFolder, youtubeFolder);
    }, 400);
    return () => clearTimeout(scanTimer.current);
  }, [moviesFolder, youtubeFolder, refreshStats]);

  const pickMovies = async () => {
    const folder = await window.electron?.pickFolder?.();
    if (folder) setMoviesFolder(folder);
  };

  const pickYoutube = async () => {
    const folder = await window.electron?.pickFolder?.();
    if (folder) setYoutubeFolder(folder);
  };

  const moviesStatus = useMemo(
    () =>
      resolveFolderStatus({
        value: moviesFolder,
        scanning: scanningMovies,
        stats: moviesStats
          ? {
              exists: moviesStats.exists,
              videos: moviesStats.videos,
              transcripts: moviesStats.subtitles,
            }
          : null,
        scanError: moviesScanError,
      }),
    [moviesFolder, scanningMovies, moviesStats, moviesScanError],
  );

  const youtubeStatus = useMemo(
    () =>
      resolveFolderStatus({
        value: youtubeFolder,
        scanning: scanningYoutube,
        stats: youtubeStats
          ? {
              exists: youtubeStats.exists,
              videos: youtubeStats.videos,
              transcripts: youtubeStats.transcripts,
              catalogEntries: youtubeStats.catalogEntries,
              catalogExists: youtubeStats.catalogExists,
            }
          : null,
        scanError: youtubeScanError,
      }),
    [youtubeFolder, scanningYoutube, youtubeStats, youtubeScanError],
  );

  const canContinue =
    moviesStatus.state === "ok" && youtubeStatus.state === "ok";

  const handleContinue = async () => {
    await persistLibraryPaths({
      movies: moviesFolder,
      youtube: youtubeFolder,
      markComplete: true,
    });
    onComplete?.();
  };

  return (
    <div className="setup-shell">
      <div className="setup-shell-center">
        <div className="apikey-box setup-card setup-folders-box">
          <div className="apikey-logo">
            <StreamsteinLogo />
          </div>
          <div className="apikey-title setup-folders-title">LIBRARY FOLDERS</div>
          {stepLabel && <div className="setup-step-label">{stepLabel}</div>}
          <p className="apikey-sub setup-folders-sub">
            Point Streamstein at your <strong>movies &amp; TV</strong> and{" "}
            <strong>YouTube</strong> folders. We scan each path to confirm it
            is ready.
          </p>

          <FolderRow
            title="Movies & TV"
            description="Downloaded movies and series episodes (e.g. Movies_TV). Streamstein needs read/write access."
            value={moviesFolder}
            onChange={setMoviesFolder}
            onBrowse={pickMovies}
            stats={
              moviesStats
                ? {
                    videos: moviesStats.videos,
                    transcripts: moviesStats.subtitles,
                    exists: moviesStats.exists,
                  }
                : null
            }
            scanning={scanningMovies}
            scanError={moviesScanError}
          />

          <FolderRow
            title="YouTube library"
            description="Folder used by the YouTube Downloader Extension — contains videos and youtube-catalog.json."
            value={youtubeFolder}
            onChange={setYoutubeFolder}
            onBrowse={pickYoutube}
            stats={
              youtubeStats
                ? {
                    videos: youtubeStats.videos,
                    transcripts: youtubeStats.transcripts,
                    catalogEntries: youtubeStats.catalogEntries,
                    catalogExists: youtubeStats.catalogExists,
                    videosOnDisk: youtubeStats.videosOnDisk,
                    exists: youtubeStats.exists,
                  }
                : null
            }
            scanning={scanningYoutube}
            scanError={youtubeScanError}
          />

          <button
            type="button"
            className="btn btn-primary setup-folders-continue"
            disabled={!canContinue}
            onClick={handleContinue}
          >
            <PlayIcon /> Continue to Streamstein
          </button>

          {!canContinue && (
            <p className="setup-continue-hint">
              {moviesStatus.state !== "ok" && youtubeStatus.state !== "ok"
                ? "Both folders must scan successfully before continuing."
                : moviesStatus.state !== "ok"
                  ? "Movies & TV folder must be valid and scanned."
                  : "YouTube library folder must be valid and scanned."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
