import { WarningIcon } from "./Icons";

const EXTENSION_PITCH =
  "We have a YouTube Extension to easily download YouTube videos as you browse.";

export default function YoutubeEmptyState({
  variant = "no-catalog",
  onOpenSettings,
  onRefresh,
  refreshing = false,
}) {
  const hasCatalog = variant === "empty-catalog";
  const detail = hasCatalog
    ? "Your library folder is set up, but no videos appear in the catalog yet. If you already have .mp4 files in your YouTube folder, click Refresh to import them. Otherwise use the Downloader Extension on a YouTube page while Streamstein is running."
    : "Streamstein comes with a Chrome extension to download Youtube videos (See Settings → YouTube to configure) so you can easily save videos to your local Streamstein library. Just add the extension to your browser, click Extension setup below for instructions.";

  return (
    <div className="yt-empty">
      <div className="yt-empty__card">
        <div className="yt-empty__icon-ring" aria-hidden>
          <WarningIcon size={28} />
        </div>
        <h2 className="yt-empty__heading">No YouTube content found</h2>
        <p className="yt-empty__pitch">{EXTENSION_PITCH}</p>
        <p className="yt-empty__text">{detail}</p>
        <div className="yt-empty__actions">
          <button
            type="button"
            className="btn btn-primary btn--sm"
            onClick={() => onOpenSettings?.("youtube")}
          >
            Extension setup
          </button>
          {onRefresh && (
            <button
              type="button"
              className="btn btn-secondary btn--sm"
              onClick={onRefresh}
              disabled={refreshing}
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          )}
        </div>
        <p className="yt-empty__hint">
          Not using YouTube? Hide this tab in{" "}
          <button
            type="button"
            className="yt-empty__hint-link"
            onClick={() => onOpenSettings?.("interface")}
          >
            Settings → Interface → Sidebar
          </button>
          .
        </p>
      </div>
    </div>
  );
}
