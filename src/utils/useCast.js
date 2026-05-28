import { useCallback, useEffect, useRef, useState } from "react";
import { storage, STORAGE_KEYS } from "./storage";
import { castAutoDiscoverEnabled } from "./castUtils";

// Discovery options derived from user settings (gate DLNA SSDP if disabled).
const discoveryOpts = (force = false) => ({
  enableDlna: storage.get(STORAGE_KEYS.CAST_ENABLE_DLNA) ?? true,
  force,
});

const DISCOVER_MAX_MS = 12000;
const DISCOVER_QUIET_MS = 1800;
const DISCOVER_POLL_MS = 350;

/**
 * Casting state + control hook. Subscribes to main-process cast IPC.
 *
 * Discovery is on-demand: nothing scans the network until `startDiscovery()`
 * is called (the picker / settings do this when opened). The active session's
 * device is tracked independently of the live discovery list, so the overlay
 * and controls keep working even while discovery is stopped.
 */
export function useCast({ autoDiscover } = {}) {
  const shouldAutoDiscover =
    autoDiscover !== undefined ? autoDiscover : castAutoDiscoverEnabled();
  const [devices, setDevices] = useState([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [connectedDevice, setConnectedDevice] = useState(null);
  const [sessionState, setSessionState] = useState("idle");
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [lastError, setLastError] = useState(null);

  const mountedRef = useRef(true);
  const devicesRef = useRef([]);
  devicesRef.current = devices;
  const discoverPollRef = useRef(null);
  const discoverStartRef = useRef(0);
  const lastDeviceAtRef = useRef(0);

  const stopDiscoveringPoll = () => {
    if (discoverPollRef.current) {
      clearInterval(discoverPollRef.current);
      discoverPollRef.current = null;
    }
  };

  const maybeEndDiscovering = () => {
    if (!mountedRef.current) return;
    const elapsed = Date.now() - discoverStartRef.current;
    const quietFor = Date.now() - lastDeviceAtRef.current;
    const hasDevices = devicesRef.current.length > 0;
    if (elapsed >= DISCOVER_MAX_MS || (hasDevices && quietFor >= DISCOVER_QUIET_MS)) {
      setIsDiscovering(false);
      stopDiscoveringPoll();
    }
  };

  const runDiscovery = (force = false) => {
    if (!window.electron?.castStartDiscovery) return;
    discoverStartRef.current = Date.now();
    lastDeviceAtRef.current = discoverStartRef.current;
    setIsDiscovering(true);
    stopDiscoveringPoll();

    Promise.resolve(window.electron.castStartDiscovery(discoveryOpts(force)))
      .then((r) => {
        if (!mountedRef.current || !Array.isArray(r?.devices)) return;
        if (r.devices.length) {
          setDevices(r.devices);
          lastDeviceAtRef.current = Date.now();
        }
      })
      .catch(() => {});

    window.electron.castListDevices?.().then((list) => {
      if (!mountedRef.current || !Array.isArray(list) || !list.length) return;
      setDevices(list);
      lastDeviceAtRef.current = Date.now();
    });

    discoverPollRef.current = setInterval(maybeEndDiscovering, DISCOVER_POLL_MS);
  };

  useEffect(() => {
    if (!window.electron) return;
    mountedRef.current = true;

    const devH = window.electron.onCastDevicesUpdated?.((list) => {
      if (!mountedRef.current) return;
      const next = Array.isArray(list) ? list : [];
      setDevices(next);
      if (next.length) lastDeviceAtRef.current = Date.now();
    });
    const statusH = window.electron.onCastStatus?.((s) => {
      if (!mountedRef.current || !s) return;
      setSessionState(s.sessionState || "idle");
      if (Number.isFinite(s.currentTime)) setPosition(s.currentTime);
      if (Number.isFinite(s.duration) && s.duration > 0) setDuration(s.duration);
      if (Number.isFinite(s.volume)) setVolume(s.volume);
      if (typeof s.muted === "boolean") setMuted(s.muted);
    });
    const endedH = window.electron.onCastSessionEnded?.(() => {
      if (!mountedRef.current) return;
      setSessionState("idle");
      setConnectedDevice(null);
      setPosition(0);
      setDuration(0);
    });
    const errH = window.electron.onCastError?.((e) => {
      if (!mountedRef.current) return;
      setLastError(e?.message || "Cast error");
    });

    if (shouldAutoDiscover) runDiscovery();

    return () => {
      mountedRef.current = false;
      stopDiscoveringPoll();
      if (devH) window.electron.offCastDevicesUpdated?.(devH);
      if (statusH) window.electron.offCastStatus?.(statusH);
      if (endedH) window.electron.offCastSessionEnded?.(endedH);
      if (errH) window.electron.offCastError?.(errH);
    };
  }, [shouldAutoDiscover]);

  useEffect(() => {
    if (sessionState === "idle") return;
    const t = setInterval(async () => {
      try {
        const s = await window.electron?.castGetStatus?.();
        if (!mountedRef.current || !s) return;
        if (Number.isFinite(s.currentTime)) setPosition(s.currentTime);
        if (Number.isFinite(s.duration) && s.duration > 0) setDuration(s.duration);
      } catch {}
    }, 5000);
    return () => clearInterval(t);
  }, [sessionState]);

  const currentDevice = connectedDevice;

  const startDiscovery = useCallback((opts = {}) => {
    runDiscovery(!!opts.force);
  }, []);

  const stopDiscovery = useCallback(async () => {
    await window.electron?.castStopDiscovery?.();
  }, []);

  const connect = useCallback(async (deviceId) => {
    setLastError(null);
    setSessionState("connecting");
    const device =
      devicesRef.current.find((d) => d.id === deviceId) ||
      { id: deviceId, name: deviceId, type: "cast" };
    setConnectedDevice(device);
    const r = await window.electron?.castConnect?.(deviceId);
    if (!r?.ok) {
      setSessionState("idle");
      setConnectedDevice(null);
      setLastError(r?.error || "Connect failed");
    }
    return r;
  }, []);

  const disconnect = useCallback(async () => {
    const r = await window.electron?.castDisconnect?.();
    setSessionState("idle");
    setConnectedDevice(null);
    setPosition(0);
    setDuration(0);
    return r;
  }, []);

  const load = useCallback(async (args) => {
    setLastError(null);
    const r = await window.electron?.castLoad?.(args);
    if (!r?.ok) setLastError(r?.error || "Load failed");
    return r;
  }, []);

  const play = useCallback(() => window.electron?.castPlay?.(), []);
  const pause = useCallback(() => window.electron?.castPause?.(), []);
  const stop = useCallback(() => window.electron?.castStop?.(), []);
  const seek = useCallback(
    (sec) => window.electron?.castSeek?.(Number(sec) || 0),
    [],
  );
  const setCastVolume = useCallback(
    (lvl) =>
      window.electron?.castSetVolume?.(
        Math.max(0, Math.min(1, Number(lvl) || 0)),
      ),
    [],
  );
  const setCastMute = useCallback(
    (m) => window.electron?.castSetMute?.(!!m),
    [],
  );
  const setSubtitleTrack = useCallback(
    (trackIndex) =>
      window.electron?.castSetSubtitleTrack?.(
        trackIndex == null ? null : Number(trackIndex),
      ),
    [],
  );

  return {
    devices,
    isDiscovering,
    currentDevice,
    sessionState,
    position,
    duration,
    volume,
    muted,
    lastError,
    startDiscovery,
    stopDiscovery,
    connect,
    disconnect,
    load,
    play,
    pause,
    stop,
    seek,
    setVolume: setCastVolume,
    setMute: setCastMute,
    setSubtitleTrack,
  };
}
