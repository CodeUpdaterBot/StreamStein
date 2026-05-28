/** Batch series m3u8 capture — scoped to one embed webview at a time. */

let _session = null;

/**
 * @param {(url: string, allUrls: string[]) => void} onUpdate
 * @param {number} [expectedWebContentsId]
 * @returns {() => void}
 */
export function reserveM3u8Capture(onUpdate, expectedWebContentsId) {
  _session = {
    onUpdate,
    expectedWebContentsId: expectedWebContentsId || null,
    urls: [],
  };
  return () => {
    _session = null;
  };
}

/**
 * @param {string} url
 * @param {number} [webContentsId]
 * @returns {boolean}
 */
export function deliverM3u8ToBatch(url, webContentsId) {
  if (!_session || !url) return false;
  if (
    _session.expectedWebContentsId != null &&
    webContentsId != null &&
    _session.expectedWebContentsId !== webContentsId
  ) {
    return false;
  }
  _session.urls.push(url);
  _session.onUpdate(url, [..._session.urls]);
  return true;
}

export function isBatchCaptureActive() {
  return _session != null;
}
