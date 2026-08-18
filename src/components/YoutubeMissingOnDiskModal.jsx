import { useEffect } from "react";
import { CloseIcon, ExternalLinkIcon, WarningIcon } from "./Icons";
import {
  getYoutubeChannelLabel,
  getYoutubeWatchUrl,
} from "../utils/youtubeLibrary";

function openYoutubeUrl(url) {
  if (!url) return;
  if (window.electron?.openExternal) {
    window.electron.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export default function YoutubeMissingOnDiskModal({ videos = [], onClose }) {
  const count = videos.length;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!count) {
    return (
      <div
        className="close-confirm-overlay yt-missing-modal-overlay"
        onClick={onClose}
        role="presentation"
      >
        <div
          className="close-confirm-modal yt-missing-modal"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-labelledby="yt-missing-title"
        >
          <div className="close-confirm-title" id="yt-missing-title">
            Missing on disk
          </div>
          <p className="close-confirm-body yt-missing-modal__intro">
            No missing entries are loaded right now. Try refreshing the library.
          </p>
          <div className="close-confirm-actions yt-missing-modal__actions">
            <button
              type="button"
              className="btn close-confirm-btn-cancel yt-missing-modal__close"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="close-confirm-overlay yt-missing-modal-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="close-confirm-modal yt-missing-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="yt-missing-title"
        aria-describedby="yt-missing-desc"
      >
        <div className="close-confirm-icon-wrap">
          <div className="close-confirm-icon-ring yt-missing-modal__icon-ring">
            <WarningIcon size={28} />
          </div>
        </div>

        <div className="close-confirm-title" id="yt-missing-title">
          Missing on disk
        </div>

        <p className="close-confirm-body yt-missing-modal__intro" id="yt-missing-desc">
          These {count} video{count !== 1 ? "s are" : " is"} still in your catalog but
          the file{count !== 1 ? "s were" : " was"} not found at the saved path. Open
          the YouTube link to re-download, then refresh the library.
        </p>

        <ul className="yt-missing-modal__list">
          {videos.map((video) => {
            const watchUrl = getYoutubeWatchUrl(video);
            const channel = getYoutubeChannelLabel(video);
            return (
              <li key={video.id} className="yt-missing-modal__item">
                <div className="yt-missing-modal__item-main">
                  <div className="yt-missing-modal__title" title={video.title}>
                    {video.title || video.fileName || "Untitled video"}
                  </div>
                  <div className="yt-missing-modal__channel" title={channel}>
                    {channel}
                  </div>
                </div>
                {watchUrl ? (
                  <button
                    type="button"
                    className="yt-missing-modal__link-btn"
                    onClick={() => openYoutubeUrl(watchUrl)}
                    title={watchUrl}
                  >
                    <ExternalLinkIcon size={14} />
                    <span>Open on YouTube</span>
                  </button>
                ) : (
                  <span className="yt-missing-modal__no-link">No link saved</span>
                )}
              </li>
            );
          })}
        </ul>

        <div className="close-confirm-actions yt-missing-modal__actions">
          <button
            type="button"
            className="btn close-confirm-btn-cancel yt-missing-modal__close"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <button
          type="button"
          className="yt-missing-modal__dismiss"
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
