import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react";
import {
  PlayIcon,
  FolderIcon,
  FilmIcon,
  CastIcon,
  SubtitlesIcon,
  BackIcon,
  PopOutIcon,
  TrashIcon,
  WarningIcon,
} from "../components/Icons";
import LocalVideoPlayer from "../components/LocalVideoPlayer";
import CastPickerModal from "../components/CastPickerModal";
import CastMiniController from "../components/CastMiniController";
import YoutubeDeleteConfirmModal from "../components/YoutubeDeleteConfirmModal";
import YoutubeMissingOnDiskModal from "../components/YoutubeMissingOnDiskModal";
import YoutubeEmptyState from "../components/YoutubeEmptyState";
import { storage, isElectron, STORAGE_KEYS } from "../utils/storage";
import {
  getStoredYoutubePath,
  resolveLibraryPaths,
} from "../utils/libraryPaths";
import { useCast } from "../utils/useCast";
import { useMediaPlaybackSource } from "../hooks/useMediaPlaybackSource";
import {
  filterYoutubeVideos,
  sortYoutubeVideos,
  groupYoutubeByChannel,
  getYoutubeThumbnail,
  needsYoutubeMetadataSync,
  formatVideoMeta,
  getMissingOnDiskVideos,
  youtubeProgressKey,
} from "../utils/youtubeLibrary";
import {
  useYoutubeCardMetadataSync,
  YoutubeCardSyncButton,
  YoutubeCardSyncOverlay,
} from "../components/YoutubeCardMetadataSync";
import {
  useYoutubeCardCatalogEdit,
  YoutubeCardEditButton,
  YoutubeCardEditOverlay,
} from "../components/YoutubeCardCatalogEdit";
import { isYoutubeMetadataTestModeEnabled } from "../utils/youtubeAdminTest";

const SORT_OPTIONS = [
  { value: "date", label: "Date" },
  { value: "name", label: "Title" },
  { value: "channel", label: "Channel" },
  { value: "size", label: "Size" },
];

const VIEW_MODES = [
  { value: "channels", label: "By Channel" },
  { value: "flat", label: "All Videos" },
];

function buildYoutubeLocalDownload(video) {
  if (!video?.filePath) return null;
  return {
    id: video.id,
    status: "completed",
    filePath: video.filePath,
    name: video.title,
    subtitlePaths: video.transcriptPath
      ? [{ path: video.transcriptPath, lang: "en" }]
      : [],
  };
}

function YouTubeWatchView({
  video,
  playing,
  onPlay,
  onBack,
  cast,
  castVideo,
  setCastVideo,
}) {
  const progressKey = youtubeProgressKey(video.id);
  const thumb = getYoutubeThumbnail(video);
  const playerWrapRef = useRef(null);
  const [pipOpen, setPipOpen] = useState(false);
  const pipUrlRef = useRef(null);

  const localDownloadOverride = useMemo(
    () => buildYoutubeLocalDownload(video),
    [video],
  );

  const mediaPlayback = useMediaPlaybackSource({
    playing,
    progressKey,
    mediaType: "movie",
    tmdbId: 0,
    downloads: [],
    localDownloadOverride,
    streamAvailable: false,
  });

  const castLoadArgs = useMemo(() => {
    const subs = (mediaPlayback.localDownload?.subtitlePaths || [])
      .filter((sp) => sp?.path)
      .map((sp) => ({ path: sp.path, lang: sp.lang || "und" }));
    return {
      mode: "localFile",
      filePath: mediaPlayback.localPath || video.filePath,
      title: video.title || "YouTube",
      posterUrl: thumb,
      startTime: storage.get("dlTime_" + progressKey) || 0,
      localVttSubs: subs,
    };
  }, [
    mediaPlayback.localPath,
    mediaPlayback.localDownload,
    video.filePath,
    video.title,
    thumb,
    progressKey,
  ]);

  const handleLocalProgress = useCallback(
    ({ currentTime, duration }) => {
      if (!duration || duration <= 0) return;
      storage.set("dlTime_" + progressKey, Math.floor(currentTime));
    },
    [progressKey],
  );

  const openExternalWatch = useCallback(async () => {
    if (!video?.filePath) return;
    const subs = video.transcriptPath
      ? [{ path: video.transcriptPath, lang: "en" }]
      : [];
    const startTime = storage.get("dlTime_" + progressKey) || 0;
    if (startTime > 0 && window.electron?.openPathAtTime) {
      await window.electron.openPathAtTime(video.filePath, startTime, subs);
    } else if (subs.length > 0) {
      await window.electron.openPathAtTime(video.filePath, 0, subs);
    } else {
      await window.electron.openPath(video.filePath);
    }
  }, [video?.filePath, video?.transcriptPath, progressKey]);

  const playbackBlocked =
    Boolean(mediaPlayback.localLoadError) ||
    (mediaPlayback.localFailed && !mediaPlayback.localPlayerUrl);

  useEffect(() => {
    if (!playing) return;
    const openH = window.electron?.onPipOpened?.(() => setPipOpen(true));
    const closeH = window.electron?.onPipClosed?.(() => {
      pipUrlRef.current = null;
      setPipOpen(false);
    });
    return () => {
      if (openH) window.electron?.offPipOpened?.(openH);
      if (closeH) window.electron?.offPipClosed?.(closeH);
    };
  }, [playing]);

  useEffect(() => {
    return () => {
      window.electron?.playerStopped?.();
    };
  }, []);

  return (
    <div className="fade-in yt-watch">
      <div className="yt-watch-topbar">
        <button
          type="button"
          className="btn btn-ghost yt-watch-back"
          onClick={onBack}
        >
          <BackIcon /> Back to library
        </button>
      </div>

      <div className="detail-hero">
        <div
          className="detail-bg"
          style={
            thumb
              ? { backgroundImage: `url(${thumb})` }
              : { background: "var(--surface2)" }
          }
        />
        <div className="detail-gradient" />
        <div className="detail-content">
          <div className="detail-poster">
            {thumb ? (
              <img src={thumb} alt="" loading="lazy" />
            ) : (
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text3)",
                }}
              >
                <FilmIcon />
              </div>
            )}
          </div>
          <div className="detail-info">
            <div className="detail-type">YouTube</div>
            <div className="detail-title">{video.title}</div>
            {video.channelName && (
              <div className="genres">
                <span className="genre-tag">{video.channelName}</span>
                {video.youtubeChannelName &&
                  video.youtubeChannelName !== video.channelName && (
                    <span
                      className="genre-tag genre-tag--muted"
                      title="YouTube channel"
                    >
                      {video.youtubeChannelName}
                    </span>
                  )}
              </div>
            )}
            <div className="detail-meta">
              <span>{formatVideoMeta(video)}</span>
              {video.transcriptPath && (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <SubtitlesIcon size={13} /> Transcript
                </span>
              )}
            </div>
            <div className="detail-actions">
              <button className="btn btn-primary" onClick={onPlay}>
                <PlayIcon /> {playing ? "Restart" : "Play"}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => window.electron?.showInFolder?.(video.filePath)}
              >
                <FolderIcon /> Show in folder
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setCastVideo(video)}
              >
                <CastIcon /> Cast
              </button>
              {video.watchUrl && (
                <button
                  className="btn btn-ghost"
                  onClick={() => window.electron.openExternal(video.watchUrl)}
                >
                  Open on YouTube
                </button>
              )}
              <button className="btn btn-ghost" onClick={onBack}>
                <BackIcon /> Back
              </button>
            </div>
          </div>
        </div>
      </div>

      {playing && (
        <div className="section">
          <div className="player-wrap" ref={playerWrapRef}>
            {mediaPlayback.isCheckingLocal && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  zIndex: 10,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "rgba(0,0,0,0.92)",
                  gap: 14,
                  borderRadius: "inherit",
                }}
              >
                <div className="spinner" />
                <span style={{ fontSize: 14, color: "var(--text2)" }}>
                  {mediaPlayback.isCheckingLocal
                    ? "Opening local playback…"
                    : "Loading local file…"}
                </span>
              </div>
            )}

            {playbackBlocked && !mediaPlayback.isCheckingLocal && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  zIndex: 11,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "rgba(0,0,0,0.92)",
                  gap: 14,
                  padding: 20,
                  borderRadius: "inherit",
                }}
              >
                <span style={{ fontSize: 14, color: "var(--text2)" }}>
                  {mediaPlayback.localLoadError ||
                    "This file could not be played in StreamStein."}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--text3)",
                    maxWidth: 340,
                    textAlign: "center",
                    lineHeight: 1.45,
                  }}
                >
                  Some codecs (VP9, AV1, odd audio) need a one-time remux. If that
                  failed, open the file in your system video player instead.
                </span>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void openExternalWatch()}
                >
                  Open in system player
                </button>
              </div>
            )}

            {pipOpen && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  zIndex: 20,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "rgba(0,0,0,0.92)",
                  gap: 16,
                  borderRadius: "inherit",
                }}
              >
                <PopOutIcon size={36} />
                <span
                  style={{
                    fontSize: 15,
                    color: "var(--text1)",
                    fontWeight: 600,
                  }}
                >
                  Playing in pop-out window
                </span>
                <button
                  className="player-overlay-btn"
                  onClick={() => window.electron?.closePipWindow?.()}
                >
                  Close pop-out &amp; return
                </button>
              </div>
            )}

            {cast.currentDevice && !pipOpen && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  zIndex: 20,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "rgba(0,0,0,0.92)",
                  gap: 18,
                  padding: 20,
                  borderRadius: "inherit",
                }}
              >
                <span
                  style={{ fontSize: 15, color: "var(--text1)", fontWeight: 600 }}
                >
                  Playing on{" "}
                  {cast.currentDevice.friendlyName || cast.currentDevice.name}
                </span>
                <div style={{ width: 480, maxWidth: "90%" }}>
                  <CastMiniController cast={cast} variant="modal" />
                </div>
              </div>
            )}

            {mediaPlayback.isLocalMode &&
              !pipOpen &&
              !cast.currentDevice &&
              mediaPlayback.localPath && (
                <LocalVideoPlayer
                  filePath={mediaPlayback.localPath}
                  sourceUrl={mediaPlayback.localPlayerUrl}
                  prepareMode={mediaPlayback.localPrepareMode}
                  startTime={storage.get("dlTime_" + progressKey) || 0}
                  poster={thumb || undefined}
                  subtitlePaths={
                    mediaPlayback.localDownload?.subtitlePaths || []
                  }
                  onProgress={handleLocalProgress}
                  onError={(err) => {
                    mediaPlayback.setLocalLoadError?.(
                      err?.message || "Playback failed",
                    );
                  }}
                  onReady={() => window.electron?.setPlaybackKeepAwake?.(true)}
                />
              )}

            <div className="player-overlay-group">
              <button
                type="button"
                className="player-overlay-btn"
                onClick={() => setCastVideo(video)}
                title="Cast to a device"
              >
                <CastIcon />
              </button>
              <button
                type="button"
                className="player-overlay-btn"
                onClick={() => {
                  if (pipOpen) {
                    window.electron?.closePipWindow?.();
                    return;
                  }
                  const url = mediaPlayback.localPlayerUrl;
                  if (!url) return;
                  pipUrlRef.current = url;
                  window.electron?.openPipWindow?.(url, video.title);
                }}
                title={pipOpen ? "Close pop-out" : "Pop out player"}
                disabled={!pipOpen && !mediaPlayback.localPlayerUrl}
                style={pipOpen ? { color: "var(--red)" } : undefined}
              >
                <PopOutIcon />
              </button>
              <button
                type="button"
                className="player-overlay-btn"
                onClick={() =>
                  window.electron?.showInFolder?.(video.filePath)
                }
                title="Show in folder"
              >
                <FolderIcon />
              </button>
            </div>
          </div>
        </div>
      )}

      {castVideo && (
        <CastPickerModal
          open={!!castVideo}
          cast={cast}
          loadArgs={castLoadArgs}
          onClose={() => setCastVideo(null)}
        />
      )}
    </div>
  );
}

export default function YouTubePage({
  onSettings,
  searchOpen: searchOpenProp = false,
  onSearchClose,
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [catalogMeta, setCatalogMeta] = useState(null);
  const [scanNotice, setScanNotice] = useState(null);
  const [metadataTestMode, setMetadataTestMode] = useState(
    isYoutubeMetadataTestModeEnabled,
  );
  const [videos, setVideos] = useState([]);
  const [sortBy, setSortBy] = useState(
    () => storage.get(STORAGE_KEYS.YOUTUBE_SORT_BY) ?? "date",
  );
  const [sortDir, setSortDir] = useState(
    () => storage.get(STORAGE_KEYS.YOUTUBE_SORT_DIR) ?? "desc",
  );
  const [viewMode, setViewMode] = useState(
    () => storage.get(STORAGE_KEYS.YOUTUBE_VIEW_MODE) ?? "channels",
  );
  const [searchOpen, setSearchOpen] = useState(
    () => !!storage.get(STORAGE_KEYS.YOUTUBE_SEARCH_OPEN),
  );
  const [searchQuery, setSearchQuery] = useState(
    () => storage.get(STORAGE_KEYS.YOUTUBE_SEARCH_QUERY) ?? "",
  );
  const searchInputRef = useRef(null);
  const libraryScrollRef = useRef(0);
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [playing, setPlaying] = useState(false);
  const cast = useCast();
  const [castVideo, setCastVideo] = useState(null);
  const [pendingDeleteVideo, setPendingDeleteVideo] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [deleteSkipConfirm, setDeleteSkipConfirm] = useState(false);
  const [missingModalOpen, setMissingModalOpen] = useState(false);

  useEffect(() => {
    storage.set(STORAGE_KEYS.YOUTUBE_SORT_BY, sortBy);
  }, [sortBy]);
  useEffect(() => {
    storage.set(STORAGE_KEYS.YOUTUBE_SORT_DIR, sortDir);
  }, [sortDir]);
  useEffect(() => {
    storage.set(STORAGE_KEYS.YOUTUBE_VIEW_MODE, viewMode);
  }, [viewMode]);
  useEffect(() => {
    storage.set(STORAGE_KEYS.YOUTUBE_SEARCH_QUERY, searchQuery);
  }, [searchQuery]);
  useEffect(() => {
    storage.set(STORAGE_KEYS.YOUTUBE_SEARCH_OPEN, searchOpen ? 1 : 0);
  }, [searchOpen]);

  // Sync externally-triggered open (Ctrl+K from App.jsx)
  useEffect(() => {
    if (searchOpenProp) {
      setSearchOpen(true);
      onSearchClose?.();
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [searchOpenProp, onSearchClose]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, []);

  /** Merge one catalog video into the grid without reloading the page (preserves scroll). */
  const upsertVideoInList = useCallback((video) => {
    if (!video?.id) return false;
    let added = false;
    setVideos((prev) => {
      const idx = prev.findIndex((v) => v.id === video.id);
      if (idx < 0) {
        added = true;
        return [...prev, video];
      }
      const next = [...prev];
      next[idx] = { ...next[idx], ...video };
      return next;
    });
    if (added) {
      setCatalogMeta((prev) =>
        prev
          ? { ...prev, totalVideos: (prev.totalVideos || 0) + 1 }
          : prev,
      );
    }
    return true;
  }, []);

  const captureLibraryScroll = useCallback(() => {
    libraryScrollRef.current =
      document.querySelector(".main")?.scrollTop ?? 0;
  }, []);

  const restoreLibraryScroll = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const main = document.querySelector(".main");
        if (main) main.scrollTop = libraryScrollRef.current;
      });
    });
  }, []);

  const resolveYoutubeFolder = useCallback(async () => {
    const paths = await resolveLibraryPaths();
    return paths.youtube || getStoredYoutubePath() || "";
  }, []);

  const formatSyncNotice = useCallback((sync) => {
    if (!sync?.ok) return null;
    const parts = [];
    if (sync.videosAdded > 0) {
      parts.push(
        `${sync.videosAdded} video${sync.videosAdded !== 1 ? "s" : ""} added`,
      );
    }
    if (sync.pathsRepaired > 0) {
      parts.push(
        `${sync.pathsRepaired} path${sync.pathsRepaired !== 1 ? "s" : ""} repaired`,
      );
    }
    if (sync.restoredFromBridge > 0) {
      parts.push(
        `${sync.restoredFromBridge} restored from extension catalog`,
      );
    }
    if (sync.ghostsRemoved > 0) {
      parts.push(
        `${sync.ghostsRemoved} stale catalog ${sync.ghostsRemoved !== 1 ? "entries" : "entry"} removed`,
      );
    }
    if (!parts.length) {
      if (sync.videosOnDisk > 0 && sync.catalogVideos >= sync.videosOnDisk) {
        return `Library in sync with ${sync.videosOnDisk} video${sync.videosOnDisk !== 1 ? "s" : ""} on disk.`;
      }
      return null;
    }
    return `Library updated: ${parts.join(", ")}.`;
  }, []);

  const loadCatalog = useCallback(async ({ scanDisk = true, background = false } = {}) => {
    if (!isElectron || !window.electron?.loadYoutubeCatalog) {
      setError("YouTube library requires the Streamstein desktop app.");
      setLoading(false);
      return;
    }
    if (!background) {
      setLoading(true);
      setError(null);
    }
    if (!scanDisk) setScanNotice(null);
    try {
      const folder = await resolveYoutubeFolder();
      const res = await window.electron.loadYoutubeCatalog({
        youtubeFolder: folder,
        skipSync: !scanDisk,
      });
      if (!res?.ok) {
        setError(res?.error || "Could not load YouTube catalog.");
        setVideos([]);
        return;
      }
      setCatalogMeta({
        folder: res.folder,
        catalogPath: res.catalogPath,
        catalogExists: res.catalogExists,
        updatedAt: res.updatedAt,
        totalVideos: res.totalVideos,
        missingFiles: res.missingFiles,
      });
      setVideos(res.videos || []);
      if (scanDisk && res.sync) {
        setScanNotice(formatSyncNotice(res.sync));
      }
    } catch (err) {
      setError(err?.message || "Failed to load YouTube library.");
      setVideos([]);
    } finally {
      if (!background) setLoading(false);
    }
  }, [formatSyncNotice, resolveYoutubeFolder]);

  /** Refresh a single card after metadata sync / clone — no full-page reload. */
  const refreshYoutubeVideoById = useCallback(
    async (recordId) => {
      if (!recordId || !window.electron?.getYoutubeCatalogVideo) return;
      try {
        const folder = await resolveYoutubeFolder();
        const res = await window.electron.getYoutubeCatalogVideo({
          youtubeFolder: folder,
          recordId,
        });
        if (res?.ok && res.video) {
          upsertVideoInList(res.video);
          return;
        }
      } catch {
        // Fall back to a quiet full reload below.
      }
      captureLibraryScroll();
      await loadCatalog({ scanDisk: false, background: true });
      restoreLibraryScroll();
    },
    [
      captureLibraryScroll,
      loadCatalog,
      resolveYoutubeFolder,
      restoreLibraryScroll,
      upsertVideoInList,
    ],
  );

  useEffect(() => {
    const onAdminTestChanged = () => {
      setMetadataTestMode(isYoutubeMetadataTestModeEnabled());
    };
    window.addEventListener(
      "streamstein-youtube-admin-test-changed",
      onAdminTestChanged,
    );
    return () => {
      window.removeEventListener(
        "streamstein-youtube-admin-test-changed",
        onAdminTestChanged,
      );
    };
  }, []);

  useEffect(() => {
    loadCatalog({ scanDisk: true });
    const onPathsChanged = () => loadCatalog();
    window.addEventListener(
      "streamstein-library-paths-changed",
      onPathsChanged,
    );

    let catalogRefreshTimer = null;
    const onCatalogUpdated = () => {
      if (catalogRefreshTimer) clearTimeout(catalogRefreshTimer);
      catalogRefreshTimer = setTimeout(() => {
        catalogRefreshTimer = null;
        captureLibraryScroll();
        loadCatalog({ scanDisk: false, background: true }).then(() => {
          restoreLibraryScroll();
        });
      }, 400);
    };

    let catalogHandler = null;
    if (isElectron && window.electron?.onYoutubeCatalogUpdated) {
      catalogHandler = onCatalogUpdated;
      window.electron.onYoutubeCatalogUpdated(catalogHandler);
    }

    return () => {
      window.removeEventListener(
        "streamstein-library-paths-changed",
        onPathsChanged,
      );
      if (catalogRefreshTimer) clearTimeout(catalogRefreshTimer);
      if (catalogHandler && window.electron?.offYoutubeCatalogUpdated) {
        window.electron.offYoutubeCatalogUpdated(catalogHandler);
      }
    };
  }, [captureLibraryScroll, loadCatalog, restoreLibraryScroll]);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape") {
        if (missingModalOpen) {
          setMissingModalOpen(false);
          return;
        }
        if (pendingDeleteVideo && !deletingId) {
          setPendingDeleteVideo(null);
          setDeleteSkipConfirm(false);
          return;
        }
        if (selectedVideo) {
          setPlaying(false);
          setSelectedVideo(null);
          window.electron?.playerStopped?.();
          restoreLibraryScroll();
        } else {
          setSearchOpen(false);
          setSearchQuery("");
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    missingModalOpen,
    selectedVideo,
    restoreLibraryScroll,
    pendingDeleteVideo,
    deletingId,
  ]);

  useEffect(() => {
    if (searchOpen) setTimeout(() => searchInputRef.current?.focus(), 50);
  }, [searchOpen]);

  const filtered = useMemo(
    () => filterYoutubeVideos(videos, searchQuery),
    [videos, searchQuery],
  );
  const sorted = useMemo(
    () => sortYoutubeVideos(filtered, sortBy, sortDir),
    [filtered, sortBy, sortDir],
  );
  const channelGroups = useMemo(
    () => groupYoutubeByChannel(sorted),
    [sorted],
  );
  const missingOnDiskVideos = useMemo(
    () => getMissingOnDiskVideos(videos),
    [videos],
  );

  const castLoadArgs = useMemo(() => {
    if (!castVideo?.filePath) return null;
    const subs = castVideo.transcriptPath
      ? [{ path: castVideo.transcriptPath, lang: "en" }]
      : [];
    return {
      mode: "localFile",
      filePath: castVideo.filePath,
      title: castVideo.title || "YouTube",
      posterUrl: getYoutubeThumbnail(castVideo),
      localVttSubs: subs,
    };
  }, [castVideo]);

  const openExternalWatch = useCallback(async (video) => {
    if (!video?.filePath || !video.fileExists) return;
    const subs = video.transcriptPath
      ? [{ path: video.transcriptPath, lang: "en" }]
      : [];
    const startTime =
      storage.get("dlTime_" + youtubeProgressKey(video.id)) || 0;
    if (startTime > 0 && window.electron.openPathAtTime) {
      await window.electron.openPathAtTime(video.filePath, startTime, subs);
    } else if (subs.length > 0) {
      await window.electron.openPathAtTime(video.filePath, 0, subs);
    } else {
      await window.electron.openPath(video.filePath);
    }
  }, []);

  const openVideo = useCallback(
    (video) => {
      if (!video?.fileExists) return;
      if (!video.canPlayInApp) {
        openExternalWatch(video);
        return;
      }
      libraryScrollRef.current =
        document.querySelector(".main")?.scrollTop ?? 0;
      setSelectedVideo(video);
      setPlaying(true);
    },
    [openExternalWatch],
  );

  const closeWatch = useCallback(() => {
    setPlaying(false);
    setSelectedVideo(null);
    window.electron?.playerStopped?.();
    restoreLibraryScroll();
  }, [restoreLibraryScroll]);

  const performRemoveFromCatalog = useCallback(
    async (video) => {
      if (!video?.id || !window.electron?.removeYoutubeCatalogEntry) return;
      setDeletingId(video.id);
      try {
        const folder =
          getStoredYoutubePath() || catalogMeta?.folder || "";
        const res = await window.electron.removeYoutubeCatalogEntry({
          youtubeFolder: folder,
          recordId: video.id,
          extraFilePaths: [video.filePath, video.transcriptPath].filter(Boolean),
        });
        if (!res?.ok) {
          setError(res?.error || "Could not delete video.");
          return;
        }
        setVideos((prev) => prev.filter((v) => v.id !== video.id));
        setCatalogMeta((prev) =>
          prev
            ? {
                ...prev,
                totalVideos: Math.max(0, (prev.totalVideos || 1) - 1),
              }
            : prev,
        );
        storage.remove("dlTime_" + youtubeProgressKey(video.id));
        if (selectedVideo?.id === video.id) {
          closeWatch();
        }
        if (res.warning) {
          setError(res.warning);
        } else {
          setError(null);
        }
      } catch (err) {
        setError(err?.message || "Failed to delete video.");
      } finally {
        setDeletingId(null);
        setPendingDeleteVideo(null);
        setDeleteSkipConfirm(false);
      }
    },
    [catalogMeta?.folder, closeWatch, selectedVideo?.id],
  );

  const handleDeleteRequest = useCallback(
    (video) => {
      if (!video?.id || deletingId) return;
      const skip =
        !!storage.get(STORAGE_KEYS.YOUTUBE_DELETE_SKIP_CONFIRM);
      if (skip) {
        performRemoveFromCatalog(video);
        return;
      }
      setDeleteSkipConfirm(false);
      setPendingDeleteVideo(video);
    },
    [deletingId, performRemoveFromCatalog],
  );

  const handleDeleteConfirm = useCallback(() => {
    if (!pendingDeleteVideo) return;
    if (deleteSkipConfirm) {
      storage.set(STORAGE_KEYS.YOUTUBE_DELETE_SKIP_CONFIRM, 1);
    }
    performRemoveFromCatalog(pendingDeleteVideo);
  }, [deleteSkipConfirm, pendingDeleteVideo, performRemoveFromCatalog]);

  if (selectedVideo) {
    return (
      <YouTubeWatchView
        key={selectedVideo.id}
        video={selectedVideo}
        playing={playing}
        onPlay={() => setPlaying(true)}
        onBack={closeWatch}
        cast={cast}
        castVideo={castVideo}
        setCastVideo={setCastVideo}
      />
    );
  }

  const q = searchQuery.trim().toLowerCase();
  const showLibrarySetup =
    !loading &&
    !error &&
    (!catalogMeta?.catalogExists ||
      (catalogMeta?.catalogExists && sorted.length === 0 && !q));

  return (
    <div className="dl-page fade-in yt-page">
      <CastPickerModal
        open={!!castVideo}
        cast={cast}
        loadArgs={castLoadArgs}
        onClose={() => setCastVideo(null)}
      />
      {pendingDeleteVideo && (
        <YoutubeDeleteConfirmModal
          videoTitle={pendingDeleteVideo.title}
          hasTranscript={!!pendingDeleteVideo.transcriptPath}
          metadataTestClone={!!pendingDeleteVideo.metadataTestClone}
          onConfirm={handleDeleteConfirm}
          onCancel={() => {
            if (deletingId) return;
            setPendingDeleteVideo(null);
            setDeleteSkipConfirm(false);
          }}
          skipConfirm={deleteSkipConfirm}
          onSkipConfirmChange={setDeleteSkipConfirm}
          busy={!!deletingId}
        />
      )}
      {cast.currentDevice && (
        <CastMiniController cast={cast} variant="global" />
      )}

      <div className="dl-page__title-row">
        <h1 className="dl-page__title">YOUTUBE</h1>
        {showLibrarySetup && !loading && (
          <span
            className="yt-page__title-alert"
            title="No YouTube library content"
            aria-hidden
          >
            <WarningIcon size={22} />
          </span>
        )}
      </div>
      <div className="dl-page__subtitle">
        {loading ? (
          "Loading library…"
        ) : showLibrarySetup ? (
          "No videos in your library yet"
        ) : catalogMeta?.catalogExists ? (
          <>
            {catalogMeta.totalVideos} video
            {catalogMeta.totalVideos !== 1 ? "s" : ""}
            {catalogMeta.missingFiles > 0 && (
              <button
                type="button"
                className="yt-page__missing-link"
                onClick={() => setMissingModalOpen(true)}
                title="View catalog entries whose files are missing from disk"
              >
                {" · "}
                {catalogMeta.missingFiles} missing on disk
              </button>
            )}
            {catalogMeta.updatedAt
              ? ` · Updated ${new Date(catalogMeta.updatedAt).toLocaleString()}`
              : ""}
          </>
        ) : (
          "Library unavailable"
        )}
      </div>
      {missingModalOpen && (
        <YoutubeMissingOnDiskModal
          videos={missingOnDiskVideos}
          onClose={() => setMissingModalOpen(false)}
        />
      )}
      {scanNotice && !loading && (
        <p className="dl-page__subtitle yt-page__scan-notice" role="status">
          {scanNotice}
        </p>
      )}

      {!showLibrarySetup && (
      <div className="yt-page__sticky-bar">
        {searchOpen && (
          <div className="dl-search-bar yt-page__search-bar">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--text3)"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              ref={searchInputRef}
              className="dl-search-bar__input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter YouTube library…"
            />
            {q && (
              <span className="dl-search-bar__count">
                {sorted.length} result{sorted.length !== 1 ? "s" : ""}
              </span>
            )}
            <button
              type="button"
              className="dl-search-bar__close"
              onClick={() => {
                setSearchOpen(false);
                setSearchQuery("");
              }}
              aria-label="Close search"
            >
              ✕
            </button>
          </div>
        )}

        <div className="dl-toolbar yt-page__toolbar">
          <div className="dl-toolbar__group">
            <span className="dl-toolbar__label">Sort by</span>
            <div className="dl-toolbar__sort-btns">
              {SORT_OPTIONS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className={`dl-toolbar__sort-btn${sortBy === value ? " dl-toolbar__sort-btn--active" : ""}`}
                  onClick={() => setSortBy(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="dl-toolbar__dir-btn"
              onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
              title={sortDir === "desc" ? "Descending" : "Ascending"}
            >
              {sortDir === "desc" ? "↓" : "↑"}
            </button>
          </div>

          <div className="dl-toolbar__group">
            <div className="dl-toolbar__sort-btns">
              {VIEW_MODES.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className={`dl-toolbar__sort-btn${viewMode === value ? " dl-toolbar__sort-btn--active" : ""}`}
                  onClick={() => setViewMode(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-secondary btn--sm"
              onClick={() => loadCatalog({ scanDisk: true })}
              disabled={loading}
              title="Scan your library folder for videos, then reload the catalog"
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            {!searchOpen && (
              <button
                type="button"
                className="dl-toolbar__search-hint"
                onClick={openSearch}
                title="Search (Ctrl+K)"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <span className="dl-toolbar__search-hint-key">Ctrl+K</span>
              </button>
            )}
          </div>
        </div>
      </div>
      )}

      {error && (
        <div className="yt-page__alert yt-page__alert--error">{error}</div>
      )}

      {showLibrarySetup && (
        <YoutubeEmptyState
          variant={
            catalogMeta?.catalogExists ? "empty-catalog" : "no-catalog"
          }
          onOpenSettings={onSettings}
          onRefresh={loadCatalog}
          refreshing={loading}
        />
      )}

      {!loading && catalogMeta?.catalogExists && sorted.length === 0 && q && (
        <div className="dl-page__empty-text">
          {`No videos match "${searchQuery}".`}
        </div>
      )}

      {!loading && sorted.length > 0 && viewMode === "flat" && (
        <div className="yt-grid">
          {sorted.map((video) => (
            <YouTubeVideoCard
              key={video.id}
              video={video}
              youtubeFolder={catalogMeta?.folder}
              metadataTestMode={metadataTestMode}
              onWatch={() => openVideo(video)}
              onShowFolder={() =>
                window.electron?.showInFolder(video.filePath)
              }
              onCast={() => setCastVideo(video)}
              onDelete={() => handleDeleteRequest(video)}
              onSettings={onSettings}
              onMetadataSyncClosed={refreshYoutubeVideoById}
              onEditClosed={refreshYoutubeVideoById}
              onLibraryRefresh={refreshYoutubeVideoById}
              deleting={deletingId === video.id}
            />
          ))}
        </div>
      )}

      {!loading &&
        sorted.length > 0 &&
        viewMode === "channels" &&
        channelGroups.map(({ channelName, items }) => (
          <div key={channelName} className="dl-page__section">
            <div className="settings-section-title dl-section-title">
              {channelName}
              <span className="yt-section-count">{items.length}</span>
            </div>
            <div className="yt-grid">
              {items.map((video) => (
                <YouTubeVideoCard
                  key={video.id}
                  video={video}
                  youtubeFolder={catalogMeta?.folder}
                  metadataTestMode={metadataTestMode}
                  onWatch={() => openVideo(video)}
                  onShowFolder={() =>
                    window.electron?.showInFolder(video.filePath)
                  }
                  onCast={() => setCastVideo(video)}
                  onDelete={() => handleDeleteRequest(video)}
                  onSettings={onSettings}
                  onMetadataSyncClosed={refreshYoutubeVideoById}
                  onEditClosed={refreshYoutubeVideoById}
                  onLibraryRefresh={refreshYoutubeVideoById}
                  deleting={deletingId === video.id}
                />
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}

const YouTubeVideoCard = memo(function YouTubeVideoCard({
  video,
  youtubeFolder,
  metadataTestMode = false,
  onWatch,
  onShowFolder,
  onCast,
  onDelete,
  onSettings,
  onMetadataSyncClosed,
  onEditClosed,
  onLibraryRefresh,
  deleting = false,
}) {
  const thumb = getYoutubeThumbnail(video);
  const missing = !video.fileExists;
  const isTestClone = !!video.metadataTestClone;
  const showMetadataSync = needsYoutubeMetadataSync(video);
  const catalogEdit = useYoutubeCardCatalogEdit({
    video,
    youtubeFolder,
    onEditClosed,
    disabled: deleting,
  });
  const metadataSync = useYoutubeCardMetadataSync({
    video,
    youtubeFolder,
    onMetadataSyncClosed,
    disabled: deleting || catalogEdit.showPanel,
  });
  const [cloning, setCloning] = useState(false);

  const handleCloneForMetadataTest = useCallback(async () => {
    if (
      cloning ||
      deleting ||
      missing ||
      isTestClone ||
      !metadataTestMode ||
      !window.electron?.cloneYoutubeCatalogForMetadataTest
    ) {
      return;
    }
    setCloning(true);
    try {
      const res = await window.electron.cloneYoutubeCatalogForMetadataTest({
        youtubeFolder: youtubeFolder || undefined,
        recordId: video.id,
      });
      if (!res?.ok) {
        window.alert(res?.error || "Could not create metadata test clone.");
        return;
      }
      if (res.recordId) {
        await onLibraryRefresh?.(res.recordId);
      }
    } catch (err) {
      window.alert(err?.message || "Could not create metadata test clone.");
    } finally {
      setCloning(false);
    }
  }, [
    cloning,
    deleting,
    isTestClone,
    metadataTestMode,
    missing,
    onLibraryRefresh,
    video.id,
    youtubeFolder,
  ]);

  return (
    <div
      className={`yt-card${missing ? " yt-card--missing" : ""}${showMetadataSync ? " yt-card--needs-meta" : ""}${isTestClone ? " yt-card--meta-test" : ""}${metadataSync.showPanel ? " yt-card--sync-open" : ""}${catalogEdit.showPanel ? " yt-card--edit-open" : ""}`}
    >
      <YoutubeCardEditOverlay edit={catalogEdit} />
      {showMetadataSync && (
        <YoutubeCardSyncOverlay
          sync={metadataSync}
          onSettings={onSettings}
        />
      )}
      <div
        className="yt-card__thumb"
        onClick={missing ? undefined : onWatch}
        role={missing ? undefined : "button"}
        tabIndex={missing ? undefined : 0}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !missing) onWatch();
        }}
      >
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" />
        ) : (
          <div className="yt-card__thumb-fallback">
            <FilmIcon />
          </div>
        )}
        {!missing && (
          <div className="card-overlay">
            <div className="card-play">
              <PlayIcon />
            </div>
          </div>
        )}
        {video.transcriptPath && (
          <span className="yt-card__badge" title="Transcript available">
            <SubtitlesIcon size={11} />
          </span>
        )}
        {missing && (
          <span className="yt-card__badge yt-card__badge--warn">Missing</span>
        )}
        {isTestClone && (
          <span className="yt-card__badge yt-card__badge--test" title="Metadata test clone">
            Test
          </span>
        )}
      </div>
      <div className="yt-card__body">
        <div className="yt-card__title" title={video.title}>
          {video.title}
        </div>
        <div className="yt-card__meta">{formatVideoMeta(video)}</div>
        <div className="yt-card__actions">
          <button
            type="button"
            className="btn btn-primary btn--sm"
            disabled={missing}
            onClick={onWatch}
          >
            Watch
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Show in folder"
            onClick={onShowFolder}
          >
            <FolderIcon />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Cast"
            disabled={missing}
            onClick={onCast}
          >
            <CastIcon />
          </button>
          <YoutubeCardEditButton
            edit={catalogEdit}
            blocked={metadataSync.showPanel || metadataSync.running}
          />
          <button
            type="button"
            className="icon-btn icon-btn--danger"
            title="Delete"
            disabled={deleting || catalogEdit.showPanel}
            onClick={onDelete}
          >
            <TrashIcon />
          </button>
          {showMetadataSync && (
            <YoutubeCardSyncButton
              sync={metadataSync}
              blocked={catalogEdit.showPanel}
            />
          )}
          {metadataTestMode && !isTestClone && (
            <button
              type="button"
              className="btn btn-secondary btn--sm yt-card__clone-test-btn"
              title="Create a bare catalog clone (same file) for metadata sync testing"
              disabled={missing || cloning || deleting}
              onClick={handleCloneForMetadataTest}
            >
              {cloning ? "Cloning…" : "Clone for test"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
