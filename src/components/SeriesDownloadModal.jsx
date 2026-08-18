import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { CloseIcon, DownloadIcon, ChevronRightIcon } from "./Icons";
import { storage, STORAGE_KEYS } from "../utils/storage";
import { imgUrl } from "../utils/api";

const DEFAULT_SOURCES = ["videasy", "vidsrc"];
const SOURCE_ORDER = ["videasy", "vidsrc", "vidking", "2embed"];

function sortSeriesSources(list) {
  return [...list].sort(
    (a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b),
  );
}

function epKey(ep) {
  const s = ep.uiSeason ?? ep.season;
  const e = ep.uiEpisode ?? ep.episode;
  return `${s}:${e}`;
}

function dlLookupKey(uiSeason, uiEpisode) {
  return `s${uiSeason}e${uiEpisode}`;
}

function episodeStatusTag(download) {
  if (!download) return null;
  switch (download.status) {
    case "completed":
    case "local":
      return { label: "In library", variant: "library" };
    case "downloading":
      return { label: "Downloading", variant: "downloading" };
    case "queued":
    case "resolving":
      return { label: "Queued", variant: "queued" };
    default:
      return null;
  }
}

function SeriesDownloadEpisodeRow({
  ep,
  uiSeason,
  uiEpisode,
  selected,
  busy,
  posterPath,
  meta,
  download,
  onToggle,
}) {
  const tag = episodeStatusTag(download);
  const title =
    meta?.name || `Episode ${uiEpisode}`;
  const thumb = meta?.still_path
    ? imgUrl(meta.still_path, "w300")
    : posterPath
      ? imgUrl(posterPath, "w300")
      : null;

  return (
    <label
      className={`series-download-modal__ep-row ${selected ? "series-download-modal__ep-row--selected" : ""}`}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        disabled={busy}
      />
      <div className="series-download-modal__ep-thumb">
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" />
        ) : (
          <div className="series-download-modal__ep-thumb-fallback">
            E{uiEpisode}
          </div>
        )}
      </div>
      <div className="series-download-modal__ep-body">
        <div className="series-download-modal__ep-num">
          S{String(uiSeason).padStart(2, "0")} · E{uiEpisode}
        </div>
        <div className="series-download-modal__ep-name">{title}</div>
        {tag && (
          <div className="series-download-modal__ep-tags">
            <span
              className={`series-download-modal__tag series-download-modal__tag--${tag.variant}`}
            >
              {tag.label}
            </span>
          </div>
        )}
      </div>
    </label>
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
  downloadsByEpisodeKey,
  loadSeasonEpisodes,
  downloaderFolder,
  onComplete,
  onDownloadStarted,
  runSeriesDownload,
}) {
  const [downloadPath, setDownloadPath] = useState(
    () => storage.get("downloadPath") || "",
  );
  const [downloader, setDownloader] = useState(null);
  const [checking, setChecking] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const [expandedSeasons, setExpandedSeasons] = useState(() => new Set());
  const [seasonMetaCache, setSeasonMetaCache] = useState({});
  const [loadingSeasons, setLoadingSeasons] = useState(() => new Set());
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

  const episodesBySeason = useMemo(() => {
    const map = new Map();
    for (const ep of allEpisodes) {
      const s = ep.uiSeason ?? ep.season;
      if (!map.has(s)) map.set(s, []);
      map.get(s).push(ep);
    }
    for (const [, list] of map) {
      list.sort(
        (a, b) => (a.uiEpisode ?? a.episode) - (b.uiEpisode ?? b.episode),
      );
    }
    return map;
  }, [allEpisodes]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setProgress(null);
    setSeasonMetaCache({});
    setLoadingSeasons(new Set());
    const keys = new Set(allEpisodes.map(epKey));
    setSelectedKeys(keys);
    const first = seasons[0]?.season_number;
    setExpandedSeasons(first != null ? new Set([first]) : new Set());
  }, [open, allEpisodes, seasons]);

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

  useEffect(() => {
    if (!open || !loadSeasonEpisodes) return;

    for (const uiSeason of expandedSeasons) {
      if (seasonMetaCache[uiSeason] !== undefined) continue;
      if (loadingSeasons.has(uiSeason)) continue;

      setLoadingSeasons((prev) => new Set(prev).add(uiSeason));
      loadSeasonEpisodes(uiSeason)
        .then((details) => {
          const byUi = {};
          for (const row of details || []) {
            const n = row.uiEpisode ?? row.episode_number;
            if (n != null) byUi[n] = row;
          }
          setSeasonMetaCache((prev) => ({ ...prev, [uiSeason]: byUi }));
        })
        .catch(() => {
          setSeasonMetaCache((prev) => ({ ...prev, [uiSeason]: {} }));
        })
        .finally(() => {
          setLoadingSeasons((prev) => {
            const next = new Set(prev);
            next.delete(uiSeason);
            return next;
          });
        });
    }
  }, [
    open,
    expandedSeasons,
    loadSeasonEpisodes,
    seasonMetaCache,
    loadingSeasons,
  ]);

  const episodes = useMemo(
    () => allEpisodes.filter((ep) => selectedKeys.has(epKey(ep))),
    [allEpisodes, selectedKeys],
  );

  const episodeCount = episodes.length;

  const toggleSeasonExpanded = (num) => {
    setExpandedSeasons((prev) => {
      const next = new Set(prev);
      if (next.has(num)) next.delete(num);
      else next.add(num);
      return next;
    });
  };

  const seasonEpisodeKeys = (uiSeason) => {
    const list = episodesBySeason.get(uiSeason) || [];
    return list.map(epKey);
  };

  const seasonSelectionState = (uiSeason) => {
    const keys = seasonEpisodeKeys(uiSeason);
    if (!keys.length) return "none";
    const selected = keys.filter((k) => selectedKeys.has(k)).length;
    if (selected === 0) return "none";
    if (selected === keys.length) return "all";
    return "partial";
  };

  const toggleSeason = (uiSeason) => {
    const keys = seasonEpisodeKeys(uiSeason);
    const state = seasonSelectionState(uiSeason);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (state === "all") keys.forEach((k) => next.delete(k));
      else keys.forEach((k) => next.add(k));
      return next;
    });
  };

  const toggleEpisode = (key) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedKeys(new Set(allEpisodes.map(epKey)));
  };

  const selectNone = () => {
    setSelectedKeys(new Set());
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
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="download-modal series-download-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="download-modal-header">
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <DownloadIcon /> Download series
          </span>
          <button
            className="icon-btn"
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="series-download-modal__body">
          <p className="series-download-modal__show-title">
            {showTitle}
            {year ? ` (${year})` : ""}
          </p>
          <p className="series-download-modal__hint">
            Plays each episode in the embed player below and queues a download
            when the stream is ready — same as doing it manually.
          </p>

          {busy && (
            <div className="series-download-modal__alert series-download-modal__alert--warn">
              The video player on this page is running each episode in the
              background (you may see it load behind this dialog). Do not close
              the show page until finished.
            </div>
          )}

          {!downloadPath && (
            <div className="series-download-modal__alert series-download-modal__alert--error">
              Set a download folder in Settings or the single-episode download
              dialog first.
            </div>
          )}

          <div className="series-download-modal__settings">
            {!isAnime && (
              <div className="series-download-modal__settings-row">
                <span className="series-download-modal__section-label">
                  Sources
                </span>
                <div className="series-download-modal__sources">
                  {["videasy", "vidsrc"].map((id) => (
                    <label key={id} className="series-download-modal__chip">
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
            <label className="series-download-modal__option">
              <input
                type="checkbox"
                checked={skipExisting}
                onChange={(e) => setSkipExisting(e.target.checked)}
                disabled={busy}
              />
              <span>
                Skip episodes already downloaded or actively downloading
              </span>
            </label>
          </div>

          <div className="series-download-modal__ep-toolbar">
            <p className="series-download-modal__section-label" style={{ margin: 0 }}>
              Episodes ({episodeCount} selected)
            </p>
            <div className="series-download-modal__ep-toolbar-actions">
              <button
                type="button"
                className="series-download-modal__link-btn"
                disabled={busy || episodeCount === allEpisodes.length}
                onClick={selectAll}
              >
                Select all
              </button>
              <span className="series-download-modal__toolbar-dot">·</span>
              <button
                type="button"
                className="series-download-modal__link-btn"
                disabled={busy || episodeCount === 0}
                onClick={selectNone}
              >
                Clear
              </button>
            </div>
          </div>

          <div className="series-download-modal__seasons">
            {seasons.map((s) => {
              const uiSeason = s.season_number;
              const eps = episodesBySeason.get(uiSeason) || [];
              const expanded = expandedSeasons.has(uiSeason);
              const selState = seasonSelectionState(uiSeason);
              const selectedInSeason = eps.filter((ep) =>
                selectedKeys.has(epKey(ep)),
              ).length;
              const metaForSeason = seasonMetaCache[uiSeason];
              const loadingMeta = loadingSeasons.has(uiSeason);

              return (
                <div
                  key={uiSeason}
                  className={`series-download-modal__season ${expanded ? "series-download-modal__season--expanded" : ""}`}
                >
                  <div className="series-download-modal__season-head">
                    <input
                      type="checkbox"
                      checked={selState === "all"}
                      ref={(el) => {
                        if (el) el.indeterminate = selState === "partial";
                      }}
                      onChange={() => toggleSeason(uiSeason)}
                      onClick={(e) => e.stopPropagation()}
                      disabled={busy || !eps.length}
                      aria-label={`Select all ${s.name || `Season ${uiSeason}`}`}
                    />
                    <button
                      type="button"
                      className="series-download-modal__season-toggle"
                      onClick={() => toggleSeasonExpanded(uiSeason)}
                      disabled={busy || !eps.length}
                      aria-expanded={expanded}
                    >
                      <span
                        className={`series-download-modal__season-chevron ${expanded ? "series-download-modal__season-chevron--open" : ""}`}
                      >
                        <ChevronRightIcon size={14} />
                      </span>
                      <span className="series-download-modal__season-name">
                        {s.name || `Season ${uiSeason}`}
                      </span>
                      <span className="series-download-modal__season-meta">
                        {selectedInSeason}/{eps.length || s.episode_count || 0}{" "}
                        ep
                      </span>
                    </button>
                  </div>

                  {expanded && (
                    <div className="series-download-modal__ep-list">
                      {loadingMeta && !metaForSeason ? (
                        <div className="series-download-modal__ep-loading">
                          Loading episodes…
                        </div>
                      ) : (
                        eps.map((ep) => {
                          const uiEpisode = ep.uiEpisode ?? ep.episode;
                          const key = epKey(ep);
                          const meta = metaForSeason?.[uiEpisode];
                          const download = downloadsByEpisodeKey?.get(
                            dlLookupKey(uiSeason, uiEpisode),
                          );
                          return (
                            <SeriesDownloadEpisodeRow
                              key={key}
                              ep={ep}
                              uiSeason={uiSeason}
                              uiEpisode={uiEpisode}
                              selected={selectedKeys.has(key)}
                              busy={busy}
                              posterPath={posterPath}
                              meta={meta}
                              download={download}
                              onToggle={() => toggleEpisode(key)}
                            />
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {progress && (
            <div className="series-download-modal__progress">
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
            <div
              className="series-download-modal__alert series-download-modal__alert--error"
              style={{ marginTop: 12 }}
            >
              {error}
            </div>
          )}
        </div>

        <div className="series-download-modal__footer">
          {busy ? (
            <button type="button" className="btn btn-ghost" onClick={handleCancel}>
              Cancel
            </button>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
          )}
          <button
            type="button"
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
                : `Download ${episodeCount} episode${episodeCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
