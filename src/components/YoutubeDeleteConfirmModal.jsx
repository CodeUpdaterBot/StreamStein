import { TrashIcon } from "./Icons";

export default function YoutubeDeleteConfirmModal({
  videoTitle,
  hasTranscript,
  metadataTestClone = false,
  onConfirm,
  onCancel,
  skipConfirm,
  onSkipConfirmChange,
  busy = false,
}) {
  return (
    <div
      className="close-confirm-overlay"
      onClick={busy ? undefined : onCancel}
      role="presentation"
    >
      <div
        className="close-confirm-modal yt-delete-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="yt-delete-title"
      >
        <div className="close-confirm-icon-wrap">
          <div className="close-confirm-icon-ring yt-delete-modal__icon-ring">
            <TrashIcon />
          </div>
        </div>

        <div className="close-confirm-title" id="yt-delete-title">
          Delete video?
        </div>

        <div className="close-confirm-body yt-delete-modal__body">
          {metadataTestClone ? (
            <>
              Remove metadata test entry <strong>{videoTitle || "This video"}</strong>{" "}
              from the catalog only. The video file on disk will not be deleted.
            </>
          ) : (
            <>
              <strong>{videoTitle || "This video"}</strong> will be permanently deleted
              from your computer
              {hasTranscript ? " along with its transcript" : ""}. This cannot be undone.
            </>
          )}
        </div>

        <label className="yt-delete-modal__skip">
          <input
            type="checkbox"
            checked={!!skipConfirm}
            onChange={(e) => onSkipConfirmChange?.(e.target.checked)}
            disabled={busy}
          />
          <span>Don&apos;t ask again</span>
        </label>

        <div className="close-confirm-actions">
          <button
            type="button"
            className="btn close-confirm-btn-cancel"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn close-confirm-btn-confirm yt-delete-modal__confirm"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
