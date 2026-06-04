import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCwIcon, CloseIcon } from "./Icons";
import { useYoutubeMetadataEnrich } from "../hooks/useYoutubeMetadataEnrich";
import { storage, STORAGE_KEYS } from "../utils/storage";
import { getStoredYoutubePath } from "../utils/libraryPaths";
import {
  DEFAULT_MATCH_CONFIG,
  normalizeMatchConfig,
} from "../utils/youtubeEnrichMatch.js";

function loadStoredMatchConfig() {
  const stored = storage.get(STORAGE_KEYS.YOUTUBE_ENRICH_MATCH_CONFIG);
  return normalizeMatchConfig(stored || DEFAULT_MATCH_CONFIG);
}

export function useYoutubeCardMetadataSync({
  video,
  youtubeFolder,
  onMetadataSyncClosed,
  disabled = false,
}) {
  const enrich = useYoutubeMetadataEnrich();
  const [panelOpen, setPanelOpen] = useState(false);
  const logRef = useRef(null);
  const syncRanRef = useRef(false);

  useEffect(() => {
    if (!logRef.current || !panelOpen) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [enrich.lines, panelOpen]);

  const handleSync = useCallback(async () => {
    if (enrich.running || disabled) return;
    setPanelOpen(true);
    syncRanRef.current = true;
    enrich.reset();

    const folder =
      youtubeFolder?.trim() || getStoredYoutubePath() || "";
    try {
      await enrich.run({
        folder,
        recordId: video.id,
        matchConfig: loadStoredMatchConfig(),
      });
    } catch (err) {
      enrich.appendLine?.(`Error: ${err?.message || String(err)}`);
    }
    // Results stay visible until the user closes the panel; library refresh runs then.
  }, [disabled, enrich, video.id, youtubeFolder]);

  const handleClosePanel = useCallback(async () => {
    if (enrich.running) return;
    const shouldRefreshLibrary = syncRanRef.current;
    syncRanRef.current = false;
    setPanelOpen(false);
    enrich.reset();
    if (shouldRefreshLibrary) {
      await onMetadataSyncClosed?.(video.id);
    }
  }, [enrich, onMetadataSyncClosed, video.id]);

  const success =
    !enrich.running &&
    enrich.summary &&
    (enrich.summary.updated ?? 0) > 0;
  const failed =
    !enrich.running &&
    enrich.summary &&
    (enrich.summary.updated ?? 0) === 0 &&
    !enrich.error;
  const finished = !enrich.running && (enrich.summary || enrich.error);
  const showPanel = panelOpen;

  return {
    enrich,
    logRef,
    handleSync,
    handleClosePanel,
    success,
    failed,
    finished,
    showPanel,
    running: enrich.running,
    disabled,
  };
}

export function YoutubeCardSyncButton({ sync, blocked = false }) {
  const { handleSync, running, disabled, showPanel } = sync;

  return (
    <button
      type="button"
      className={`icon-btn yt-card__sync-btn${running ? " yt-card__sync-btn--spin" : ""}${showPanel ? " yt-card__sync-btn--active" : ""}`}
      title="Fetch YouTube metadata for this video"
      disabled={disabled || blocked || running}
      onClick={() => void handleSync()}
      aria-label="Sync metadata"
      aria-expanded={showPanel}
    >
      <RefreshCwIcon size={15} />
    </button>
  );
}

export function YoutubeCardSyncOverlay({ sync, onSettings }) {
  const {
    enrich,
    logRef,
    handleClosePanel,
    success,
    failed,
    finished,
    showPanel,
    running,
  } = sync;

  if (!showPanel) return null;

  return (
    <div
      className="yt-card__sync-overlay"
      role="dialog"
      aria-label="Metadata sync"
      aria-live="polite"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="yt-card__sync-overlay-inner">
        <div className="yt-card__sync-panel-head">
          <span className="yt-card__sync-panel-title">
            {running ? "Syncing metadata…" : "Metadata sync"}
          </span>
          {!running && (
            <button
              type="button"
              className="yt-card__sync-panel-close"
              onClick={() => void handleClosePanel()}
              aria-label="Close"
              title="Close and refresh library"
            >
              <CloseIcon />
            </button>
          )}
        </div>

        {!finished && (
          <p className="yt-card__sync-panel-hint">
            Uses rules from{" "}
            <button
              type="button"
              className="yt-card__sync-settings-link"
              onClick={() => onSettings?.("youtube-metadata")}
            >
              Settings
            </button>
            . Local title unchanged.
          </p>
        )}

        <div className="yt-card__sync-overlay-body">
          {(enrich.lines.length > 0 || running) && (
            <pre ref={logRef} className="yt-card__sync-log">
              {enrich.lines.length ? enrich.lines.join("\n") : "Starting…"}
            </pre>
          )}
        </div>

        <div className="yt-card__sync-overlay-footer">
          {success && (
            <div className="yt-card__sync-banner yt-card__sync-banner--ok">
              Success — metadata saved. Thumbnail should appear on this card.
            </div>
          )}
          {failed && (
            <div className="yt-card__sync-banner yt-card__sync-banner--warn">
              No match found. Adjust rules in Settings and try again.
            </div>
          )}
          {enrich.error && (
            <div className="yt-card__sync-banner yt-card__sync-banner--err">
              {enrich.error}
            </div>
          )}

          {running ? (
            <button
              type="button"
              className="btn btn-ghost btn--sm yt-card__sync-dismiss"
              onClick={() => void enrich.cancel()}
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn--sm yt-card__sync-dismiss"
              onClick={() => void handleClosePanel()}
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** @deprecated Use useYoutubeCardMetadataSync + Button + Overlay */
export default function YoutubeCardMetadataSync(props) {
  const sync = useYoutubeCardMetadataSync(props);
  return (
    <>
      <YoutubeCardSyncButton sync={sync} />
      <YoutubeCardSyncOverlay sync={sync} onSettings={props.onSettings} />
    </>
  );
}
