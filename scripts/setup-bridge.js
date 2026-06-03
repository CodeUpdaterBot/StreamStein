#!/usr/bin/env node
/**
 * Install yt-saver-bridge production deps and remove accidental project self-links.
 * The bridge must NOT depend on "streamstein": "file:../.." — that nests the entire
 * app (electron, ffmpeg, dist/) inside node_modules and blows up NSIS packaging.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const bridgeRoot = path.join(root, "YoutubeDownloaderExtension", "yt-saver-bridge");
const nestedStreamstein = path.join(bridgeRoot, "node_modules", "streamstein");

if (!fs.existsSync(path.join(bridgeRoot, "package.json"))) {
  console.error("Missing yt-saver-bridge package.json");
  process.exit(1);
}

function runNpmInstall(cwd) {
  // Do not use npm --prefix — paths with spaces/parens break argument parsing.
  // Do not spawn npm.cmd with shell:false — .cmd files need cmd.exe on Windows.
  if (process.platform === "win32") {
    return spawnSync("cmd.exe", ["/d", "/s", "/c", "npm install --omit=dev"], {
      cwd,
      stdio: "inherit",
      windowsHide: true,
    });
  }
  return spawnSync("npm", ["install", "--omit=dev"], {
    cwd,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
}

console.log("Installing yt-saver-bridge dependencies…");
const r = runNpmInstall(bridgeRoot);

if (r.error) {
  console.error("Failed to run npm install:", r.error.message);
  process.exit(1);
}
if (r.status !== 0) {
  console.error(`npm install failed (exit ${r.status ?? "unknown"})`);
  process.exit(r.status ?? 1);
}

if (fs.existsSync(nestedStreamstein)) {
  console.warn(
    "Removing nested node_modules/streamstein (file:../.. self-link — not used by the bridge).",
  );
  fs.rmSync(nestedStreamstein, { recursive: true, force: true });
}

const fastify = path.join(bridgeRoot, "node_modules", "fastify");
if (!fs.existsSync(fastify)) {
  console.error("Bridge install failed: fastify not found in node_modules.");
  process.exit(1);
}

console.log("✓ yt-saver-bridge ready");
