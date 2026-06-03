const { contextBridge, ipcRenderer, webFrame } = require("electron");

contextBridge.exposeInMainWorld("electron", {
  // m3u8 capture
  onM3u8Found: (cb) => {
    const h = (_, payload) => cb(payload);
    ipcRenderer.on("m3u8-found", h);
    return h;
  },
  offM3u8Found: (h) => ipcRenderer.removeListener("m3u8-found", h),

  // subtitle capture (.vtt / .srt), cb receives { url, lang }
  onSubtitleFound: (cb) => {
    const h = (_, data) => cb(data);
    ipcRenderer.on("subtitle-found", h);
    return h;
  },
  offSubtitleFound: (h) => ipcRenderer.removeListener("subtitle-found", h),

  // Download progress events
  onDownloadProgress: (cb) => {
    const h = (_, d) => cb(d);
    ipcRenderer.on("download-progress", h);
    return h;
  },
  offDownloadProgress: (h) =>
    ipcRenderer.removeListener("download-progress", h),

  // Download actions
  checkDownloader: (folder) => ipcRenderer.invoke("check-downloader", folder),
  runDownload: (args) => ipcRenderer.invoke("run-download", args),
  startSeriesDownload: (args) =>
    ipcRenderer.invoke("start-series-download", args),
  cancelSeriesDownload: (opts) =>
    ipcRenderer.invoke("cancel-series-download", opts || {}),
  seriesDownloadActive: () => ipcRenderer.invoke("series-download-active"),
  onSeriesDownloadProgress: (cb) => {
    const h = (_, d) => cb(d);
    ipcRenderer.on("series-download-progress", h);
    return h;
  },
  offSeriesDownloadProgress: (h) =>
    ipcRenderer.removeListener("series-download-progress", h),

  setMaxConcurrentDownloads: (max) =>
    ipcRenderer.invoke("set-max-concurrent-downloads", { max }),
  getMaxConcurrentDownloads: () =>
    ipcRenderer.invoke("get-max-concurrent-downloads"),
  getDownloads: () => ipcRenderer.invoke("get-downloads"),
  deleteDownload: (args) => ipcRenderer.invoke("delete-download", args),
  retryDownload: (args) => ipcRenderer.invoke("retry-download", args),
  showInFolder: (path) => ipcRenderer.invoke("show-in-folder", path),
  fileExists: (path) => ipcRenderer.invoke("file-exists", path),
  scanDirectory: (path) => ipcRenderer.invoke("scan-directory", path),
  getSetupFolderStats: (args) =>
    ipcRenderer.invoke("get-setup-folder-stats", args),
  localMediaGetPlayerUrl: (args) =>
    ipcRenderer.invoke("local-media-get-player-url", args),
  localMediaGetUrl: (filePath, startTime) =>
    ipcRenderer.invoke("local-media-get-url", {
      filePath,
      startTime,
    }),
  localMediaFileExists: (filePath) =>
    ipcRenderer.invoke("local-media-file-exists", { filePath }),
  localMediaRelease: () => ipcRenderer.invoke("local-media-release"),
  localMediaGetPreparedUrl: (filePath, startTime) =>
    ipcRenderer.invoke("local-media-get-prepared-url", { filePath, startTime }),

  // Misc
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  openPath: (filePath) => ipcRenderer.invoke("open-path", filePath),
  getInstallPath: () => ipcRenderer.invoke("get-install-path"),
  getBundledTools: () => ipcRenderer.invoke("get-bundled-tools"),
  getLibraryPaths: () => ipcRenderer.invoke("get-library-paths"),
  saveLibraryPaths: (paths) =>
    ipcRenderer.invoke("save-library-paths", paths || {}),
  notifyLibraryPathsChanged: (paths) =>
    ipcRenderer.invoke("notify-library-paths-changed", paths || {}),
  getYtBridgeStatus: () => ipcRenderer.invoke("get-yt-bridge-status"),
  restartYtBridge: () => ipcRenderer.invoke("restart-yt-bridge"),
  getYtBridgeStartup: () => ipcRenderer.invoke("get-yt-bridge-startup"),
  setYtBridgeStartup: (enabled) =>
    ipcRenderer.invoke("set-yt-bridge-startup", enabled),
  getDefaultDownloaderFolder: () =>
    ipcRenderer.invoke("get-default-downloader-folder"),
  openPathAtTime: (filePath, seconds, subtitlePaths) =>
    ipcRenderer.invoke("open-path-at-time", {
      filePath,
      seconds,
      subtitlePaths,
    }),
  pruneSubtitlePaths: (downloadId) =>
    ipcRenderer.invoke("prune-subtitle-paths", { downloadId }),

  // Close confirmation
  onConfirmClose: (cb) => {
    const h = (_, data) => cb(data);
    ipcRenderer.on("confirm-close", h);
    return h;
  },
  offConfirmClose: (h) => ipcRenderer.removeListener("confirm-close", h),
  respondClose: (confirm) => ipcRenderer.send("close-response", confirm),

  // anime episode resolver (main-process HTTP, bypasses CORS/bot-check)
  resolveAllManga: (args) => ipcRenderer.invoke("resolve-allmanga", args),
  setPlayerVideo: (args) => ipcRenderer.invoke("set-player-video", args),
  debugAllManga: (args) => ipcRenderer.invoke("debug-allmanga", args),

  // App version (from package.json via Electron)
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),

  // Webview fullscreen
  onWebviewEnterFullscreen: (cb) => {
    const h = () => cb();
    ipcRenderer.on("webview-enter-fullscreen", h);
    return h;
  },
  offWebviewEnterFullscreen: (h) =>
    ipcRenderer.removeListener("webview-enter-fullscreen", h),
  onWebviewLeaveFullscreen: (cb) => {
    const h = () => cb();
    ipcRenderer.on("webview-leave-fullscreen", h);
    return h;
  },
  offWebviewLeaveFullscreen: (h) =>
    ipcRenderer.removeListener("webview-leave-fullscreen", h),

  // Block stats
  onBlockedUpdate: (cb) => {
    const h = (_, data) => cb(data);
    ipcRenderer.on("blocked-stats-update", h);
    return h;
  },
  offBlockedUpdate: (h) =>
    ipcRenderer.removeListener("blocked-stats-update", h),
  getBlockStats: () => ipcRenderer.invoke("get-block-stats"),

  // Desktop notifications (triggered from renderer, executed in main)
  showNotification: ({ title, body, silent }) =>
    ipcRenderer.invoke("show-notification", { title, body, silent }),

  // Quit app
  quitApp: () => ipcRenderer.invoke("quit-app"),

  // Keep the display awake while in-app playback is active
  setPlaybackKeepAwake: (active) =>
    ipcRenderer.invoke("playback-keepawake", active),

  // Signal to main process that the player has stopped
  playerStopped: () => ipcRenderer.send("player-stopped"),

  // Storage cleaning
  getCacheSize: () => ipcRenderer.invoke("get-cache-size"),
  getDownloadsSize: () => ipcRenderer.invoke("get-downloads-size"),
  clearAppCache: () => ipcRenderer.invoke("clear-app-cache"),
  queryVideoProgress: (webContentsId) =>
    ipcRenderer.invoke("query-video-progress", webContentsId),
  automateEmbedPlayer: (webContentsId) =>
    ipcRenderer.invoke("automate-embed-player", webContentsId),
  clickEmbedPlayCenter: (webContentsId) =>
    ipcRenderer.invoke("click-embed-play-center", webContentsId),
  clearWatchData: () => ipcRenderer.invoke("clear-watch-data"),
  deleteAllDownloads: () => ipcRenderer.invoke("delete-all-downloads"),
  resetApp: () => ipcRenderer.invoke("reset-app"),
  // Subtitles
  searchSubtitles: (args) => ipcRenderer.invoke("search-subtitles", args),
  getSubtitleUrl: (args) => ipcRenderer.invoke("get-subtitle-url", args),
  downloadSubtitlesForFile: (args) =>
    ipcRenderer.invoke("download-subtitles-for-file", args),
  deleteSubtitleFile: (args) =>
    ipcRenderer.invoke("delete-subtitle-file", args),
  // Wyzie API key redemption
  wyzieOpenRedeem: () => ipcRenderer.invoke("wyzie-open-redeem"),
  wyzieValidateKey: (key) => ipcRenderer.invoke("wyzie-validate-key", key),
  // Secure key store (OS-encrypted via safeStorage)
  secureGet: (key) =>
    ipcRenderer.invoke("secure-store-get", key).then((r) => r.value ?? null),
  secureSet: (key, value) =>
    ipcRenderer.invoke("secure-store-set", { key, value }),
  // Picture-in-Picture pop-out (full player UI, only one stream active at a time)
  openPipWindow: (url, title) =>
    ipcRenderer.invoke("open-pip-window", { url, title }),
  closePipWindow: () => ipcRenderer.invoke("close-pip-window"),
  getPipWebContentsId: () => ipcRenderer.invoke("get-pip-webcontents-id"),
  onPipOpened: (cb) => {
    const h = () => cb();
    ipcRenderer.on("pip-window-opened", h);
    return h;
  },
  offPipOpened: (h) => ipcRenderer.removeListener("pip-window-opened", h),
  onPipClosed: (cb) => {
    const h = () => cb();
    ipcRenderer.on("pip-window-closed", h);
    return h;
  },
  offPipClosed: (h) => ipcRenderer.removeListener("pip-window-closed", h),
  // Window controls (Windows custom titlebar)
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowToggleMaximize: () => ipcRenderer.invoke("window-toggle-maximize"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  getPlatform: () => ipcRenderer.invoke("get-platform"),
  // Push events: main process emits "window-maximized" with a boolean payload
  onWindowMaximize: (cb) => {
    const h = (_, v) => cb(v);
    ipcRenderer.on("window-maximized", h);
    return h;
  },
  offWindowMaximize: (h) => ipcRenderer.removeListener("window-maximized", h),
  getVideoDuration: (filePath) =>
    ipcRenderer.invoke("get-video-duration", filePath),
  setZoomFactor: (factor) => webFrame.setZoomFactor(factor),
  // Auto-updater
  detectUpdateFormat: () => ipcRenderer.invoke("detect-update-format"),
  downloadAndInstallUpdate: (args) =>
    ipcRenderer.invoke("download-and-install-update", args),
  cancelUpdate: () => ipcRenderer.invoke("cancel-update"),
  onUpdateProgress: (cb) => {
    const h = (_, data) => cb(data);
    ipcRenderer.on("update-progress", h);
    return h;
  },
  offUpdateProgress: (h) => ipcRenderer.removeListener("update-progress", h),
  // Casting (Chromecast + DLNA)
  castStartDiscovery: (opts) =>
    ipcRenderer.invoke("cast:start-discovery", opts),
  castStopDiscovery: () => ipcRenderer.invoke("cast:stop-discovery"),
  castListDevices: () => ipcRenderer.invoke("cast:list-devices"),
  castConnect: (deviceId) => ipcRenderer.invoke("cast:connect", { deviceId }),
  castDisconnect: () => ipcRenderer.invoke("cast:disconnect"),
  castLoad: (args) => ipcRenderer.invoke("cast:load", args),
  castPlay: () => ipcRenderer.invoke("cast:play"),
  castPause: () => ipcRenderer.invoke("cast:pause"),
  castStop: () => ipcRenderer.invoke("cast:stop"),
  castSeek: (seconds) => ipcRenderer.invoke("cast:seek", { seconds }),
  castSetVolume: (level) => ipcRenderer.invoke("cast:set-volume", { level }),
  castSetMute: (muted) => ipcRenderer.invoke("cast:set-mute", { muted }),
  castGetStatus: () => ipcRenderer.invoke("cast:get-status"),
  castSetSubtitleTrack: (trackIndex) =>
    ipcRenderer.invoke("cast:set-subtitle-track", { trackIndex }),
  onCastDevicesUpdated: (cb) => {
    const h = (_, d) => cb(d);
    ipcRenderer.on("cast:devices-updated", h);
    return h;
  },
  offCastDevicesUpdated: (h) =>
    ipcRenderer.removeListener("cast:devices-updated", h),
  onCastStatus: (cb) => {
    const h = (_, d) => cb(d);
    ipcRenderer.on("cast:status", h);
    return h;
  },
  offCastStatus: (h) => ipcRenderer.removeListener("cast:status", h),
  onCastSessionEnded: (cb) => {
    const h = (_, d) => cb(d);
    ipcRenderer.on("cast:session-ended", h);
    return h;
  },
  offCastSessionEnded: (h) =>
    ipcRenderer.removeListener("cast:session-ended", h),
  onCastError: (cb) => {
    const h = (_, d) => cb(d);
    ipcRenderer.on("cast:error", h);
    return h;
  },
  offCastError: (h) => ipcRenderer.removeListener("cast:error", h),
  // Scheduled backups
  getScheduledBackupSettings: () =>
    ipcRenderer.invoke("get-scheduled-backup-settings"),
  setScheduledBackupSettings: (settings) =>
    ipcRenderer.invoke("set-scheduled-backup-settings", settings),
  performScheduledBackup: (args) =>
    ipcRenderer.invoke("perform-scheduled-backup", args),
  onScheduledBackupRequested: (cb) => {
    const h = () => cb();
    ipcRenderer.on("scheduled-backup-requested", h);
    return h;
  },
  offScheduledBackupRequested: (h) =>
    ipcRenderer.removeListener("scheduled-backup-requested", h),

  // YouTube library (YouTube Downloader Extension catalog)
  getYoutubeDefaultFolder: () =>
    ipcRenderer.invoke("get-youtube-default-folder"),
  loadYoutubeCatalog: (args) =>
    ipcRenderer.invoke("load-youtube-catalog", args),
  scanYoutubeCatalogFromDisk: (args) =>
    ipcRenderer.invoke("scan-youtube-catalog-from-disk", args),
  cloneYoutubeCatalogForMetadataTest: (args) =>
    ipcRenderer.invoke("clone-youtube-catalog-for-metadata-test", args),
  getYoutubeCatalogVideo: (args) =>
    ipcRenderer.invoke("get-youtube-catalog-video", args),
  getYoutubeCatalogRecord: (args) =>
    ipcRenderer.invoke("get-youtube-catalog-record", args),
  updateYoutubeCatalogRecord: (args) =>
    ipcRenderer.invoke("update-youtube-catalog-record", args),
  youtubeFileExists: (filePath) =>
    ipcRenderer.invoke("youtube-file-exists", { filePath }),
  removeYoutubeCatalogEntry: (args) =>
    ipcRenderer.invoke("remove-youtube-catalog-entry", args),
  startYoutubeCatalogEnrich: (args) =>
    ipcRenderer.invoke("start-youtube-catalog-enrich", args),
  cancelYoutubeCatalogEnrich: () =>
    ipcRenderer.invoke("cancel-youtube-catalog-enrich"),
  getYoutubeCatalogEnrichStatus: () =>
    ipcRenderer.invoke("get-youtube-catalog-enrich-status"),
  onYoutubeEnrichProgress: (cb) => {
    const h = (_, update) => cb(update);
    ipcRenderer.on("youtube-enrich-progress", h);
    return h;
  },
  offYoutubeEnrichProgress: (h) =>
    ipcRenderer.removeListener("youtube-enrich-progress", h),
  onYoutubeCatalogUpdated: (cb) => {
    const h = (_, detail) => cb(detail || {});
    ipcRenderer.on("youtube-catalog-updated", h);
    return h;
  },
  offYoutubeCatalogUpdated: (h) =>
    ipcRenderer.removeListener("youtube-catalog-updated", h),
});
