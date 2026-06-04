import { storage, STORAGE_KEYS } from "./storage";

export function isYoutubeMetadataTestModeEnabled() {
  return storage.get(STORAGE_KEYS.YOUTUBE_ADMIN_METADATA_TEST) === 1;
}

export function setYoutubeMetadataTestModeEnabled(enabled) {
  storage.set(STORAGE_KEYS.YOUTUBE_ADMIN_METADATA_TEST, enabled ? 1 : 0);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("streamstein-youtube-admin-test-changed", {
        detail: { enabled: !!enabled },
      }),
    );
  }
}
