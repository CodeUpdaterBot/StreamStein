/**
 * Verify /live/ URL support using the ACTUAL functions in the extension files.
 *
 * The popup and background scripts are browser scripts (no module exports), so this pulls
 * each function's balanced-brace block out of the source and evals it. That way the test
 * exercises the shipped code, not a transcription of it - a copy could pass while the real
 * function stayed broken.
 *
 * Usage: node scripts/verify-live-url-support.cjs
 */
const fs = require("fs");
const path = require("path");

const EXT = path.join(__dirname, "..", "YoutubeDownloaderExtension");

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  let depth = 0;
  let i = src.indexOf("{", start);
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${name}`);
}

const popupSrc = fs.readFileSync(path.join(EXT, "popup", "popup.js"), "utf8");
const bgSrc = fs.readFileSync(path.join(EXT, "background.js"), "utf8");

const popupApi = new Function(
  [
    extractFunction(popupSrc, "isYouTubeWatchUrl"),
    extractFunction(popupSrc, "extractVideoId"),
    extractFunction(popupSrc, "canonicalWatchUrl"),
    "return { isYouTubeWatchUrl, extractVideoId, canonicalWatchUrl };",
  ].join("\n"),
)();

const bgApi = new Function(
  [extractFunction(bgSrc, "extractVideoId"), "return { extractVideoId };"].join("\n"),
)();

const ID = "AYivz_QumFo";
const cases = [
  ["live page (the reported one)", `https://www.youtube.com/live/${ID}`, true, ID],
  ["classic watch page", `https://www.youtube.com/watch?v=${ID}`, true, ID],
  ["watch page with extras", `https://www.youtube.com/watch?v=${ID}&t=42s&list=PL1`, true, ID],
  ["shorts", "https://www.youtube.com/shorts/abc12345678", true, "abc12345678"],
  ["short link", `https://youtu.be/${ID}`, true, ID],
  ["live with tracking junk", `https://www.youtube.com/live/${ID}?si=xyz&feature=share`, true, ID],
  ["channel page (must stay rejected)", "https://www.youtube.com/@ShaunAttwood/videos", false, null],
  ["non-video live path", "https://www.youtube.com/live", false, null],
  // extractVideoId is deliberately host-agnostic: it is only ever called AFTER the host
  // gate in isYouTubeWatchUrl, and background.js may pass it a non-canonical string (hence
  // its `?v=` regex fallback). So the gate is what must say false here; the id it happens to
  // pull out of a foreign URL is unused. Asserting the gate is the real guard.
  ["another site (gate must reject)", "https://example.com/watch?v=abc", false, "abc"],
];

let fail = 0;
console.log("popup: isYouTubeWatchUrl / extractVideoId / canonicalWatchUrl");
for (const [label, url, wantDetect, wantId] of cases) {
  const gotDetect = popupApi.isYouTubeWatchUrl(url);
  const gotId = popupApi.extractVideoId(url);
  const isGateCase = label.startsWith("another site");
  const ok = isGateCase
    ? gotDetect === wantDetect
    : gotDetect === wantDetect && (gotId || null) === wantId;
  if (!ok) fail++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(34)} detect=${String(gotDetect).padEnd(5)} id=${String(gotId)}`,
  );
}

console.log("\nbackground: extractVideoId");
for (const [label, url, , wantId] of cases) {
  const gotId = bgApi.extractVideoId(url);
  const ok = (gotId || null) === wantId;
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(34)} id=${String(gotId)}`);
}

console.log("\ncanonicalWatchUrl (one video must not be stored under two URLs)");
const canon = popupApi.canonicalWatchUrl(`https://www.youtube.com/live/${ID}`);
const canonOk = canon === `https://www.youtube.com/watch?v=${ID}`;
if (!canonOk) fail++;
console.log(`  ${canonOk ? "PASS" : "FAIL"}  /live/${ID} -> ${canon}`);
const untouched = popupApi.canonicalWatchUrl("https://www.youtube.com/@x/videos");
const untouchedOk = untouched === "https://www.youtube.com/@x/videos";
if (!untouchedOk) fail++;
console.log(`  ${untouchedOk ? "PASS" : "FAIL"}  non-video URL left alone`);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
