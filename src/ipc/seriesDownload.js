// ── TV series batch download (cancel + helpers) ─────────────────────────────
// Episode resolve + enqueue runs in the renderer (seriesDownloadRunner.js),
// matching the manual Download modal flow: capture m3u8 → runDownload.

const { ipcMain } = require("electron");

let _cancelQueuedBySeriesBatch = null;

function register(_getMainWindow, { cancelQueuedBySeriesBatch } = {}) {
  _cancelQueuedBySeriesBatch = cancelQueuedBySeriesBatch;

  ipcMain.handle("cancel-series-download", (_, { batchId } = {}) => {
    const cancelled = _cancelQueuedBySeriesBatch?.(batchId) ?? 0;
    return { ok: true, cancelled };
  });

  ipcMain.handle("series-download-active", () => ({
    active: false,
  }));

  /** @deprecated Renderer orchestrates series downloads directly */
  ipcMain.handle("start-series-download", async () => ({
    ok: false,
    error: "Series download is handled in the app UI (restart Streamstein if this persists).",
  }));
}

module.exports = { register };
