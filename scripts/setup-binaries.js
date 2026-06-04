#!/usr/bin/env node
/**
 * Download yt-dlp + ffmpeg/ffprobe into resources/bin/<platform>-<arch>/
 * Run once before dev or before `npm run dist:*`:
 *   npm run setup-binaries
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const toolPaths = require("../src/ipc/toolPaths");

const ROOT = path.resolve(__dirname, "..");

const DOWNLOADS = {
  "win32-x64": {
    "yt-dlp.exe":
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
    "ffmpeg.zip":
      "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
  },
  "linux-x64": {
    "yt-dlp":
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp",
    "ffmpeg.tar.xz":
      "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
  },
  "darwin-arm64": {
    "yt-dlp":
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
    "ffmpeg.zip":
      "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-macosarm64-gpl.zip",
  },
  "darwin-x64": {
    "yt-dlp":
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
    "ffmpeg.zip":
      "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-macos64-gpl.zip",
  },
};

async function download(url, dest) {
  console.log(`  ↓ ${path.basename(dest)}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

function extractZip(zipPath, outDir) {
  if (process.platform === "win32") {
    const ps = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: "inherit" },
    );
    if (ps.status !== 0) throw new Error(`Expand-Archive failed for ${zipPath}`);
    return;
  }
  const r = spawnSync("unzip", ["-o", zipPath, "-d", outDir], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`unzip failed for ${zipPath}`);
}

function extractTarXz(archivePath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const r = spawnSync("tar", ["-xJf", archivePath, "-C", outDir], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`tar failed for ${archivePath}`);
}

function findFileRecursive(dir, fileName, depth = 0) {
  if (depth > 6) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === fileName.toLowerCase()) return full;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = findFileRecursive(path.join(dir, e.name), fileName, depth + 1);
    if (found) return found;
  }
  return null;
}

function copyBinary(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dest, 0o755);
    } catch {
      // ignore
    }
  }
}

async function setupPlatform(key) {
  const urls = DOWNLOADS[key];
  if (!urls) {
    console.error(`No download map for ${key}. Supported: ${Object.keys(DOWNLOADS).join(", ")}`);
    process.exit(1);
  }

  const outDir = path.join(ROOT, "resources", "bin", key);
  const tmpDir = path.join(outDir, ".tmp");
  fs.mkdirSync(outDir, { recursive: true });
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  console.log(`\nSetting up ${key} → ${outDir}`);

  if (urls["yt-dlp.exe"] || urls["yt-dlp"]) {
    const ytName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
    await download(urls["yt-dlp.exe"] || urls["yt-dlp"], path.join(outDir, ytName));
    if (process.platform !== "win32") fs.chmodSync(path.join(outDir, ytName), 0o755);
  }

  if (urls["ffmpeg.zip"]) {
    const zipPath = path.join(tmpDir, "ffmpeg.zip");
    await download(urls["ffmpeg.zip"], zipPath);
    extractZip(zipPath, tmpDir);
    const ff = findFileRecursive(tmpDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    const fp = findFileRecursive(tmpDir, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
    if (!ff || !fp) throw new Error("ffmpeg/ffprobe not found in archive");
    copyBinary(ff, path.join(outDir, path.basename(ff)));
    copyBinary(fp, path.join(outDir, path.basename(fp)));
  }

  if (urls["ffmpeg.tar.xz"]) {
    const tarPath = path.join(tmpDir, "ffmpeg.tar.xz");
    await download(urls["ffmpeg.tar.xz"], tarPath);
    extractTarXz(tarPath, tmpDir);
    const ff = findFileRecursive(tmpDir, "ffmpeg");
    const fp = findFileRecursive(tmpDir, "ffprobe");
    if (!ff || !fp) throw new Error("ffmpeg/ffprobe not found in archive");
    copyBinary(ff, path.join(outDir, "ffmpeg"));
    copyBinary(fp, path.join(outDir, "ffprobe"));
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`✓ ${key} ready`);
  for (const f of fs.readdirSync(outDir)) {
    if (f.startsWith(".")) continue;
    const stat = fs.statSync(path.join(outDir, f));
    if (stat.isFile()) console.log(`    ${f} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  }
}

async function main() {
  const key = toolPaths.platformArchKey();
  console.log(`Platform: ${key}`);
  await setupPlatform(key);

  console.log(`
Movie/TV downloader (vid-dl):
  npm run build:vid-dl     # builds from vid-dl-cli-only-2.2.1/ via PyInstaller

YouTube extension bridge deps (bundled in installer):
  npm run setup-bridge     # run via prepare-release before packaging

Launch Streamstein — the bridge starts automatically with the app.
Optional standalone bridge: npm run start:bridge
`);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
