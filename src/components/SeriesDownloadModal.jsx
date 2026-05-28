import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { CloseIcon, DownloadIcon } from "./Icons";
import { storage, STORAGE_KEYS } from "../utils/storage";

const DEFAULT_SOURCES = ["videasy", "vidsrc"];
const SOURCE_ORDER = ["videasy", "vidsrc", "2embed"];

function sortSeriesSources(list) {
  return [...list].sort(
    (a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b),
  );
}

export default function SeriesDownloadModal({
  open,
  onClose,
  showTitle,
  year,
  animeTitle,
  isAnime,
  dubMode,
  tmdbId,
  mediaId,
  posterPath,
  seasons = [],
  allEpisodes = [],
  downloaderFolder,
  onComplete,
  onDownloadStarted,
  /** Must use TV page player — same steps as manual download */
  runSeriesDownload,
}) {
  const [downloadPath, setDownloadPath] = useState(
    () => storage.get("downloadPath") || "",
  );
  const [downloader, setDownloader] = useState(null);
  const [checking, setChecking] = useState(false);
  const [selectedSeasons, setSelectedSeasons] = useState(() => new Set());
  const [skipExisting, setSkipExisting] = useState(
    () => storage.get(STORAGE_KEYS.SERIES_DL_SKIP_EXISTING) !== false,
  );
  const [sources, setSources] = useState(
    () => storage.get(STORAGE_KEYS.SERIES_DL_SOURCES) || DEFAULT_SOURCES,
  );
  const [progress, setProgress] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const batchIdRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setProgress(null);
    const nums = seasons.map((s) => s.season_number);
    setSelectedSeasons(new Set(nums));
  }, [open, seasons]);

  useEffect(() => {
    if (!open || !downloaderFolder) return;
    let mounted = true;
    setChecking(true);
    window.electron.checkDownloader(downloaderFolder).then((r) => {
      if (mounted) {
        setDownloader(r);
        setChecking(false);
      }
    });
    return () => {
      mounted = false;
    };
  }, [open, downloaderFolder]);

  const episodes = useMemo(() => {
    return allEpisodes.filter((ep) =>
      selectedSeasons.has(ep.uiSeason ?? ep.season),
    );
  }, [allEpisodes, selectedSeasons]);

  const episodeCount = episodes.length;

  const toggleSeason = (num) => {
    setSelectedSeasons((prev) => {
      const next = new Set(prev);
      if (next.has(num)) next.delete(num);
      else next.add(num);
      return next;
    });
  };

  const toggleSource = (id) => {
    setSources((prev) => {
      const next = prev.includes(id)
        ? prev.filter((s) => s !== id)
        : [...prev, id];
      if (!next.length) return prev;
      storage.set(STORAGE_KEYS.SERIES_DL_SOURCES, next);
      return next;
    });
  };

  const handleStart = useCallback(async () => {
    if (!downloader?.token || !downloadPath || !episodes.length) return;
    if (!runSeriesDownload) {
      setError("Series download is only available on the TV show page.");
      return;
    }
    setRunning(true);
    setError(null);
    storage.set(STORAGE_KEYS.SERIES_DL_SKIP_EXISTING, skipExisting);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await runSeriesDownload(
        {
          token: downloader.token,
          downloadPath,
          showTitle,
          year,
          animeTitle: animeTitle || showTitle,
          isAnime,
          dubMode,
          tmdbId,
          mediaId,
          posterPath,
          skipExisting,
          sources: isAnime ? [] : sortSeriesSources(sources),
          episodes,
        },
        {
          onProgress: setProgress,
          onDownloadStarted,
          signal: controller.signal,
        },
      );

      batchIdRef.current = result.batchId || null;

      if (!result.cancelled) {
        onComplete?.();
        onClose();
      }
    } catch (e) {
      setError(e.message || "Series download failed");
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [
    runSeriesDownload,
    downloader,
    downloadPath,
    episodes,
    showTitle,
    year,
    animeTitle,
    isAnime,
    dubMode,
    tmdbId,
    mediaId,
    posterPath,
    skipExisting,
    sources,
    onComplete,
    onClose,
    onDownloadStarted,
  ]);

  const handleCancel = () => {
    abortRef.current?.abort();
    window.electron.cancelSeriesDownload?.({
      batchId: batchIdRef.current,
    });
    setRunning(false);
    setProgress((p) => (p ? { ...p, phase: "cancelled" } : p));
  };

  if (!open) return null;

  const busy = running;

  const progressLine = (() => {
    if (!progress) return null;
    switch (progress.phase) {
      case "starting":
        return progress.message || "Starting…";
      case "loading":
        return progress.message || `Loading ${progress.current ?? "episode"}…`;
      case "playing":
        return (
          progress.message ||
          `Playing ${progress.current ?? "episode"} in the player…`
        );
      case "resolving":
        return `Capturing stream for ${progress.current ?? "episode"}…`;
      case "downloading":
      case "staged":
        return progress.message || `Queued ${progress.current ?? "episode"}`;
      case "skipped":
        return `Skipped ${progress.current ?? "episode"}`;
      case "finished":
        return progress.message || "Done";
      case "cancelled":
        return "Cancelled";
      default:
        return progress.message || progress.current || "";
    }
  })();

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 999999,
        background: "rgba(0,0,0,0.78)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={busy ? undefined : onClose}
    >
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          width: 520,
          maxWidth: "95vw",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "15px 20px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 15 }}>
            <DownloadIcon size={14} /> Download series
          </span>
          <button className="icon-btn" onClick={onClose} disabled={busy}>
            <CloseIcon />
          </button>
        </div>

        <div style={{ padding: "16px 20px", overflowY: "auto", flex: 1 }}>
          <p style={{ fontSize: 13, color: "var(--text2)", marginBottom: 14 }}>
            {showTitle}
            {year ? ` (${year})` : ""} — automates the same steps you use manually:
            open each episode in the player below, start playback in the embed,
            then queue the download when the stream is ready.
            {!isAnime && (
              <>
                {" "}
                Sources:{" "}
                {sources
                  .map((s) => (s === "videasy" ? "Videasy" : "VidSrc"))
                  .join(", ")}
                .
              </>
            )}
          </p>

          {busy && (
            <div
              style={{
                padding: 10,
                marginBottom: 12,
                borderRadius: 8,
                background: "rgba(229,9,20,0.1)",
                border: "1px solid rgba(229,9,20,0.25)",
                fontSize: 12,
                color: "var(--text1)",
              }}
            >
              The video player on this page is running each episode in the
              background (you may see it load behind this dialog). Do not close
              the show page until finished.
            </div>
          )}

          {!downloadPath && (
            <div
              style={{
                padding: 10,
                background: "rgba(229,9,20,0.08)",
                borderRadius: 8,
                fontSize: 12,
                color: "var(--red)",
                marginBottom: 12,
              }}
            >
              Set a download folder in Settings or the single-episode download
              dialog first.
            </div>
          )}

          {!isAnime && (
            <div style={{ marginBottom: 14 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "var(--text3)",
                  marginBottom: 6,
                  textTransform: "uppercase",
                }}
              >
                Sources
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {["videasy", "vidsrc"].map((id) => (
                  <label
                    key={id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 12,
                      cursor: busy ? "default" : "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={sources.includes(id)}
                      onChange={() => toggleSource(id)}
                      disabled={busy}
                    />
                    {id === "videasy" ? "Videasy" : "VidSrc"}
                  </label>
                ))}
              </div>
            </div>
          )}

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              marginBottom: 14,
              cursor: busy ? "default" : "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={skipExisting}
              onChange={(e) => setSkipExisting(e.target.checked)}
              disabled={busy}
            />
            Skip episodes already downloaded or actively downloading
          </label>

          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--text3)",
              marginBottom: 6,
              textTransform: "uppercase",
            }}
          >
            Seasons ({episodeCount} episodes selected)
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              maxHeight: 200,
              overflowY: "auto",
              marginBottom: 14,
            }}
          >
            {seasons.map((s) => (
              <label
                key={s.season_number}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  padding: "6px 8px",
                  borderRadius: 6,
                  background: "var(--surface2)",
                  cursor: busy ? "default" : "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={selectedSeasons.has(s.season_number)}
                  onChange={() => toggleSeason(s.season_number)}
                  disabled={busy}
                />
                <span style={{ flex: 1 }}>
                  {s.name || `Season ${s.season_number}`}
                </span>
                <span style={{ color: "var(--text3)" }}>
                  {s.episode_count || 0} ep
                </span>
              </label>
            ))}
          </div>

          {progress && (
            <div
              style={{
                padding: 12,
                background: "var(--surface2)",
                borderRadius: 8,
                fontSize: 12,
                marginBottom: 12,
              }}
            >
              <div style={{ marginBottom: 6 }}>{progressLine}</div>
              <div style={{ color: "var(--text3)" }}>
                {progress.staged ?? 0} started · {progress.skipped ?? 0} skipped
                {progress.errors?.length > 0 &&
                  ` · ${progress.errors.length} failed`}
                {progress.index != null && progress.total != null
                  ? ` · ${progress.index}/${progress.total}`
                  : ""}
              </div>
              {progress.errors?.length > 0 && (
                <ul
                  style={{
                    margin: "8px 0 0",
                    paddingLeft: 18,
                    color: "var(--red)",
                    fontSize: 11,
                    maxHeight: 80,
                    overflowY: "auto",
                  }}
                >
                  {progress.errors.slice(-5).map((err, idx) => (
                    <li key={`${err.label}-${idx}`}>
                      {err.label}: {err.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {error && (
            <div style={{ color: "var(--red)", fontSize: 12, marginBottom: 10 }}>
              {error}
            </div>
          )}
        </div>

        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          {busy ? (
            <button className="btn btn-ghost" onClick={handleCancel}>
              Cancel
            </button>
          ) : (
            <button className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
          )}
          <button
            className="btn btn-primary"
            disabled={
              busy ||
              checking ||
              !downloader?.token ||
              !downloadPath ||
              episodeCount === 0 ||
              !runSeriesDownload ||
              (!isAnime && sources.length === 0)
            }
            onClick={handleStart}
          >
            {checking
              ? "Checking downloader…"
              : busy
                ? "Working…"
                : `Download ${episodeCount} episodes`}
          </button>
        </div>
      </div>
    </div>
  );
}
