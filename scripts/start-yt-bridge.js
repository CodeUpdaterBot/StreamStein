#!/usr/bin/env node
/**
 * Optional: start the YouTube bridge standalone (same server Streamstein auto-starts).
 * Normally you only need: npm start  (or launch the installed Streamstein app)
 *
 *   npm run start:bridge
 */

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const toolPaths = require("../src/ipc/toolPaths");

function ensureBridgeDeps(bridgeRoot) {
  const nm = path.join(bridgeRoot, "node_modules");
  if (fs.existsSync(path.join(nm, "fastify"))) return;

  console.log("Installing yt-saver-bridge dependencies (first run)…");
  const r =
    process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", "npm install --omit=dev"], {
          cwd: bridgeRoot,
          stdio: "inherit",
          windowsHide: true,
        })
      : spawnSync("npm", ["install", "--omit=dev"], {
          cwd: bridgeRoot,
          stdio: "inherit",
          windowsHide: true,
          shell: false,
        });
  if (r.error) {
    console.error("Failed to run npm install:", r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error("npm install failed in yt-saver-bridge");
    process.exit(r.status || 1);
  }
}

function main() {
  const status = toolPaths.publishBundledEnv();
  const bridgeRoot = status.bridgeRoot;

  if (!fs.existsSync(path.join(bridgeRoot, "server.js"))) {
    console.error(`Bridge not found: ${bridgeRoot}`);
    console.error("Expected YoutubeDownloaderExtension/yt-saver-bridge/server.js");
    process.exit(1);
  }

  console.log("Streamstein YouTube bridge (standalone)");
  console.log("  Tip: launching Streamstein starts this automatically.");
  console.log(`  Bridge:   ${bridgeRoot}`);
  console.log(`  Bin dir:  ${status.bundledBinDir || "(system PATH fallback)"}`);
  console.log(`  yt-dlp:   ${status.ytDlp || "not found"}`);
  console.log(`  ffmpeg:   ${status.ffmpeg || "not found"}`);
  console.log(`  URL:      http://127.0.0.1:8789`);
  console.log("");

  ensureBridgeDeps(bridgeRoot);

  const isElectronRuntime = Boolean(process.versions.electron);
  const runner = isElectronRuntime
    ? process.execPath
    : process.platform === "win32"
      ? "node.exe"
      : "node";
  const env = {
    ...process.env,
    STREAMSTEIN_BIN_DIR: status.bundledBinDir || process.env.STREAMSTEIN_BIN_DIR || "",
    STREAMSTEIN_EXTENSION_ROOT: status.extensionRoot,
    STREAMSTEIN_BRIDGE_ROOT: bridgeRoot,
  };
  if (isElectronRuntime) env.ELECTRON_RUN_AS_NODE = "1";

  const child = spawn(runner, ["server.js"], {
    cwd: bridgeRoot,
    env,
    stdio: "inherit",
  });

  child.on("exit", (code) => process.exit(code ?? 0));
}

main();
