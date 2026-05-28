import { storage, STORAGE_KEYS } from "./storage";

/** Whether to scan for cast devices when a page mounts (Settings → Cast). */
export function castAutoDiscoverEnabled() {
  return storage.get(STORAGE_KEYS.CAST_AUTO_DISCOVER) ?? true;
}

/** Connect to the preferred device and load media; returns true on success. */
export async function connectPreferredAndLoad(cast, loadArgs) {
  if (!loadArgs) return false;
  const prefId = storage.get(STORAGE_KEYS.CAST_PREFERRED_DEVICE_ID);
  if (!prefId) return false;
  const r = await cast.connect(prefId);
  if (!r?.ok) return false;
  const lr = await cast.load(loadArgs);
  return !!lr?.ok;
}
