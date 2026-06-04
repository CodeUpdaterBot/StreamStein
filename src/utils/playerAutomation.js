// Renderer fallback — keep in sync with src/ipc/embedAutomation.js TRIGGER_PLAY_JS

export const TRIGGER_PLAY_JS = `
(() => {
  delete window.__sbAutoPlayDone;
  let clicks = 0;
  const cx = Math.floor((window.innerWidth || 960) / 2);
  const cy = Math.floor((window.innerHeight || 540) / 2);
  const dispatchPointerClick = (el) => {
    if (!el) return false;
    try {
      const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
      for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
        el.dispatchEvent(new MouseEvent(type, opts));
      }
      return true;
    } catch { return false; }
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
    } catch { return false; }
  };
  const playHints = /play|▶|watch now|^watch$|start|continue|tap to play|click to play|press to play/i;
  const serverHints = /^(auto|hd|1080|720|server|vid|embed|stream|default|english|multi)/i;
  const candidates = [
    ...document.querySelectorAll(
      'button, a[href], [role="button"], [onclick], .vjs-big-play-button, .play-btn, .play-button, [class*="play" i], [class*="Play"], svg',
    ),
  ];
  for (const el of candidates) {
    const label = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim().slice(0, 48);
    if (label && playHints.test(label)) tryClick(el);
  }
  for (const el of candidates) {
    const t = (el.textContent || "").trim();
    if (t.length > 0 && t.length < 32 && playHints.test(t)) tryClick(el);
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
      if (video.paused) { const p = video.play(); if (p && p.then) p.catch(() => {}); clicks++; }
      tryClick(video);
    } catch {}
  }
  if (clicks) window.__sbAutoPlayDone = Date.now();
  return clicks;
})()
`;
