/** Pick the best HLS/MP4 URL from intercepted candidates (same logic as main-process resolver). */

export function qualityScore(url) {
  const u = String(url).toLowerCase();
  if (/preview|trailer|sample|thumb/i.test(u)) return -100;
  if (/1080|1920x|2160|4k/.test(u)) return 100;
  if (/720/.test(u)) return 72;
  if (/480/.test(u)) return 48;
  if (/360/.test(u)) return 30;
  if (/\.m3u8/.test(u)) return 55;
  if (/\.mp4/.test(u)) return 60;
  return 20;
}

export function pickBestMediaUrl(urls) {
  const uniq = [...new Set((urls || []).filter(Boolean))];
  if (!uniq.length) return null;
  uniq.sort((a, b) => qualityScore(b) - qualityScore(a));
  const best = uniq[0];
  if (qualityScore(best) < 48) {
    const hd = uniq.find((u) => qualityScore(u) >= 72);
    if (hd) return hd;
  }
  return best;
}
