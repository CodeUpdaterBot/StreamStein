import { useCallback, useEffect, useMemo, useState } from "react";
import { PencilIcon, CloseIcon } from "./Icons";
import { getStoredYoutubePath } from "../utils/libraryPaths";
import { isElectron } from "../utils/storage";

const EMPTY_FORM = {
  title: "",
  normalizedTitle: "",
  channelName: "",
  channelKey: "",
  channelId: "",
  videoId: "",
  watchUrl: "",
  shortUrl: "",
  thumbnailUrl: "",
  filePath: "",
  fileName: "",
  directory: "",
  extension: "",
  quality: "",
  source: "",
  status: "completed",
  libraryEntryId: "",
  size: "",
  mtime: "",
  durationSeconds: "",
  requestedAt: "",
  completedAt: "",
  metadataEnrichedAt: "",
  metadataEnrichedBy: "",
  intendedPath: "",
};

function recordToForm(record) {
  if (!record) return { ...EMPTY_FORM };
  const str = (v) => (v == null ? "" : String(v));
  return {
    title: str(record.title),
    normalizedTitle: str(record.normalizedTitle),
    channelName: str(record.channelName),
    channelKey: str(record.channelKey),
    channelId: str(record.channelId),
    videoId: str(record.videoId),
    watchUrl: str(record.watchUrl),
    shortUrl: str(record.shortUrl),
    thumbnailUrl: str(record.thumbnailUrl),
    filePath: str(record.filePath),
    fileName: str(record.fileName),
    directory: str(record.directory),
    extension: str(record.extension),
    quality: str(record.quality),
    source: str(record.source),
    status: str(record.status) || "completed",
    libraryEntryId: str(record.libraryEntryId),
    size: record.size != null ? String(record.size) : "",
    mtime: record.mtime != null ? String(record.mtime) : "",
    durationSeconds:
      record.durationSeconds != null ? String(record.durationSeconds) : "",
    requestedAt: str(record.requestedAt),
    completedAt: str(record.completedAt),
    metadataEnrichedAt: str(record.metadataEnrichedAt),
    metadataEnrichedBy: str(record.metadataEnrichedBy),
    intendedPath: str(record.intendedPath),
  };
}

function formToPatch(form) {
  return { ...form };
}

function EditField({
  label,
  value,
  onChange,
  readOnly = false,
  mono = false,
  type = "text",
  placeholder,
}) {
  return (
    <label className="yt-card__edit-field">
      <span className="yt-card__edit-label">{label}</span>
      <input
        type={type}
        className={`yt-card__edit-input${mono ? " yt-card__edit-input--mono" : ""}`}
        value={value}
        readOnly={readOnly}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function EditSection({ title, children }) {
  return (
    <div className="yt-card__edit-section">
      <div className="yt-card__edit-section-title">{title}</div>
      <div className="yt-card__edit-section-grid">{children}</div>
    </div>
  );
}

export function useYoutubeCardCatalogEdit({
  video,
  youtubeFolder,
  onEditClosed,
  disabled = false,
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [readOnly, setReadOnly] = useState({});
  const [fileExists, setFileExists] = useState(null);
  const [error, setError] = useState(null);
  const [saveMessage, setSaveMessage] = useState(null);
  const [dirty, setDirty] = useState(false);

  const loadRecord = useCallback(async () => {
    if (!window.electron?.getYoutubeCatalogRecord) {
      setError("Edit requires the Streamstein desktop app.");
      return;
    }
    setLoading(true);
    setError(null);
    setSaveMessage(null);
    try {
      const folder =
        youtubeFolder?.trim() || getStoredYoutubePath() || "";
      const res = await window.electron.getYoutubeCatalogRecord({
        youtubeFolder: folder,
        recordId: video.id,
      });
      if (!res?.ok || !res.record) {
        setError(res?.error || "Could not load catalog entry.");
        return;
      }
      setForm(recordToForm(res.record));
      setReadOnly({
        id: res.record.id,
        assetType: res.record.assetType,
        metadataTestClone: res.record.metadataTestClone ? "yes" : "no",
        metadataTestSourceId: res.record.metadataTestSourceId || "—",
      });
      setFileExists(res.fileExists);
      setDirty(false);
    } catch (err) {
      setError(err?.message || "Could not load catalog entry.");
    } finally {
      setLoading(false);
    }
  }, [video.id, youtubeFolder]);

  const openPanel = useCallback(() => {
    if (disabled) return;
    setPanelOpen(true);
    void loadRecord();
  }, [disabled, loadRecord]);

  const handleClosePanel = useCallback(async () => {
    if (saving) return;
    const shouldRefresh = !!saveMessage;
    setPanelOpen(false);
    setForm(EMPTY_FORM);
    setReadOnly({});
    setError(null);
    setSaveMessage(null);
    setDirty(false);
    if (shouldRefresh) {
      await onEditClosed?.(video.id);
    }
  }, [onEditClosed, saveMessage, saving, video.id]);

  const setField = useCallback((key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    setSaveMessage(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!isElectron || !window.electron?.updateYoutubeCatalogRecord) return;
    setSaving(true);
    setError(null);
    try {
      const folder =
        youtubeFolder?.trim() || getStoredYoutubePath() || "";
      const res = await window.electron.updateYoutubeCatalogRecord({
        youtubeFolder: folder,
        recordId: video.id,
        patch: formToPatch(form),
      });
      if (!res?.ok) {
        setError(res?.error || "Could not save changes.");
        return;
      }
      setSaveMessage("Saved to youtube-catalog.json");
      setDirty(false);
      if (res.record) {
        setForm(recordToForm(res.record));
      }
    } catch (err) {
      setError(err?.message || "Could not save changes.");
    } finally {
      setSaving(false);
    }
  }, [form, video.id, youtubeFolder]);

  const showPanel = panelOpen;

  return {
    showPanel,
    openPanel,
    handleClosePanel,
    handleSave,
    loading,
    saving,
    form,
    setField,
    readOnly,
    fileExists,
    error,
    saveMessage,
    dirty,
    disabled,
  };
}

export function YoutubeCardEditButton({ edit, blocked = false }) {
  const { openPanel, showPanel, loading, saving, disabled } = edit;
  return (
    <button
      type="button"
      className={`icon-btn yt-card__edit-btn${showPanel ? " yt-card__edit-btn--active" : ""}`}
      title="View and edit library info"
      disabled={disabled || blocked || loading || saving}
      onClick={openPanel}
      aria-label="Edit library info"
      aria-expanded={showPanel}
    >
      <PencilIcon size={15} />
    </button>
  );
}

export function YoutubeCardEditOverlay({ edit }) {
  const {
    showPanel,
    handleClosePanel,
    handleSave,
    loading,
    saving,
    form,
    setField,
    readOnly,
    fileExists,
    error,
    saveMessage,
    dirty,
  } = edit;

  const fileStatus = useMemo(() => {
    if (fileExists === true) return "File found on disk";
    if (fileExists === false) return "File missing on disk";
    return "";
  }, [fileExists]);

  if (!showPanel) return null;

  return (
    <div
      className="yt-card__sync-overlay yt-card__edit-overlay"
      role="dialog"
      aria-label="Edit library entry"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="yt-card__sync-overlay-inner yt-card__edit-overlay-inner">
        <div className="yt-card__sync-panel-head yt-card__edit-panel-head">
          <div className="yt-card__edit-panel-head-text">
            <span className="yt-card__sync-panel-title">Library entry</span>
            <p className="yt-card__edit-panel-hint">
              Saves to <code>youtube-catalog.json</code>
            </p>
          </div>
          <button
            type="button"
            className="yt-card__sync-panel-close"
            onClick={() => void handleClosePanel()}
            disabled={saving}
            aria-label="Close"
            title="Close"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="yt-card__sync-overlay-body yt-card__edit-overlay-body">
          {loading ? (
            <p className="yt-card__edit-loading">Loading catalog entry…</p>
          ) : (
            <div className="yt-card__edit-scroll">
              <EditSection title="Display">
                <EditField
                  label="Title"
                  value={form.title}
                  onChange={(v) => setField("title", v)}
                />
                <EditField
                  label="Channel (library)"
                  value={form.channelName}
                  onChange={(v) => setField("channelName", v)}
                />
                <EditField
                  label="Channel key"
                  value={form.channelKey}
                  onChange={(v) => setField("channelKey", v)}
                  mono
                />
                <EditField
                  label="Normalized title"
                  value={form.normalizedTitle}
                  onChange={(v) => setField("normalizedTitle", v)}
                  mono
                />
              </EditSection>

              <EditSection title="YouTube">
                <EditField
                  label="Video ID"
                  value={form.videoId}
                  onChange={(v) => setField("videoId", v)}
                  mono
                />
                <EditField
                  label="Watch URL"
                  value={form.watchUrl}
                  onChange={(v) => setField("watchUrl", v)}
                  mono
                />
                <EditField
                  label="Short URL"
                  value={form.shortUrl}
                  onChange={(v) => setField("shortUrl", v)}
                  mono
                />
                <EditField
                  label="Thumbnail URL"
                  value={form.thumbnailUrl}
                  onChange={(v) => setField("thumbnailUrl", v)}
                  mono
                />
                <EditField
                  label="YouTube channel ID"
                  value={form.channelId}
                  onChange={(v) => setField("channelId", v)}
                  mono
                />
              </EditSection>

              <EditSection title="File">
                <EditField
                  label="File path"
                  value={form.filePath}
                  onChange={(v) => setField("filePath", v)}
                  mono
                />
                <EditField
                  label="File name"
                  value={form.fileName}
                  onChange={(v) => setField("fileName", v)}
                />
                <EditField
                  label="Directory"
                  value={form.directory}
                  onChange={(v) => setField("directory", v)}
                  mono
                />
                <EditField
                  label="Extension"
                  value={form.extension}
                  onChange={(v) => setField("extension", v)}
                />
                <EditField
                  label="Size (bytes)"
                  value={form.size}
                  onChange={(v) => setField("size", v)}
                  mono
                />
                <EditField
                  label="mtime (ms)"
                  value={form.mtime}
                  onChange={(v) => setField("mtime", v)}
                  mono
                />
                <EditField
                  label="Duration (sec)"
                  value={form.durationSeconds}
                  onChange={(v) => setField("durationSeconds", v)}
                  mono
                />
                <EditField
                  label="Quality"
                  value={form.quality}
                  onChange={(v) => setField("quality", v)}
                />
              </EditSection>

              <EditSection title="Catalog">
                <label className="yt-card__edit-field">
                  <span className="yt-card__edit-label">Status</span>
                  <select
                    className="yt-card__edit-input yt-card__edit-select"
                    value={form.status}
                    onChange={(e) => setField("status", e.target.value)}
                  >
                    <option value="completed">completed</option>
                    <option value="pending">pending</option>
                    <option value="failed">failed</option>
                  </select>
                </label>
                <EditField
                  label="Source"
                  value={form.source}
                  onChange={(v) => setField("source", v)}
                />
                <EditField
                  label="Library entry ID"
                  value={form.libraryEntryId}
                  onChange={(v) => setField("libraryEntryId", v)}
                  mono
                />
                <EditField
                  label="Requested at"
                  value={form.requestedAt}
                  onChange={(v) => setField("requestedAt", v)}
                  mono
                />
                <EditField
                  label="Completed at"
                  value={form.completedAt}
                  onChange={(v) => setField("completedAt", v)}
                  mono
                />
                <EditField
                  label="Enriched at"
                  value={form.metadataEnrichedAt}
                  onChange={(v) => setField("metadataEnrichedAt", v)}
                  mono
                />
                <EditField
                  label="Enriched by"
                  value={form.metadataEnrichedBy}
                  onChange={(v) => setField("metadataEnrichedBy", v)}
                />
                <EditField
                  label="Intended path"
                  value={form.intendedPath}
                  onChange={(v) => setField("intendedPath", v)}
                  mono
                />
              </EditSection>

              <EditSection title="System">
                <EditField
                  label="Record ID"
                  value={readOnly.id || ""}
                  readOnly
                  mono
                />
                <EditField
                  label="Asset type"
                  value={readOnly.assetType || ""}
                  readOnly
                />
                <EditField
                  label="Metadata test clone"
                  value={readOnly.metadataTestClone || ""}
                  readOnly
                />
                <EditField
                  label="Test source ID"
                  value={readOnly.metadataTestSourceId || ""}
                  readOnly
                  mono
                />
                {fileStatus && (
                  <p className="yt-card__edit-file-status">{fileStatus}</p>
                )}
              </EditSection>
            </div>
          )}
        </div>

        <div className="yt-card__sync-overlay-footer">
          {saveMessage && (
            <div className="yt-card__sync-banner yt-card__sync-banner--ok">
              {saveMessage}
            </div>
          )}
          {error && (
            <div className="yt-card__sync-banner yt-card__sync-banner--err">
              {error}
            </div>
          )}
          <div className="yt-card__edit-footer-actions">
            <button
              type="button"
              className="btn btn-primary btn--sm"
              disabled={loading || saving || !dirty}
              onClick={() => void handleSave()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn--sm yt-card__sync-dismiss"
              disabled={saving}
              onClick={() => void handleClosePanel()}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
