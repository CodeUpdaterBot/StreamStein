// ── Automate embed players (Videasy / VidSrc / 2embed) to start playback ─────
// Mirrors what the user does manually: trigger play + pick a server so m3u8 loads.

const TRIGGER_PLAY_JS = `
(() => {
  delete window.__sbAutoPlayDone;
  let clicks = 0;
  const cx = Math.floor((window.innerWidth || 960) / 2);
  const cy = Math.floor((window.innerHeight || 540) / 2);

  const dispatchPointerClick = (el) => {
    if (!el) return false;
    try {
      const opts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: cx,
        clientY: cy,
        button: 0,
      };
      for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
        el.dispatchEvent(new MouseEvent(type, opts));
      }
      return true;
    } catch {
      return false;
    }
  };

  const tryClick = (el) => {
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      if (typeof el.click === "function") el.click();
      dispatchPointerClick(el);
      clicks++;
      return true;
    } catch {
      return false;
    }
  };

  const playHints =
    /play|▶|watch now|^watch$|start|continue|tap to play|click to play|press to play/i;
  const serverHints =
    /^(auto|hd|1080|720|server|vid|embed|stream|default|english|multi)/i;

  const candidates = [
    ...document.querySelectorAll(
      'button, a[href], [role="button"], [onclick], .vjs-big-play-button, .play-btn, .play-button, [class*="play" i], [class*="Play"], [data-testid*="play" i], svg',
    ),
  ];

  for (const el of candidates) {
    const label = (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.textContent ||
      ""
    )
      .trim()
      .slice(0, 48);
    if (label && playHints.test(label)) tryClick(el);
  }

  for (const el of candidates) {
    const t = (el.textContent || "").trim();
    if (t.length > 0 && t.length < 32 && playHints.test(t)) tryClick(el);
  }

  for (const el of candidates) {
    const t = (el.textContent || "").trim();
    if (t.length > 0 && t.length < 20 && serverHints.test(t)) {
      tryClick(el);
      break;
    }
  }

  let hit = document.elementFromPoint(cx, cy);
  for (let i = 0; i < 8 && hit; i++) {
    if (tryClick(hit)) break;
    hit = hit.parentElement;
  }

  const video = document.querySelector("video");
  if (video) {
    try {
      video.muted = true;
      if (video.paused) {
        const p = video.play();
        if (p && p.then) p.catch(() => {});
        clicks++;
      }
      tryClick(video);
    } catch {}
  }

  const iframe = document.querySelector(
    'iframe[src*="embed"], iframe[src*="player"], iframe',
  );
  if (iframe && iframe.contentWindow) {
    try {
      iframe.contentWindow.postMessage({ type: "play" }, "*");
    } catch {}
  }

  if (clicks) window.__sbAutoPlayDone = Date.now();
  return clicks;
})()
`;

async function runInAllFrames(wc) {
  if (!wc || wc.isDestroyed()) return 0;
  const frames = [];
  const collect = (frame) => {
    frames.push(frame);
    for (const child of frame.frames || []) collect(child);
  };
  try {
    collect(wc.mainFrame);
  } catch {
    return 0;
  }

  let total = 0;
  for (const frame of frames) {
    try {
      const n = await frame.executeJavaScript(TRIGGER_PLAY_JS, true);
      if (typeof n === "number") total += n;
    } catch {}
  }
  return total;
}

/**
 * Simulate a real click at the center of the embed (Videasy overlay play button).
 * @param {import('electron').WebContents} wc
 */
async function clickCenterInWebContents(wc) {
  if (!wc || wc.isDestroyed()) return { ok: false, clicks: 0 };

  let w = 960;
  let h = 540;
  try {
    const dims = await wc.executeJavaScript(
      `({ w: window.innerWidth || 960, h: window.innerHeight || 540 })`,
    );
    if (dims?.w > 0) w = dims.w;
    if (dims?.h > 0) h = dims.h;
  } catch {}

  const x = Math.floor(w / 2);
  const y = Math.floor(h / 2);

  try {
    wc.focus();
  } catch {}

  try {
    wc.sendInputEvent({ type: "mouseMove", x, y });
    wc.sendInputEvent({
      type: "mouseDown",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    wc.sendInputEvent({
      type: "mouseUp",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  } catch {}

  try {
    wc.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    wc.sendInputEvent({ type: "keyUp", keyCode: "Space" });
  } catch {}

  const clicks = await runInAllFrames(wc);
  return { ok: true, clicks };
}

/**
 * Full play trigger: reset throttle, center click, frame script.
 * @param {import('electron').WebContents} wc
 */
async function triggerEmbedPlayback(wc) {
  if (!wc || wc.isDestroyed()) return { ok: false, clicks: 0 };
  try {
    await wc.executeJavaScript("delete window.__sbAutoPlayDone");
  } catch {}
  const center = await clickCenterInWebContents(wc);
  return center;
}

/**
 * Poll embed UI after navigation — same flow as user opening the player and pressing play.
 * @param {import('electron').WebContents} wc
 * @param {number} durationMs
 * @param {number} intervalMs
 */
function scheduleEmbedAutomation(wc, durationMs = 28000, intervalMs = 2000) {
  if (!wc || wc.isDestroyed()) return () => {};

  let elapsed = 0;
  const tick = () => {
    if (wc.isDestroyed()) return;
    triggerEmbedPlayback(wc).catch(() => {});
  };

  tick();
  const id = setInterval(() => {
    elapsed += intervalMs;
    if (wc.isDestroyed() || elapsed >= durationMs) {
      clearInterval(id);
      return;
    }
    tick();
  }, intervalMs);

  const onReady = () => tick();
  wc.on("dom-ready", onReady);

  return () => {
    clearInterval(id);
    try {
      wc.removeListener("dom-ready", onReady);
    } catch {}
  };
}

module.exports = {
  runInAllFrames,
  scheduleEmbedAutomation,
  TRIGGER_PLAY_JS,
  clickCenterInWebContents,
  triggerEmbedPlayback,
};
