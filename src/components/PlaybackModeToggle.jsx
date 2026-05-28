/**
 * Toggle between local file and streaming when both are available.
 */
export default function PlaybackModeToggle({
  mode,
  canToggle,
  onSetMode,
  className = "",
}) {
  if (!canToggle) return null;

  return (
    <div
      className={`playback-mode-toggle ${className}`.trim()}
      role="group"
      aria-label="Playback source"
    >
      <button
        type="button"
        className={
          "playback-mode-toggle__btn" +
          (mode === "local" ? " playback-mode-toggle__btn--active" : "")
        }
        onClick={() => onSetMode("local")}
        title="Play local file"
      >
        Local
      </button>
      <button
        type="button"
        className={
          "playback-mode-toggle__btn" +
          (mode === "stream" ? " playback-mode-toggle__btn--active" : "")
        }
        onClick={() => onSetMode("stream")}
        title="Stream online"
      >
        Stream
      </button>
    </div>
  );
}
