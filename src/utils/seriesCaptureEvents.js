/** Coordinates TV page player vs batch capture webview (same persist:player partition). */

export const SERIES_CAPTURE_BEGIN = "streamstein-series-capture-begin";
export const SERIES_CAPTURE_END = "streamstein-series-capture-end";

export function pauseTvPlayersForSeriesCapture() {
  window.dispatchEvent(new Event(SERIES_CAPTURE_BEGIN));
}

export function resumeTvPlayersAfterSeriesCapture() {
  window.dispatchEvent(new Event(SERIES_CAPTURE_END));
}
