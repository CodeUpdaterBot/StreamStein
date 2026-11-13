#!/usr/bin/env node
/**
 * Verify the download error-classification rules against the REAL log lines from the two
 * failures (2026-11-13), by extracting the shipped predicates out of the source rather than
 * retyping them - a transcribed copy could pass while the shipped code stays broken.
 *
 * Guards two regressions:
 *  1. downloads.js used to SIGKILL the download on `got error:.*fragment`, so a self-healing
 *     yt-dlp retry notice ("Got error: HTTP Error 429... Retrying fragment 3 (1/100)...")
 *     killed the job at fragment 3. Retry notices must NOT be fatal; terminal output must be.
 *  2. hlsSessionDownload.js had no retries, so one 429/503/ERR_FAILED aborted the whole
 *     download. Those must classify as retryable; a cancel must not.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const DL = path.join(root, "src", "ipc", "downloads.js");
const HLS = path.join(root, "src", "ipc", "hlsSessionDownload.js");

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${expected}, got ${actual}`);
  ok ? pass++ : fail++;
}

// ── extract the shipped predicates ──────────────────────────────────────────────────────
function extract(file, pattern, label) {
  const src = fs.readFileSync(file, "utf8");
  const m = src.match(pattern);
  if (!m) {
    console.error(`  FATAL could not extract ${label} from ${path.basename(file)}`);
    process.exit(2);
  }
  return m[1].trim();
}

const retryNoticeSrc = extract(
  DL,
  /const isRetryNotice = (\/[^\n]*?\/[a-z]*)\.test\(trimmed\);/,
  "isRetryNotice",
);
const fatalSrc = extract(
  DL,
  /const isFatalFragmentError =\r?\n([\s\S]*?);\r?\n\s*if \(isFatalFragmentError\)/,
  "isFatalFragmentError",
);
const retryableSrc = extract(
  HLS,
  /function isRetryableFetchError\(err\) \{\r?\n([\s\S]*?)\r?\n\}/,
  "isRetryableFetchError",
);

const isRetryNotice = eval(retryNoticeSrc);
const isFatal = new Function("trimmed", "isRetryNotice", `return ${fatalSrc};`);
const isRetryable = new Function("err", retryableSrc);

// Compose exactly as downloads.js does: it computes the retry flag from the same line and
// passes it in, so the harness must too (passing a hardcoded flag tested the harness, not the code).
const classify = (line) => isFatal(line, isRetryNotice.test(line));

console.log("failure 1 - The Outer Limits (duskanddawn CDN, 429 at fragment 3)\n");
// verbatim from the user's log
check(
  'yt-dlp retry notice is NOT fatal  "[download] Got error: HTTP Error 429: Too Many Requests. Retrying fragment 3 (1/100)..."',
  classify("[download] Got error: HTTP Error 429: Too Many Requests. Retrying fragment 3 (1/100)..."),
  false,
);
check(
  'the same line with its progress prefix is NOT fatal',
  classify("Downloading: 0.2%  8 KB/s   [download] Got error: HTTP Error 429: Too Many Requests. Retrying fragment 3 (1/100)..."),
  false,
);
check(
  'yt-dlp backoff line is NOT fatal  "[yt-dlp DEBUG] Sleeping 3.00 seconds ..."',
  classify("[yt-dlp DEBUG] Sleeping 3.00 seconds ..."),
  false,
);

console.log("\nfailure 2 - Westworld (403 on the playlist)\n");
check(
  'terminal error IS fatal  "Download failed: ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden"',
  classify("Download failed: ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden (caused by <HTTPError 403: Forbidden>)"),
  true,
);
check(
  'exhausted retries IS fatal  "ERROR: fragment 3 not found, unable to continue"',
  classify("ERROR: fragment 3 not found, unable to continue"),
  true,
);

console.log("\nsession-HLS retry classification\n");
check("net::ERR_FAILED is retryable (failure 1)", isRetryable(new Error("net::ERR_FAILED")), true);
check("HTTP 503 is retryable (failure 2)", isRetryable(new Error("HTTP 503 fetching https://sun1.finalsignal.top/x.js")), true);
check("HTTP 429 is retryable", isRetryable(new Error("HTTP 429 fetching https://cdn/seg_00001.ts")), true);
check("a cancel is NOT retryable", isRetryable(new Error("Cancelled")), false);
check("a 404 is NOT retryable", isRetryable(new Error("HTTP 404 fetching https://cdn/missing.ts")), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
