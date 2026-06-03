import { useCallback, useEffect, useRef, useState } from "react";
import { storage, STORAGE_KEYS, isElectron } from "../utils/storage";
import { getStoredYoutubePath } from "../utils/libraryPaths";
import {
  DEFAULT_MATCH_CONFIG,
  normalizeMatchConfig,
} from "../utils/youtubeEnrichMatch.js";
import { useYoutubeMetadataEnrich } from "../hooks/useYoutubeMetadataEnrich";
import YoutubeMatchLogicBuilder from "./YoutubeMatchLogicBuilder.jsx";
import {
  isYoutubeMetadataTestModeEnabled,
  setYoutubeMetadataTestModeEnabled,
} from "../utils/youtubeAdminTest";

function loadStoredMatchConfig() {
  const stored = storage.get(STORAGE_KEYS.YOUTUBE_ENRICH_MATCH_CONFIG);
  return normalizeMatchConfig(stored || DEFAULT_MATCH_CONFIG);
}

function AdminToggle({ value, onChange, title }) {
  return (
    <button
      type="button"
      className={`appearance-toggle${value ? "" : " appearance-toggle--off"}`}
      onClick={() => onChange(!value)}
      title={title}
      aria-pressed={value}
      style={{
        background: value ? "var(--red)" : "var(--surface2)",
        border: `1px solid ${value ? "var(--red)" : "var(--border)"}`,
        borderRadius: 20,
        width: 40,
        height: 22,
        cursor: "pointer",
        position: "relative",
        flexShrink: 0,
        transition: "background 0.2s, border-color 0.2s",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: value ? 20 : 2,
          width: 16,
          height: 16,
          background: "#fff",
          borderRadius: "50%",
          transition: "left 0.2s",
          boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
        }}
      />
    </button>
  );
}

export default function YoutubeMetadataSyncSection({ youtubeFolder, onShowToast }) {
  const [matchConfig, setMatchConfig] = useState(loadStoredMatchConfig);
  const [metadataTestMode, setMetadataTestMode] = useState(
    isYoutubeMetadataTestModeEnabled,
  );
  const enrich = useYoutubeMetadataEnrich();
  const [logOpen, setLogOpen] = useState(false);
  const logRef = useRef(null);

  useEffect(() => {
    storage.set(STORAGE_KEYS.YOUTUBE_ENRICH_MATCH_CONFIG, matchConfig);
  }, [matchConfig]);

  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [enrich.lines]);

  const handleRun = useCallback(async () => {
    if (!isElectron || !window.electron?.startYoutubeCatalogEnrich) {
      return;
    }
    if (enrich.running) return;

    setLogOpen(true);
    enrich.reset();

    const folder =
      youtubeFolder?.trim() ||
      getStoredYoutubePath() ||
      "";
    const result = await enrich.run({
      folder,
      matchConfig: normalizeMatchConfig(matchConfig),
    });
    if (!result?.ok && result?.error) {
      return;
    }
    if (result?.ok) {
      onShowToast?.("YouTube metadata sync complete", { variant: "success" });
    }
  }, [enrich, matchConfig, onShowToast, youtubeFolder]);

  const handleCancel = useCallback(async () => {
    await enrich.cancel();
  }, [enrich]);

  const summaryText = enrich.summary
    ? `Updated ${enrich.summary.updated ?? 0} · skipped ${enrich.summary.skipped ?? 0} · processed ${enrich.summary.processed ?? 0}`
    : null;

  return (
    <div style={{ marginBottom: 40 }}>
      <div className="settings-section-title">YouTube Metadata Sync</div>
      <div
        style={{
          fontSize: 13,
          color: "var(--text3)",
          marginBottom: 16,
          lineHeight: 1.6,
        }}
      >
        Notice a Youtube Thumbnail missing? Match local video files to YouTube IDs,
        thumbnails, and channel names in{" "}
        <code>youtube-catalog.json</code>. Useful for older downloads or library
        scans that are missing metadata. Refresh the YouTube tab when finished.
        You can also sync one video at a time from its card in the YouTube library.
      </div>

      <YoutubeMatchLogicBuilder
        value={matchConfig}
        onChange={setMatchConfig}
        disabled={enrich.running}
      />

      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "center",
          marginTop: 18,
        }}
      >
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleRun}
          disabled={enrich.running || !isElectron}
        >
          {enrich.running ? "Syncing…" : "Run metadata sync (all missing)"}
        </button>
        {enrich.running && (
          <button type="button" className="btn btn-secondary" onClick={handleCancel}>
            Cancel
          </button>
        )}
        {enrich.lines.length > 0 && !enrich.running && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setLogOpen((o) => !o)}
          >
            {logOpen ? "Hide log" : "Show log"}
          </button>
        )}
      </div>

      {enrich.error && (
        <div style={{ marginTop: 12, fontSize: 13, color: "var(--red)" }}>
          {enrich.error}
        </div>
      )}

      {summaryText && !enrich.running && (
        <div className="yt-enrich-summary">
          <div className="yt-enrich-summary__title">Sync complete</div>
          <div className="yt-enrich-summary__stats">{summaryText}</div>
          {enrich.summary?.backupPath && (
            <div className="yt-enrich-summary__meta">
              Backup: {enrich.summary.backupPath}
            </div>
          )}
          <div className="yt-enrich-summary__hint">
            Open the YouTube tab and click Refresh to see updated thumbnails.
          </div>
        </div>
      )}

      {(logOpen || enrich.running) && enrich.lines.length > 0 && (
        <div className="yt-enrich-log-wrap">
          <div className="yt-enrich-log-header">
            <span>{enrich.running ? "Running…" : "Output log"}</span>
            {enrich.running && <span className="yt-enrich-log-pulse" />}
          </div>
          <pre ref={logRef} className="yt-enrich-log">
            {enrich.lines.join("\n")}
          </pre>
        </div>
      )}

      <div className="yt-admin-test-panel">
        <div className="yt-admin-test-panel__head">
          <div>
            <div className="settings-section-title settings-section-title--sm">
              Admin testing
            </div>
            <p className="yt-admin-test-panel__desc">
              Adds a <strong>Clone for metadata test</strong> button on each YouTube
              library card. Creates a second catalog entry for the same file with no
              thumbnail or YouTube ID—only folder channel, title, and duration—so you
              can exercise metadata sync without touching the original.
            </p>
          </div>
          <AdminToggle
            value={metadataTestMode}
            onChange={(on) => {
              setMetadataTestMode(on);
              setYoutubeMetadataTestModeEnabled(on);
              onShowToast?.(
                on
                  ? "Metadata test mode enabled on YouTube library"
                  : "Metadata test mode disabled",
                { variant: on ? "success" : "info" },
              );
            }}
            title="Enable metadata test clones on YouTube cards"
          />
        </div>
      </div>
    </div>
  );
}
