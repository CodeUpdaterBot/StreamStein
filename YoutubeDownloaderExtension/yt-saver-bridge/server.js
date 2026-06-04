import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { spawn, spawnSync } from "node:child_process";
import { LocalStorage } from "node-localstorage";
import { Innertube, Platform, UniversalCache, Log } from "youtubei.js";
import OpenAI from "openai";
import { createYoutubeCatalogStore } from "./youtube-catalog.js";

/** Parsed by Streamstein main process (ytBridge) to refresh the YouTube library UI. */
const YOUTUBE_CATALOG_UPDATED_PREFIX = "__STREAMSTEIN_YOUTUBE_CATALOG_UPDATED__";

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));

function notifyYoutubeCatalogUpdated(detail = {}) {
  try {
    const payload = {
      at: Date.now(),
      ...detail
    };
    console.log(YOUTUBE_CATALOG_UPDATED_PREFIX + JSON.stringify(payload));
  } catch {
    // ignore notification failures
  }
}

function bundledToolPath(name) {
  const dir = process.env.STREAMSTEIN_BIN_DIR;
  if (!dir) return null;
  const file = path.join(dir, process.platform === "win32" ? `${name}.exe` : name);
  return fs.existsSync(file) ? file : null;
}

function defaultYtDlpCommand() {
  return bundledToolPath("yt-dlp") || "yt-dlp";
}

function defaultFfmpegPath() {
  return bundledToolPath("ffmpeg") || "";
}

/** Node executable for yt-dlp's YouTube JS challenge solver (EJS). */
function resolveNodeJsRuntimePath() {
  const fromEnv = process.env.STREAMSTEIN_NODE;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  if (process.env.ELECTRON_RUN_AS_NODE === "1" && process.execPath) {
    return process.execPath;
  }
  return "node";
}

function getYtDlpJsRuntimeArgs() {
  const nodePath = resolveNodeJsRuntimePath();
  if (nodePath !== "node") {
    return ["--js-runtimes", `node:${nodePath}`];
  }
  return ["--js-runtimes", "node"];
}

function buildToolSpawnEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  const binDir = process.env.STREAMSTEIN_BIN_DIR;
  if (binDir) {
    const prefix = path.resolve(binDir);
    const pathKey = process.platform === "win32" ? "Path" : "PATH";
    const current = env[pathKey] || env.PATH || "";
    if (!current.toLowerCase().includes(prefix.toLowerCase())) {
      env[pathKey] = `${prefix}${path.delimiter}${current}`;
    }
  }
  const nodePath = resolveNodeJsRuntimePath();
  if (nodePath !== "node" && fs.existsSync(nodePath)) {
    env.ELECTRON_RUN_AS_NODE = "1";
    env.STREAMSTEIN_NODE = nodePath;
  }
  return env;
}

function spawnTool(cmd, args, options = {}) {
  return spawn(cmd, args, {
    ...options,
    env: buildToolSpawnEnv(options.env),
  });
}

function resolveYtDlpCommand() {
  const bundled = bundledToolPath("yt-dlp");
  const configured =
    typeof serverConfig.ytDlpCommand === "string" ? serverConfig.ytDlpCommand.trim() : "";
  if (configured) {
    if (configured === "yt-dlp" || configured === "yt-dlp.exe") {
      return bundled || configured;
    }
    if (fs.existsSync(configured)) return configured;
  }
  return bundled || configured || "yt-dlp";
}

function applyBundledToolDefaults() {
  const bundledYt = bundledToolPath("yt-dlp");
  const bundledFf = bundledToolPath("ffmpeg");
  if (bundledYt) {
    const current =
      typeof serverConfig.ytDlpCommand === "string" ? serverConfig.ytDlpCommand.trim() : "";
    if (!current || current === "yt-dlp" || current === "yt-dlp.exe" || !fs.existsSync(current)) {
      serverConfig.ytDlpCommand = bundledYt;
    }
  }
  if (bundledFf) {
    const current = serverConfig.ffmpegPath;
    if (!current || (current !== "ffmpeg" && !fs.existsSync(current))) {
      serverConfig.ffmpegPath = bundledFf;
    }
  }
}

let whisperEnvCache = null;
let whisperEnvDetectPromise = null;

function pathExistsOnPath(command) {
  try {
    const lookupCmd = process.platform === "win32" ? "where" : "which";
    const r = spawnSync(lookupCmd, [command], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true
    });
    if (r.status !== 0 || !r.stdout?.trim()) return [];
    return r.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function candidateWhisperPythonExecutables() {
  const seen = new Set();
  const ordered = [];
  const add = (value) => {
    if (!value || typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    if (trimmed !== "python" && trimmed !== "python3" && trimmed !== "py" && !fs.existsSync(trimmed)) {
      return;
    }
    seen.add(key);
    ordered.push(trimmed);
  };

  const configured =
    typeof serverConfig.whisperCommand === "string" ? serverConfig.whisperCommand.trim() : "";
  if (configured) {
    const tokens = tokenizeCommand(configured);
    if (tokens.length) add(tokens[0]);
  }

  const fromEnv =
    typeof process.env.STREAMSTEIN_WHISPER_COMMAND === "string"
      ? process.env.STREAMSTEIN_WHISPER_COMMAND.trim()
      : "";
  if (fromEnv) {
    const tokens = tokenizeCommand(fromEnv);
    if (tokens.length) add(tokens[0]);
  }

  if (process.env.CONDA_PREFIX) {
    const condaPy = path.join(process.env.CONDA_PREFIX, process.platform === "win32" ? "python.exe" : "bin/python");
    add(condaPy);
  }

  const home = os.homedir();
  const condaRoots = [
    path.join(home, "miniconda3"),
    path.join(home, "Miniconda3"),
    path.join(home, "anaconda3"),
    path.join(home, "Anaconda3"),
    "C:\\ProgramData\\miniconda3",
    "C:\\ProgramData\\anaconda3"
  ];
  const condaEnvNames = ["voiceai", "whisper", "base"];
  for (const root of condaRoots) {
    for (const envName of condaEnvNames) {
      add(
        path.join(
          root,
          "envs",
          envName,
          process.platform === "win32" ? "python.exe" : "bin/python"
        )
      );
    }
    add(path.join(root, process.platform === "win32" ? "python.exe" : "bin/python"));
  }

  for (const found of pathExistsOnPath("whisper")) add(found);
  for (const found of pathExistsOnPath("python")) add(found);
  for (const found of pathExistsOnPath("python3")) add(found);
  for (const found of pathExistsOnPath("py")) add(found);

  add("py");
  add("python");
  add("python3");

  return ordered;
}

async function probePythonWhisperModules(pythonCmd) {
  const script = [
    "import json",
    "info = {'whisper': False, 'faster_whisper': False, 'torch_version': None, 'cuda_available': False, 'device': 'no cuda device'}",
    "try:",
    " import torch",
    " info['torch_version'] = getattr(torch, '__version__', None)",
    " info['cuda_available'] = bool(torch.cuda.is_available())",
    " if info['cuda_available']:",
    "  info['device'] = torch.cuda.get_device_name(0)",
    "except Exception:",
    " pass",
    "try:",
    " import whisper",
    " info['whisper'] = True",
    "except Exception:",
    " pass",
    "try:",
    " import faster_whisper",
    " info['faster_whisper'] = True",
    " if not info['cuda_available']:",
    "  import ctranslate2",
    "  n = getattr(ctranslate2, 'get_cuda_device_count', lambda: 0)()",
    "  if isinstance(n, int) and n > 0:",
    "    info['cuda_available'] = True",
    "    info['device'] = 'CUDA (CT2)'",
    "except Exception:",
    " pass",
    "print(json.dumps(info))"
  ].join("\n");
  try {
    const { stdout } = await execOnce(pythonCmd, ["-c", script], {});
    const parsed = JSON.parse(stdout || "{}");
    return {
      pythonCmd,
      whisper: Boolean(parsed.whisper),
      fasterWhisper: Boolean(parsed.faster_whisper),
      torchVersion: parsed.torch_version || null,
      cudaAvailable: Boolean(parsed.cuda_available),
      device: parsed.device || null
    };
  } catch {
    return null;
  }
}

async function detectWhisperEnvironment({ force = false } = {}) {
  if (!force && whisperEnvCache) return whisperEnvCache;
  if (!force && whisperEnvDetectPromise) return whisperEnvDetectPromise;

  whisperEnvDetectPromise = (async () => {
    let best = null;
    for (const pythonCmd of candidateWhisperPythonExecutables()) {
      const probe = await probePythonWhisperModules(pythonCmd);
      if (!probe || (!probe.whisper && !probe.fasterWhisper)) continue;
      if (
        !best ||
        (probe.whisper && !best.whisper) ||
        (probe.cudaAvailable && !best.cudaAvailable) ||
        (probe.fasterWhisper && !best.fasterWhisper && !best.whisper)
      ) {
        best = probe;
      }
      if (probe.whisper && probe.cudaAvailable) break;
    }

    if (!best) {
      whisperEnvCache = {
        pythonCmd: null,
        whisper: false,
        fasterWhisper: false,
        torchVersion: null,
        cudaAvailable: false,
        device: null,
        whisperCommand: "",
        autoDetected: false
      };
      return whisperEnvCache;
    }

    whisperEnvCache = {
      ...best,
      whisperCommand: best.whisper ? `${best.pythonCmd} -m whisper` : "",
      autoDetected: !(
        typeof serverConfig.whisperCommand === "string" && serverConfig.whisperCommand.trim()
      )
    };
    return whisperEnvCache;
  })();

  try {
    return await whisperEnvDetectPromise;
  } finally {
    whisperEnvDetectPromise = null;
  }
}

function getResolvedWhisperPythonCmd() {
  const configured =
    typeof serverConfig.whisperCommand === "string" ? serverConfig.whisperCommand.trim() : "";
  if (configured) {
    const tokens = tokenizeCommand(configured);
    if (tokens.length) return tokens[0];
  }
  if (whisperEnvCache?.pythonCmd) return whisperEnvCache.pythonCmd;
  return "python";
}

async function applyWhisperDefaults() {
  const configured =
    typeof serverConfig.whisperCommand === "string" ? serverConfig.whisperCommand.trim() : "";
  const detected = await detectWhisperEnvironment();
  if (!detected.whisper && !detected.fasterWhisper) return detected;

  if (!configured && detected.whisperCommand) {
    serverConfig.whisperCommand = detected.whisperCommand;
    persistServerConfig();
    fastify.log.info(
      { whisperCommand: detected.whisperCommand, python: detected.pythonCmd },
      "Auto-detected Whisper Python environment"
    );
  }
  return detected;
}

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";
const fastify = Fastify({ logger: true });
const projectRoot = process.cwd();
const downloadsDir = path.join(os.homedir(), "Downloads");
const localStorageDir = path.join(downloadsDir, "yt-saver-localstorage");
const asrWorkDir = path.join(projectRoot, ".yt-saver-asr");
const libraryFilePath = path.join(projectRoot, "library.json");

function resolveInitialYoutubeLibraryFolder() {
  const fromEnv =
    typeof process.env.STREAMSTEIN_YOUTUBE_LIBRARY === "string"
      ? process.env.STREAMSTEIN_YOUTUBE_LIBRARY.trim()
      : "";
  if (fromEnv) return fromEnv;
  return path.join(downloadsDir, "YouTube");
}

const youtubeCatalog = createYoutubeCatalogStore({
  downloadsDir,
  projectRoot,
  libraryFolder: resolveInitialYoutubeLibraryFolder(),
});
const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".webm", ".m4v"]);
const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".flac",
  ".ogg",
  ".opus",
  ".wma"
]);
// For the purposes of the extension's "missing transcripts" tools, we only
// treat WebVTT subtitle files as satisfying the transcript requirement.
// Other sidecar text files (.txt, .srt, etc.) are ignored so they don't
// prevent us from fetching proper .vtt captions.
const TRANSCRIPT_EXTENSIONS = new Set([".vtt"]);

function isVideoExtension(ext) {
  return VIDEO_EXTENSIONS.has(String(ext || "").toLowerCase());
}

function isAudioExtension(ext) {
  return AUDIO_EXTENSIONS.has(String(ext || "").toLowerCase());
}

function isMediaExtension(ext) {
  return isVideoExtension(ext) || isAudioExtension(ext);
}

function mediaKindFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (isVideoExtension(ext)) return "video";
  if (isAudioExtension(ext)) return "audio";
  return null;
}

function getEntryMediaRecord(entry) {
  if (entry?.video?.path && fs.existsSync(entry.video.path)) {
    return { kind: "video", record: entry.video };
  }
  if (entry?.audio?.path && fs.existsSync(entry.audio.path)) {
    return { kind: "audio", record: entry.audio };
  }
  return null;
}

function hasSiblingVtt(mediaPath) {
  const base = path.basename(mediaPath, path.extname(mediaPath));
  const vttPath = path.join(path.dirname(mediaPath), `${base}.vtt`);
  return fs.existsSync(vttPath);
}

function normalizeFolderPath(input) {
  if (!input || typeof input !== "string") return "";
  const trimmed = input.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return "";
  return path.resolve(trimmed);
}

const WINDOWS_FOLDER_PICKER_VBS = `Option Explicit
Dim shell, folder, startDir
startDir = WScript.Arguments(0)
If Len(startDir) = 0 Then
  startDir = CreateObject("WScript.Shell").SpecialFolders("MyDocuments")
End If
Set shell = CreateObject("Shell.Application")
Set folder = shell.BrowseForFolder(0, "Select a folder for batch transcription", &H40, startDir)
If Not folder Is Nothing Then
  WScript.StdOut.WriteLine folder.Self.Path
End If
`;

function parsePickerStdout(stdout) {
  const picked = (stdout || "")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  return picked || null;
}

async function pickFolderDialogWindowsVbs(startDir) {
  const tmpVbs = path.join(os.tmpdir(), `yt-saver-folder-picker-${process.pid}-${Date.now()}.vbs`);
  try {
    fs.writeFileSync(tmpVbs, WINDOWS_FOLDER_PICKER_VBS, "utf8");
    const { stdout } = await execOnce(
      "cscript.exe",
      ["//nologo", tmpVbs, startDir || ""],
      { windowsHide: false }
    );
    return parsePickerStdout(stdout);
  } finally {
    try {
      fs.unlinkSync(tmpVbs);
    } catch {
      // ignore cleanup errors
    }
  }
}

async function pickFolderDialogWindowsMshta(startDir) {
  const outFile = path.join(os.tmpdir(), `yt-saver-folder-picker-out-${process.pid}-${Date.now()}.txt`);
  const startArg = (startDir || "").replace(/\\/g, "\\\\").replace(/"/g, '""');
  const htaContent = `<html><head><script language="VBScript">
Sub Window_OnLoad
  On Error Resume Next
  Dim shell, folder, startDir, fso, ts
  startDir = "${startArg}"
  If Len(startDir) = 0 Then
    startDir = CreateObject("WScript.Shell").SpecialFolders("MyDocuments")
  End If
  Set shell = CreateObject("Shell.Application")
  Set folder = shell.BrowseForFolder(0, "Select a folder for batch transcription", &H40, startDir)
  If Not folder Is Nothing Then
    Set fso = CreateObject("Scripting.FileSystemObject")
    Set ts = fso.CreateTextFile("${outFile.replace(/\\/g, "\\\\")}", True)
    ts.Write folder.Self.Path
    ts.Close
  End If
  window.Close
End Sub
</script></head><body></body></html>`;
  const tmpHta = path.join(os.tmpdir(), `yt-saver-folder-picker-${process.pid}-${Date.now()}.hta`);
  try {
    fs.writeFileSync(tmpHta, htaContent, "utf8");
    await execOnce("mshta.exe", [tmpHta], { windowsHide: false });
    if (!fs.existsSync(outFile)) {
      return null;
    }
    const picked = fs.readFileSync(outFile, "utf8").trim();
    return picked || null;
  } finally {
    try {
      fs.unlinkSync(tmpHta);
    } catch {}
    try {
      fs.unlinkSync(outFile);
    } catch {}
  }
}

async function pickFolderDialogWindows(initialDir) {
  const startDir =
    initialDir && fs.existsSync(initialDir) ? initialDir : "";
  try {
    return await pickFolderDialogWindowsVbs(startDir);
  } catch (err) {
    fastify.log.warn({ err: err?.message }, "VBScript folder picker failed, trying mshta");
  }
  try {
    return await pickFolderDialogWindowsMshta(startDir);
  } catch (err) {
    fastify.log.warn({ err: err?.message }, "mshta folder picker failed");
    throw new Error(
      "Could not open the folder picker. Your system may block script dialogs—enter the folder path manually."
    );
  }
}

async function pickFolderDialogMac(initialDir) {
  let script = 'POSIX path of (choose folder with prompt "Select a folder")';
  if (initialDir && fs.existsSync(initialDir)) {
    const escaped = initialDir.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    script = `POSIX path of (choose folder with prompt "Select a folder" default location (POSIX file "${escaped}"))`;
  }
  try {
    const { stdout } = await execOnce("osascript", ["-e", script], {});
    const picked = (stdout || "").trim();
    return picked || null;
  } catch {
    return null;
  }
}

async function pickFolderDialogLinux(initialDir) {
  const startDir = initialDir && fs.existsSync(initialDir) ? initialDir : os.homedir();
  try {
    const { stdout } = await execOnce(
      "zenity",
      ["--file-selection", "--directory", "--title=Select a folder", `--filename=${startDir}/`],
      {}
    );
    const picked = (stdout || "").trim();
    return picked || null;
  } catch {
    try {
      const { stdout } = await execOnce("kdialog", ["--getexistingdirectory", startDir], {});
      const picked = (stdout || "").trim();
      return picked || null;
    } catch {
      return null;
    }
  }
}

async function pickFolderDialog(options = {}) {
  const initialDir = normalizeFolderPath(options.initialDir || "");
  if (process.platform === "win32") {
    return pickFolderDialogWindows(initialDir);
  }
  if (process.platform === "darwin") {
    return pickFolderDialogMac(initialDir);
  }
  return pickFolderDialogLinux(initialDir);
}

ensureDir(localStorageDir);
ensureDir(asrWorkDir);

const nodeLocalStorage = new LocalStorage(localStorageDir);
globalThis.localStorage = nodeLocalStorage;
Log.setLevel(Log.Level.ERROR);

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function createMutex() {
  let chain = Promise.resolve();
  return async (fn) => {
    const prev = chain;
    let release = null;
    chain = new Promise((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      try {
        if (release) release();
      } catch {}
    }
  };
}

const withWarmupLock = createMutex();
const withAsrLock = createMutex();
const warmupLastOpenedAtByVideoId = new Map();

function toWatchUrl(videoId) {
  if (!videoId) return "";
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

async function openUrlInBrowser(url) {
  const target = String(url || "").trim();
  if (!target) return false;
  const custom =
    typeof serverConfig?.ytDlpWarmupBrowserCommand === "string"
      ? serverConfig.ytDlpWarmupBrowserCommand.trim()
      : "";
  try {
    if (custom) {
      const tokens = tokenizeCommand(custom);
      const cmd = tokens.shift();
      if (cmd) {
        const child = spawn(cmd, tokens.concat([target]), {
          stdio: "ignore",
          detached: true,
          windowsHide: true
        });
        child.unref();
        return true;
      }
    }

    if (process.platform === "win32") {
      const child = spawn("cmd", ["/c", "start", "", target], {
        stdio: "ignore",
        detached: true,
        windowsHide: true
      });
      child.unref();
      return true;
    }
    if (process.platform === "darwin") {
      const child = spawn("open", [target], { stdio: "ignore", detached: true });
      child.unref();
      return true;
    }
    const child = spawn("xdg-open", [target], { stdio: "ignore", detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function maybeWarmupYouTubeInBrowser(videoUrl) {
  if (serverConfig?.ytDlpWarmupEnabled !== true) return;
  const videoId = extractVideoId(videoUrl);
  if (!videoId) return;

  const watchUrl = toWatchUrl(videoId);
  const delayMs = clampNumber(serverConfig?.ytDlpWarmupDelayMs, { min: 0, max: 15000, fallback: 2500 });
  const cooldownMs = clampNumber(serverConfig?.ytDlpWarmupCooldownMs, { min: 0, max: 10 * 60 * 1000, fallback: 15000 });

  const now = Date.now();
  const last = warmupLastOpenedAtByVideoId.get(videoId) || 0;
  if (cooldownMs > 0 && now - last < cooldownMs) return;

  await withWarmupLock(async () => {
    const now2 = Date.now();
    const last2 = warmupLastOpenedAtByVideoId.get(videoId) || 0;
    if (cooldownMs > 0 && now2 - last2 < cooldownMs) return;
    warmupLastOpenedAtByVideoId.set(videoId, now2);
    const ok = await openUrlInBrowser(watchUrl);
    if (ok && delayMs > 0) {
      await sleepMs(delayMs);
    }
  });
}

function appendLimitedText(prev, nextChunk, maxLen = 20000) {
  const next = `${prev || ""}${nextChunk || ""}`;
  if (next.length <= maxLen) return next;
  return next.slice(next.length - maxLen);
}

function isYtDlpReloadError(text) {
  const t = String(text || "").toLowerCase();
  return t.includes("the page needs to be reloaded");
}

function buildYtDlpStabilityArgs({ useAltPlayerClient = false } = {}) {
  const args = [
    "--no-playlist",
    "--sleep-interval",
    "1",
    "--max-sleep-interval",
    "5",
    "--retries",
    "10",
    "--fragment-retries",
    "10",
    "--extractor-retries",
    "3",
    "--concurrent-fragments",
    "1",
    "--socket-timeout",
    "30",
    "--retry-sleep",
    "fragment:exp=1:20",
    "--user-agent",
    DEFAULT_UA,
    "--referer",
    "https://www.youtube.com/"
  ];
  if (useAltPlayerClient) {
    args.push("--extractor-args", "youtube:player_client=android,ios,tv,web");
  }
  return args;
}

let ytInstance = null;
let serverConfig = {
  ffmpegPath: defaultFfmpegPath(),
  downloadMode: "default",
  downloadSubfolder: "YouTube",
  youtubeLibraryFolder: resolveInitialYoutubeLibraryFolder(),
  moviesLibraryFolder: "",
  // Optional yt-dlp authentication helpers. These are passed directly to
  // yt-dlp so you can use any syntax supported by --cookies-from-browser
  // (e.g. "chrome", "chrome:Profile 1") or --cookies (path to cookies.txt).
  ytDlpCookiesFromBrowser: "",
  ytDlpCookiesFile: "",
  ytDlpCommand: defaultYtDlpCommand(),
  // YouTube often requires an external JS challenge solver (EJS). When enabled,
  // yt-dlp can fetch a compatible solver script distribution.
  ytDlpRemoteComponentsEnabled: true,
  ytDlpRemoteComponentsSpec: "ejs:github",
  // Optional workaround: open the watch page in a real browser tab before running yt-dlp.
  ytDlpWarmupEnabled: false,
  ytDlpWarmupDelayMs: 2500,
  ytDlpWarmupCooldownMs: 15000,
  ytDlpWarmupBrowserCommand: "",
  whisperCommand: "",
  // Chat/LLM configuration
  openaiKey: "",
  openaiBaseUrl: "",
  openaiModelDefault: "gpt-4.1"
};
let asrProgress = {
  active: false,
  phase: null,
  currentChunk: 0,
  totalChunks: 0,
  engine: null,
  batchActive: false,
  batchCurrent: 0,
  batchTotal: 0,
  batchFile: null
};
let libraryState = loadLibraryFile();
let libraryIndex = buildLibraryIndex(libraryState);
// In-memory Chat job tracking
const chatJobs = new Map();

Platform.shim.eval = async (data, env) => {
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${data.output}\nreturn exportedVars;`);
  const exportedVars = factory();
  const result = {};
  if (env?.n && typeof exportedVars.nFunction === "function") {
    result.n = exportedVars.nFunction(env.n);
  }
  if (env?.sig && typeof exportedVars.sigFunction === "function") {
    result.sig = exportedVars.sigFunction(env.sig);
  }
  return result;
};

Platform.shim.fetch = async (input, init = {}) => {
  const target = typeof input === "string" ? input : input?.url || "";
  const headers = new Headers(init.headers || {});
  if (!headers.has("user-agent")) headers.set("user-agent", DEFAULT_UA);
  if (target.includes("googlevideo.com")) {
    if (!headers.has("accept")) headers.set("accept", "*/*");
    if (!headers.has("accept-language")) headers.set("accept-language", "en-US,en;q=0.9");
    if (!headers.has("origin")) headers.set("origin", "https://www.youtube.com");
    if (!headers.has("referer")) headers.set("referer", "https://www.youtube.com/");
  }
  return fetch(input, { ...init, headers });
};

async function getInnertube() {
  if (!ytInstance) {
    ytInstance = await Innertube.create({
      client_type: "WEB",
      device_category: "DESKTOP",
      lang: "en",
      location: "US",
      cache: new UniversalCache(false),
      generate_session_locally: true,
      local_storage: nodeLocalStorage,
      // Required so we always have a player script available for deciphering
      // adaptive format URLs (n-signature and signatureCipher), matching the
      // recommended setup in the YouTube.js docs / Kira example.
      retrieve_player: true
    });
  }
  return ytInstance;
}

fastify.get("/api/ping", async () => ({ ok: true }));

// Load persisted config on startup (library index is already in memory from library.json)
loadServerConfig();

function applyYoutubeLibraryFromConfig() {
  const folder =
    typeof serverConfig.youtubeLibraryFolder === "string"
      ? serverConfig.youtubeLibraryFolder.trim()
      : "";
  if (folder) {
    youtubeCatalog.setLibraryFolder(folder);
  }
}

applyYoutubeLibraryFromConfig();

fastify.get("/api/config", async () => {
  const resolved = resolveFfmpegPath(serverConfig.ffmpegPath);
  const verified = await verifyFfmpeg(resolved).catch(() => false);
  const detected = whisperEnvCache || (await detectWhisperEnvironment().catch(() => null));
  return {
    ok: true,
    ffmpegPath: resolved,
    ffmpegVerified: Boolean(verified),
    bundledFfmpegPath: bundledToolPath("ffmpeg"),
    bundledYtDlpPath: bundledToolPath("yt-dlp"),
    bundledBinDir: process.env.STREAMSTEIN_BIN_DIR || null,
    downloadMode: serverConfig.downloadMode,
    downloadSubfolder: serverConfig.downloadSubfolder,
    ytDlpCookiesFromBrowser: serverConfig.ytDlpCookiesFromBrowser || "",
    ytDlpCookiesFile: serverConfig.ytDlpCookiesFile || "",
    effectiveYtDlpCookiesFile: resolveYoutubeCookiesFilePath() || "",
    ytDlpCommand: typeof serverConfig.ytDlpCommand === "string" && serverConfig.ytDlpCommand.trim()
      ? serverConfig.ytDlpCommand.trim()
      : "yt-dlp",
    ytDlpRemoteComponentsEnabled: serverConfig.ytDlpRemoteComponentsEnabled !== false,
    ytDlpRemoteComponentsSpec:
      typeof serverConfig.ytDlpRemoteComponentsSpec === "string" && serverConfig.ytDlpRemoteComponentsSpec.trim()
        ? serverConfig.ytDlpRemoteComponentsSpec.trim()
        : "ejs:github",
    ytDlpWarmupEnabled: serverConfig.ytDlpWarmupEnabled === true,
    ytDlpWarmupDelayMs: clampNumber(serverConfig.ytDlpWarmupDelayMs, { min: 0, max: 15000, fallback: 2500 }),
    ytDlpWarmupCooldownMs: clampNumber(serverConfig.ytDlpWarmupCooldownMs, { min: 0, max: 10 * 60 * 1000, fallback: 15000 }),
    ytDlpWarmupBrowserCommand:
      typeof serverConfig.ytDlpWarmupBrowserCommand === "string" ? serverConfig.ytDlpWarmupBrowserCommand : "",
    whisperCommand: serverConfig.whisperCommand || detected?.whisperCommand || "",
    whisperAutoDetected: Boolean(detected?.autoDetected),
    whisperAvailable: Boolean(detected?.whisper),
    fasterWhisperAvailable: Boolean(detected?.fasterWhisper),
    downloadRoots: getDownloadRoots(),
    librarySummary: summarizeLibrary(),
    youtubeCatalogPath: youtubeCatalog.getCatalogPaths().primary,
    youtubeCatalogPaths: youtubeCatalog.getCatalogPaths()
  };
});

fastify.post("/api/config", async (request) => {
  try {
    const body = typeof request.body === "object" && request.body ? request.body : {};
    const ffmpegPathIn = typeof body.ffmpegPath === "string" ? body.ffmpegPath.trim() : "";
    const resolved = resolveFfmpegPath(ffmpegPathIn);
    const verified = await verifyFfmpeg(resolved).catch(() => false);
    const downloadMode = ["default", "subfolder", "ask"].includes(body.downloadMode)
      ? body.downloadMode
      : "default";
    const downloadSubfolder =
      typeof body.downloadSubfolder === "string"
        ? sanitizeSubfolder(body.downloadSubfolder)
        : serverConfig.downloadSubfolder;
    const ytDlpCookiesFromBrowser =
      typeof body.ytDlpCookiesFromBrowser === "string"
        ? body.ytDlpCookiesFromBrowser.trim()
        : serverConfig.ytDlpCookiesFromBrowser || "";
    const ytDlpCookiesFile =
      typeof body.ytDlpCookiesFile === "string"
        ? body.ytDlpCookiesFile.trim()
        : serverConfig.ytDlpCookiesFile || "";
    const ytDlpCommand =
      typeof body.ytDlpCommand === "string"
        ? body.ytDlpCommand.trim()
        : typeof serverConfig.ytDlpCommand === "string"
          ? serverConfig.ytDlpCommand
          : "yt-dlp";
    const ytDlpRemoteComponentsEnabled =
      typeof body.ytDlpRemoteComponentsEnabled === "boolean"
        ? body.ytDlpRemoteComponentsEnabled
        : serverConfig.ytDlpRemoteComponentsEnabled !== false;
    const ytDlpRemoteComponentsSpec =
      typeof body.ytDlpRemoteComponentsSpec === "string"
        ? body.ytDlpRemoteComponentsSpec.trim()
        : typeof serverConfig.ytDlpRemoteComponentsSpec === "string"
          ? serverConfig.ytDlpRemoteComponentsSpec
          : "ejs:github";
    const ytDlpWarmupEnabled =
      typeof body.ytDlpWarmupEnabled === "boolean" ? body.ytDlpWarmupEnabled : serverConfig.ytDlpWarmupEnabled === true;
    const ytDlpWarmupDelayMs = clampNumber(
      typeof body.ytDlpWarmupDelayMs !== "undefined" ? body.ytDlpWarmupDelayMs : serverConfig.ytDlpWarmupDelayMs,
      { min: 0, max: 15000, fallback: 2500 }
    );
    const ytDlpWarmupCooldownMs = clampNumber(
      typeof body.ytDlpWarmupCooldownMs !== "undefined"
        ? body.ytDlpWarmupCooldownMs
        : serverConfig.ytDlpWarmupCooldownMs,
      { min: 0, max: 10 * 60 * 1000, fallback: 15000 }
    );
    const ytDlpWarmupBrowserCommand =
      typeof body.ytDlpWarmupBrowserCommand === "string"
        ? body.ytDlpWarmupBrowserCommand.trim()
        : serverConfig.ytDlpWarmupBrowserCommand || "";
    const whisperCommandIn =
      typeof body.whisperCommand === "string" ? body.whisperCommand.trim() : undefined;
    const whisperCommand =
      whisperCommandIn !== undefined
        ? whisperCommandIn || serverConfig.whisperCommand || ""
        : serverConfig.whisperCommand || "";
    const youtubeLibraryFolderIn =
      typeof body.youtubeLibraryFolder === "string"
        ? body.youtubeLibraryFolder.trim()
        : serverConfig.youtubeLibraryFolder || "";
    const moviesLibraryFolderIn =
      typeof body.moviesLibraryFolder === "string"
        ? body.moviesLibraryFolder.trim()
        : serverConfig.moviesLibraryFolder || "";

    const modeChanged =
      serverConfig.downloadMode !== downloadMode ||
      serverConfig.downloadSubfolder !== downloadSubfolder;
    const youtubeFolderChanged =
      youtubeLibraryFolderIn &&
      youtubeLibraryFolderIn !== serverConfig.youtubeLibraryFolder;

    serverConfig.ffmpegPath = resolved || serverConfig.ffmpegPath || "";
    serverConfig.downloadMode = downloadMode;
    serverConfig.downloadSubfolder = downloadSubfolder || serverConfig.downloadSubfolder;
    serverConfig.ytDlpCookiesFromBrowser = ytDlpCookiesFromBrowser;
    serverConfig.ytDlpCookiesFile = ytDlpCookiesFile;
    serverConfig.ytDlpCommand =
      ytDlpCommand ||
      resolveYtDlpCommand() ||
      (typeof serverConfig.ytDlpCommand === "string" ? serverConfig.ytDlpCommand : "yt-dlp");
    serverConfig.ytDlpRemoteComponentsEnabled = ytDlpRemoteComponentsEnabled;
    serverConfig.ytDlpRemoteComponentsSpec = ytDlpRemoteComponentsSpec || "ejs:github";
    serverConfig.ytDlpWarmupEnabled = ytDlpWarmupEnabled === true;
    serverConfig.ytDlpWarmupDelayMs = ytDlpWarmupDelayMs;
    serverConfig.ytDlpWarmupCooldownMs = ytDlpWarmupCooldownMs;
    serverConfig.ytDlpWarmupBrowserCommand = ytDlpWarmupBrowserCommand;
    serverConfig.whisperCommand = whisperCommand;
    applyBundledToolDefaults();
    if (whisperCommand) {
      whisperEnvCache = null;
    }
    if (youtubeLibraryFolderIn) {
      serverConfig.youtubeLibraryFolder = youtubeLibraryFolderIn;
      youtubeCatalog.setLibraryFolder(youtubeLibraryFolderIn);
    }
    if (moviesLibraryFolderIn) {
      serverConfig.moviesLibraryFolder = moviesLibraryFolderIn;
    }
    applyBundledYoutubeCookiesDefaults();
    persistServerConfig();

    if (modeChanged || youtubeFolderChanged) {
      await rescanLibrary({ reason: "config-change" }).catch((err) => {
        fastify.log.error({ err: err?.message }, "Library rescan failed after config change");
      });
    }

    return {
      ok: true,
      ffmpegPath: resolved,
      ffmpegVerified: Boolean(verified),
      downloadMode: serverConfig.downloadMode,
      downloadSubfolder: serverConfig.downloadSubfolder,
      ytDlpCookiesFromBrowser: serverConfig.ytDlpCookiesFromBrowser || "",
      ytDlpCookiesFile: serverConfig.ytDlpCookiesFile || "",
      effectiveYtDlpCookiesFile: resolveYoutubeCookiesFilePath() || "",
      ytDlpCommand: typeof serverConfig.ytDlpCommand === "string" && serverConfig.ytDlpCommand.trim()
        ? serverConfig.ytDlpCommand.trim()
        : "yt-dlp",
      ytDlpRemoteComponentsEnabled: serverConfig.ytDlpRemoteComponentsEnabled !== false,
      ytDlpRemoteComponentsSpec:
        typeof serverConfig.ytDlpRemoteComponentsSpec === "string" && serverConfig.ytDlpRemoteComponentsSpec.trim()
          ? serverConfig.ytDlpRemoteComponentsSpec.trim()
          : "ejs:github",
      ytDlpWarmupEnabled: serverConfig.ytDlpWarmupEnabled === true,
      ytDlpWarmupDelayMs: clampNumber(serverConfig.ytDlpWarmupDelayMs, { min: 0, max: 15000, fallback: 2500 }),
      ytDlpWarmupCooldownMs: clampNumber(serverConfig.ytDlpWarmupCooldownMs, { min: 0, max: 10 * 60 * 1000, fallback: 15000 }),
      ytDlpWarmupBrowserCommand:
        typeof serverConfig.ytDlpWarmupBrowserCommand === "string" ? serverConfig.ytDlpWarmupBrowserCommand : "",
      whisperCommand: serverConfig.whisperCommand || "",
      downloadRoots: getDownloadRoots(),
      librarySummary: summarizeLibrary()
    };
  } catch (err) {
    return { ok: false, error: err?.message || "Failed to update config." };
  }
});

fastify.get("/api/ytdlp/status", async () => {
  const ytDlpCmd = resolveYtDlpCommand();
  const nodeRuntime = resolveNodeJsRuntimePath();
  let version = null;
  let versionError = null;
  try {
    const { stdout } = await execOnce(ytDlpCmd, ["--version"], { env: buildToolSpawnEnv() });
    version = String(stdout || "").trim() || null;
  } catch (e) {
    versionError = e?.message || String(e);
  }
  const supportsRemoteComponents = await probeYtDlpHasRemoteComponents(ytDlpCmd);
  return {
    ok: Boolean(version) && !versionError,
    ytDlpCommand: ytDlpCmd,
    ytDlpVersion: version,
    ytDlpVersionError: versionError,
    bundledBinDir: process.env.STREAMSTEIN_BIN_DIR || null,
    nodeJsRuntime: nodeRuntime,
    ffmpegPath: resolveFfmpegPath(serverConfig.ffmpegPath),
    remoteComponentsSupported: Boolean(supportsRemoteComponents),
    remoteComponentsEnabled: serverConfig.ytDlpRemoteComponentsEnabled !== false,
    remoteComponentsSpec:
      typeof serverConfig.ytDlpRemoteComponentsSpec === "string" && serverConfig.ytDlpRemoteComponentsSpec.trim()
        ? serverConfig.ytDlpRemoteComponentsSpec.trim()
        : "ejs:github"
  };
});

// ===== Chat configuration & status =====
fastify.get("/api/chat/status", async () => {
  return {
    ok: true,
    openaiConfigured: Boolean(serverConfig.openaiKey && serverConfig.openaiKey.trim()),
    openaiModelDefault: serverConfig.openaiModelDefault || "gpt-4.1"
  };
});

fastify.post("/api/chat/config", async (request) => {
  try {
    const body = typeof request.body === "object" && request.body ? request.body : {};
    const key = typeof body.openaiKey === "string" ? body.openaiKey.trim() : serverConfig.openaiKey || "";
    const base = typeof body.openaiBaseUrl === "string" ? body.openaiBaseUrl.trim() : serverConfig.openaiBaseUrl || "";
    const model =
      typeof body.openaiModelDefault === "string" && body.openaiModelDefault.trim()
        ? body.openaiModelDefault.trim()
        : serverConfig.openaiModelDefault || "gpt-4.1";
    serverConfig.openaiKey = key;
    serverConfig.openaiBaseUrl = base;
    serverConfig.openaiModelDefault = model;
    persistServerConfig();
    return {
      ok: true,
      openaiConfigured: Boolean(serverConfig.openaiKey),
      openaiModelDefault: serverConfig.openaiModelDefault
    };
  } catch (err) {
    return { ok: false, error: err?.message || "Failed to save chat config." };
  }
});

fastify.get("/api/chat/creators", async () => {
  try {
    const list = listCreators();
    return { ok: true, creators: list };
  } catch (err) {
    return { ok: false, error: err?.message || "Failed to list creators." };
  }
});

fastify.post("/api/chat/start", async (request) => {
  try {
    const body = typeof request.body === "object" && request.body ? request.body : {};
    const creatorKey = typeof body.creatorKey === "string" ? normalizeChannelKey(body.creatorKey) : "";
    const minutes = Math.max(1, Math.min(180, Number(body.minutes || 60) || 60));
    const topics =
      Array.isArray(body.topics) && body.topics.length
        ? body.topics.map((t) => String(t).trim()).filter(Boolean)
        : typeof body.topics === "string" && body.topics.trim()
          ? String(body.topics)
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : [];
    const episodeTitle = typeof body.title === "string" ? body.title.trim() : "";
    const autoNews = body.autoNews === true;
    const newsDays = Math.max(1, Math.min(14, Number(body.newsDays || 7) || 7));
    const model =
      typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : serverConfig.openaiModelDefault || "gpt-4.1";

    if (!serverConfig.openaiKey) {
      return { ok: false, error: "OpenAI key not configured." };
    }
    if (!creatorKey) {
      return { ok: false, error: "Missing creatorKey." };
    }

    const creator = resolveCreator(creatorKey);
    if (!creator) {
      return { ok: false, error: "Creator not found in library." };
    }

    const id = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const job = {
      id,
      creatorKey,
      minutes,
      topics,
      episodeTitle,
      autoNews,
      newsDays,
      model,
      active: true,
      phase: "queued",
      message: "Queued",
      current: 0,
      total: 0,
      targetPath: null,
      error: null
    };
    chatJobs.set(id, job);

    setImmediate(async () => {
      await runChatJob(job).catch((err) => {
        job.active = false;
        job.phase = "error";
        job.error = err?.message || String(err);
      });
    });

    return { ok: true, jobId: id };
  } catch (err) {
    return { ok: false, error: err?.message || "Failed to start chat job." };
  }
});

fastify.get("/api/chat/progress", async (request) => {
  try {
    const jobId =
      typeof request.query?.jobId === "string" ? request.query.jobId : "";
    if (!jobId) {
      return { ok: false, error: "Missing jobId" };
    }
    const job = chatJobs.get(jobId);
    if (!job) {
      return { ok: false, error: "Job not found" };
    }
    return {
      ok: true,
      job: {
        id: job.id,
        active: job.active,
        phase: job.phase,
        message: job.message,
        current: job.current,
        total: job.total,
        targetPath: job.targetPath,
        error: job.error
      }
    };
  } catch (err) {
    return { ok: false, error: err?.message || "Failed to get progress." };
  }
});

fastify.get("/api/library", async () => {
  return {
    ok: true,
    summary: summarizeLibrary()
  };
});

fastify.post("/api/library/rescan", async () => {
  const summary = await rescanLibrary({ reason: "manual" });
  return { ok: true, summary };
});

fastify.post("/api/library/register", async (request, reply) => {
  try {
    const body = typeof request.body === "object" && request.body ? request.body : {};
    const videoId = typeof body.videoId === "string" ? body.videoId.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const filePath = typeof body.path === "string" ? body.path.trim() : "";
    const kind =
      body.type === "transcript"
        ? "transcript"
        : body.type === "audio"
          ? "audio"
          : "video";
    if (!filePath) {
      reply.code(400);
      return { ok: false, error: "Missing file path." };
    }
    const payload = {
      videoId: videoId || null,
      title,
      path: filePath,
      type: kind,
      normalizedTitle: typeof body.normalizedTitle === "string" ? body.normalizedTitle : null,
      size: typeof body.size === "number" ? body.size : null,
      mtime: typeof body.mtime === "number" ? body.mtime : null,
      source: body.source || "register",
      watchUrl: typeof body.watchUrl === "string" ? body.watchUrl.trim() : null,
      shortUrl: typeof body.shortUrl === "string" ? body.shortUrl.trim() : null,
      thumbnailUrl: typeof body.thumbnailUrl === "string" ? body.thumbnailUrl.trim() : null,
      channelId: typeof body.channelId === "string" ? body.channelId.trim() : null,
      channelName: typeof body.channelName === "string" ? body.channelName.trim() : null,
      quality: typeof body.quality === "string" ? body.quality.trim() : null,
      intendedPath: typeof body.intendedPath === "string" ? body.intendedPath.trim() : null
    };
    const entry = registerLibraryFile(payload);
    return { ok: true, entry };
  } catch (err) {
    reply.code(500);
    return { ok: false, error: err?.message || "Failed to register file." };
  }
});

fastify.get("/api/youtube/catalog", async () => {
  const paths = youtubeCatalog.getCatalogPaths();
  return {
    ok: true,
    paths,
    catalog: youtubeCatalog.loadCatalog()
  };
});

fastify.post("/api/youtube/catalog/request", async (request, reply) => {
  try {
    const body = typeof request.body === "object" && request.body ? request.body : {};
    const videoId = typeof body.videoId === "string" ? body.videoId.trim() : "";
    if (!videoId && !body.watchUrl && !body.url) {
      reply.code(400);
      return { ok: false, error: "Missing videoId or watchUrl." };
    }
    const record = youtubeCatalog.recordDownload({
      status: "pending",
      videoId: videoId || null,
      watchUrl:
        typeof body.watchUrl === "string"
          ? body.watchUrl
          : typeof body.url === "string"
            ? body.url
            : null,
      title: typeof body.title === "string" ? body.title : null,
      normalizedTitle: typeof body.normalizedTitle === "string" ? body.normalizedTitle : null,
      channelId: typeof body.channelId === "string" ? body.channelId : null,
      channelName: typeof body.channelName === "string" ? body.channelName : null,
      assetType: body.assetType || body.type || "video",
      source: typeof body.source === "string" ? body.source : null,
      quality: typeof body.quality === "string" ? body.quality : null,
      filenameHint: typeof body.filenameHint === "string" ? body.filenameHint : null,
      intendedPath: typeof body.intendedPath === "string" ? body.intendedPath : null
    });
    return { ok: true, record };
  } catch (err) {
    reply.code(500);
    return { ok: false, error: err?.message || "Failed to record catalog request." };
  }
});

function buildLibraryListEntry(e) {
  const media = getEntryMediaRecord(e);
  if (!media) return null;
  const record = media.record;
  const payload = {
    id: e.id,
    videoId: e.videoId || null,
    title: e.title || null,
    normalizedTitle: e.normalizedTitle || null,
    watchUrl: e.watchUrl || (e.videoId ? toWatchUrl(e.videoId) : null),
    shortUrl: e.shortUrl || null,
    thumbnailUrl: e.thumbnailUrl || null,
    channelId: e.channelId || null,
    channelName: e.channelName || null,
    mediaKind: media.kind,
    video: null,
    audio: null,
    transcript:
      e.transcript && e.transcript.path && fs.existsSync(e.transcript.path)
        ? { path: e.transcript.path }
        : null
  };
  const mediaPayload = {
    path: record.path,
    size: record.size || null,
    mtime: record.mtime || null
  };
  if (media.kind === "audio") {
    payload.audio = mediaPayload;
  } else {
    payload.video = mediaPayload;
  }
  return payload;
}

fastify.get("/api/library/list", async () => {
  const entries = [];
  for (const e of libraryState.entries) {
    const item = buildLibraryListEntry(e);
    if (item) entries.push(item);
  }
  entries.sort(
    (a, b) =>
      (b.video?.mtime || b.audio?.mtime || 0) - (a.video?.mtime || a.audio?.mtime || 0) ||
      String(a.title || "").localeCompare(String(b.title || ""))
  );
  return { ok: true, entries };
});

fastify.post("/api/dialog/pick-folder", async (request, reply) => {
  try {
    const body = typeof request.body === "object" && request.body ? request.body : {};
    const initialDir = normalizeFolderPath(body.initialDir || body.folderPath || "");
    let folderPath = null;
    try {
      folderPath = await pickFolderDialog({ initialDir });
    } catch (err) {
      reply.code(500);
      return { ok: false, error: err?.message || "Folder picker failed." };
    }
    if (!folderPath) {
      return { ok: true, cancelled: true, folderPath: null };
    }
    const normalized = normalizeFolderPath(folderPath);
    let stat = null;
    try {
      stat = fs.statSync(normalized);
    } catch {
      reply.code(400);
      return { ok: false, error: "Selected path is not accessible." };
    }
    if (!stat.isDirectory()) {
      reply.code(400);
      return { ok: false, error: "Selected path is not a directory." };
    }
    return { ok: true, cancelled: false, folderPath: normalized };
  } catch (err) {
    reply.code(500);
    return { ok: false, error: err?.message || "Folder picker failed." };
  }
});

fastify.post("/api/library/folder-scan", async (request, reply) => {
  try {
    const body = typeof request.body === "object" && request.body ? request.body : {};
    const folderPath = normalizeFolderPath(body.folderPath || body.folder || "");
    const recursive = body.recursive !== false;
    if (!folderPath) {
      reply.code(400);
      return { ok: false, error: "Folder path is required." };
    }
    let stat = null;
    try {
      stat = fs.statSync(folderPath);
    } catch {
      reply.code(400);
      return { ok: false, error: "Folder not found." };
    }
    if (!stat.isDirectory()) {
      reply.code(400);
      return { ok: false, error: "Path is not a directory." };
    }
    const targets = listFolderMediaMissingTranscripts(folderPath, { recursive });
    return {
      ok: true,
      folderPath,
      recursive,
      targets,
      summary: {
        totalMedia: targets.length,
        missingTranscript: targets.length
      }
    };
  } catch (err) {
    reply.code(500);
    return { ok: false, error: err?.message || "Folder scan failed." };
  }
});

fastify.post("/api/asr/whisper", async (request, reply) => {
  if (asrProgress.active) {
    reply.code(409);
    return { ok: false, error: "Another transcription job is already running." };
  }
  try {
    const body = typeof request.body === "object" && request.body ? request.body : {};
    const inputPath = typeof body.path === "string" ? body.path.trim() : "";
    const videoId = typeof body.videoId === "string" ? body.videoId.trim() : "";
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "medium.en";
    const previewSeconds = Math.max(0, Number(body.previewSeconds || 0) || 0);
    const language = typeof body.language === "string" ? body.language.trim() || "en" : "en";
    const engine = body.engine === "faster-whisper" ? "faster-whisper" : "whisper";

    let sourcePath = inputPath;
    if (!sourcePath && videoId) {
      const found = libraryIndex.byVideoId.get(videoId);
      const media = found ? getEntryMediaRecord(found) : null;
      if (media?.record?.path) {
        sourcePath = media.record.path;
      }
    }
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      reply.code(400);
      return { ok: false, error: "Media file not found." };
    }
    if (!mediaKindFromPath(sourcePath)) {
      reply.code(400);
      return { ok: false, error: "Unsupported media file type." };
    }

    const asrResult = await withAsrLock(() =>
      runAsrOnMediaPath(sourcePath, { model, language, previewSeconds, engine, videoId })
    );

    return {
      ok: true,
      transcriptPath: asrResult.transcriptPath,
      whisperMode: asrResult.whisperMode || "unknown",
      whisperDevice: asrResult.whisperDevice || "unknown",
      whisperFallbackError: asrResult.whisperFallbackError || null
    };
  } catch (err) {
    asrProgress.active = false;
    asrProgress.phase = "error";
    asrProgress.batchActive = false;
    reply.code(500);
    return { ok: false, error: err?.message || "ASR transcription failed." };
  }
});

fastify.post("/api/asr/folder", async (request, reply) => {
  if (asrProgress.active) {
    reply.code(409);
    return { ok: false, error: "Another transcription job is already running." };
  }
  try {
    const body = typeof request.body === "object" && request.body ? request.body : {};
    const folderPath = normalizeFolderPath(body.folderPath || body.folder || "");
    const recursive = body.recursive !== false;
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "medium.en";
    const previewSeconds = Math.max(0, Number(body.previewSeconds || 0) || 0);
    const language = typeof body.language === "string" ? body.language.trim() || "en" : "en";
    const engine = body.engine === "faster-whisper" ? "faster-whisper" : "whisper";

    if (!folderPath) {
      reply.code(400);
      return { ok: false, error: "Folder path is required." };
    }
    let stat = null;
    try {
      stat = fs.statSync(folderPath);
    } catch {
      reply.code(400);
      return { ok: false, error: "Folder not found." };
    }
    if (!stat.isDirectory()) {
      reply.code(400);
      return { ok: false, error: "Path is not a directory." };
    }

    const targets = listFolderMediaMissingTranscripts(folderPath, { recursive });
    if (!targets.length) {
      return {
        ok: true,
        started: false,
        total: 0,
        message: "No video or audio files without transcripts were found in that folder."
      };
    }

    void runFolderAsrBatch(targets, { model, language, previewSeconds, engine }).catch((err) => {
      fastify.log.error({ err: err?.message }, "Folder ASR batch failed");
      asrProgress.active = false;
      asrProgress.phase = "error";
      asrProgress.batchActive = false;
    });

    return { ok: true, started: true, total: targets.length, folderPath, recursive };
  } catch (err) {
    reply.code(500);
    return { ok: false, error: err?.message || "Failed to start folder transcription." };
  }
});

fastify.get("/api/asr/progress", async () => {
  return {
    ok: true,
    progress: asrProgress
  };
});

fastify.get("/api/asr/status", async () => {
  try {
    const detected = await detectWhisperEnvironment();
    const whisperAvailable = Boolean(detected.whisper);
    const fasterWhisperAvailable = Boolean(detected.fasterWhisper);
    const hasEngine = whisperAvailable || fasterWhisperAvailable;
    return {
      ok: hasEngine,
      torchVersion: detected.torchVersion || null,
      cudaAvailable: Boolean(detected.cudaAvailable),
      device: detected.device || null,
      whisperAvailable,
      fasterWhisperAvailable,
      whisperCommand: serverConfig.whisperCommand || detected.whisperCommand || "",
      whisperAutoDetected: Boolean(detected.autoDetected),
      error: hasEngine
        ? null
        : "Whisper is not installed in any detected Python environment. Install openai-whisper or faster-whisper, or set the Whisper command in Settings → Tools."
    };
  } catch (err) {
    return {
      ok: false,
      whisperAvailable: false,
      fasterWhisperAvailable: false,
      error: err?.message || "Failed to probe Whisper backend."
    };
  }
});

fastify.post("/api/library/check", async (request, reply) => {
  try {
    const body = typeof request.body === "object" && request.body ? request.body : {};
    const videos = Array.isArray(body.videos) ? body.videos : [];
    const includeLoose = body.includeLoose !== false;
    const channelHint =
      typeof body.channelHint === "string" ? body.channelHint.trim() : "";
    const debug = body.debug === true;
    const rescanBeforeCheck = body.rescanBeforeCheck === true;
    if (rescanBeforeCheck) {
      await rescanLibrary({ reason: "channel-check" });
    }
    const result = checkLibraryMatches(videos, { includeLoose, channelHint, debug });
    return { ok: true, ...result };
  } catch (err) {
    reply.code(500);
    return { ok: false, error: err?.message || "Failed to check library." };
  }
});

fastify.route({
  method: ["GET", "POST"],
  url: "/api/download",
  handler: async (request, reply) => {
    const url =
      request.method === "GET"
        ? typeof request.query?.url === "string"
          ? request.query.url
          : ""
        : typeof request.body?.url === "string"
          ? request.body.url
          : "";

    if (!url) {
      reply.code(400);
      return { error: "Missing url" };
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      reply.code(400);
      return { error: "Could not parse video ID from URL" };
    }

    try {
      const innertube = await getInnertube();
      const info = await innertube.getInfo(videoId);
      const title = info?.basic_info?.title || `video-${videoId}`;
      const safeTitle = sanitizeFileName(title);

      const qualityParam =
        request.method === "GET" ? request.query?.quality : request.body?.quality;

      fastify.log.info({ videoId, qualityParam }, "Download request received");

      // 1) Always try yt-dlp first, using bestvideo+audio up to the selected max resolution.
      try {
        fastify.log.info({ videoId, qualityParam }, "Attempting yt-dlp download");
        return await downloadWithYtDlp(url, safeTitle, reply, qualityParam);
      } catch (ytDlpErr) {
        request.log.warn(
          { videoId, error: ytDlpErr?.message },
          "yt-dlp download failed; falling back to internal pipeline."
        );
      }

      // 2) Final fallback: use youtubei.js progressive download / direct proxy.
      try {
        const stream = await innertube.download(videoId, {
          type: "video+audio",
          quality: "best",
          format: "mp4"
        });

        fastify.log.info({ videoId }, "Serving progressive MP4 via Innertube");
        reply
          .header("Content-Type", "video/mp4")
          .header("Content-Disposition", `attachment; filename="${safeTitle}.mp4"`)
          .header("Cache-Control", "no-store");

        return reply.send(stream);
      } catch (downloadErr) {
        request.log.warn(
          { videoId, error: downloadErr?.message },
          "Innertube download failed, attempting direct format proxy"
        );

        const format = selectDirectFormat(info?.streaming_data);
        if (!format) {
          reply.code(501);
          return { error: "No downloadable formats exposed for this video." };
        }

        try {
          return await proxyDirectFormat(format, safeTitle, reply);
        } catch (proxyErr) {
          request.log.error({ videoId, error: proxyErr?.message }, "Direct format proxy failed");
          reply.code(502);
          return { error: proxyErr?.message || "Failed to proxy googlevideo stream." };
        }
      }
    } catch (err) {
      request.log.error(err, "Unhandled error preparing download");
      reply.code(500);
      return { error: err?.message || "Failed to prepare download" };
    }
  }
});

fastify.route({
  method: ["GET", "POST"],
  url: "/api/transcript",
  handler: async (request, reply) => {
    const url =
      request.method === "GET"
        ? typeof request.query?.url === "string"
          ? request.query.url
          : ""
        : typeof request.body?.url === "string"
          ? request.body.url
          : "";

    if (!url) {
      reply.code(400);
      return { error: "Missing url" };
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      reply.code(400);
      return { error: "Could not parse video ID from URL" };
    }

    try {
      const innertube = await getInnertube();
      const info = await innertube.getInfo(videoId);
      const title = info?.basic_info?.title || `video-${videoId}`;
      const safeTitle = sanitizeFileName(title);

      fastify.log.info({ videoId }, "Transcript request received");

      try {
        return await downloadTranscriptWithYtDlp(url, safeTitle, reply);
      } catch (ytDlpErr) {
        request.log.warn(
          { videoId, error: ytDlpErr?.message },
          "yt-dlp transcript download failed."
        );
        reply.code(502);
        return { error: ytDlpErr?.message || "Failed to download transcript with yt-dlp." };
      }
    } catch (err) {
      request.log.error(err, "Unhandled error preparing transcript");
      reply.code(500);
      return { error: err?.message || "Failed to prepare transcript download" };
    }
  }
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 8789;

fastify.listen({ host: "127.0.0.1", port: PORT }).then(() => {
  applyBundledToolDefaults();
  applyBundledYoutubeCookiesDefaults();
  void applyWhisperDefaults().then((detected) => {
    const cookiesFile = resolveYoutubeCookiesFilePath();
    fastify.log.info(
      {
        port: PORT,
        libraryEntries: libraryState.entries?.length ?? 0,
        ytDlpCommand: resolveYtDlpCommand(),
        ffmpegPath: resolveFfmpegPath(serverConfig.ffmpegPath),
        ytDlpCookiesFile: cookiesFile || null,
        whisperCommand: serverConfig.whisperCommand || detected?.whisperCommand || null,
        whisperAvailable: Boolean(detected?.whisper || detected?.fasterWhisper),
        bundledBinDir: process.env.STREAMSTEIN_BIN_DIR || null,
        nodeJsRuntime: resolveNodeJsRuntimePath()
      },
      cookiesFile
        ? "yt-saver-bridge ready (using extension youtube-cookies.txt)"
        : "yt-saver-bridge ready"
    );
  });

  void (async () => {
    try {
      const summary = summarizeLibrary();
      if (summary.videosWithFile > 0) return;
      const catalog = youtubeCatalog.loadCatalog();
      const onDisk = (catalog.records || []).filter(
        (rec) =>
          rec?.filePath &&
          rec.assetType !== "transcript" &&
          fs.existsSync(rec.filePath)
      );
      if (!onDisk.length) return;
      fastify.log.info(
        {
          catalogFiles: onDisk.length,
          libraryEntries: libraryState.entries.length
        },
        "Library index empty; rebuilding from disk + youtube-catalog.json"
      );
      await rescanLibrary({ reason: "startup-sync" });
    } catch (err) {
      fastify.log.warn({ err: err?.message }, "Startup library sync failed");
    }
  })();
}).catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});

function extractVideoId(input) {
  if (typeof input !== "string") {
    return null;
  }

  try {
    const url = new URL(input);
    if (url.hostname === "youtu.be") {
      return url.pathname.replace("/", "");
    }
    if (url.searchParams.get("v")) {
      return url.searchParams.get("v");
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] === "shorts" && segments[1]) {
      return segments[1];
    }
  } catch {
    const match = input.match(/[?&]v=([^&]+)/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function sanitizeFileName(name) {
  if (typeof name !== "string") {
    return "youtube-video";
  }

  // Strip control characters (including CR/LF) that are illegal in HTTP headers
  let safe = name
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    // Strip any non-ASCII characters so Node's header validation can't fail
    // (covers “smart quotes”, emojis, etc.)
    .replace(/[^\x20-\x7E]+/g, " ")
    // Remove characters that are invalid for common filesystems
    .replace(/[<>:"/\\|?*]+/g, " ")
    // Collapse all whitespace to single spaces
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  if (!safe) {
    safe = "youtube-video";
  }

  return safe;
}

function selectDirectFormat(streamingData) {
  if (!streamingData) {
    return null;
  }

  const formats = [
    ...(streamingData.formats || []),
    ...(streamingData.adaptive_formats || []),
    ...(streamingData.adaptiveFormats || [])
  ];

  if (!formats.length) {
    return null;
  }

  const progressive = formats
    .filter(
      (format) =>
        hasDirectUrl(format) &&
        ((format.mime_type || format.mimeType || "").includes("video/mp4") ||
          (format.mime_type || format.mimeType || "").includes("audio/mp4"))
    )
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  if (progressive[0]) {
    return { ...progressive[0], url: progressive[0].url };
  }

  const fallback = formats.find((format) => hasDirectUrl(format));
  return fallback ? { ...fallback, url: fallback.url } : null;
}

function hasDirectUrl(format) {
  if (!format) return false;
  const candidate = format.url || format.download_url || format.signed_url;
  if (typeof candidate !== "string") {
    return false;
  }
  try {
    const parsed = new URL(candidate);
    return parsed.protocol.startsWith("http") && parsed.hostname.includes("googlevideo.com");
  } catch {
    return false;
  }
}

async function proxyDirectFormat(format, safeTitle, reply) {
  const url = format.url;
  if (!url) {
    throw new Error("Selected format does not expose a direct URL.");
  }

  const upstream = await fetch(url, {
    headers: {
      "user-agent": DEFAULT_UA,
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
      origin: "https://www.youtube.com",
      referer: "https://www.youtube.com/"
    }
  });

  if (!upstream.ok || !upstream.body) {
    throw new Error(`googlevideo responded with ${upstream.status}`);
  }

  const mime =
    (format.mime_type || format.mimeType || upstream.headers.get("content-type") || "video/mp4").split(";")[0];
  const ext = mime.includes("webm")
    ? "webm"
    : mime.includes("mp4") || mime.includes("mp2t") || mime.includes("mpeg")
    ? "mp4"
    : "mp4";

  reply
    .header("Content-Type", mime)
    .header("Content-Disposition", `attachment; filename="${safeTitle}.${ext}"`)
    .header("Cache-Control", "no-store");

  // Convert WHATWG ReadableStream to Node.js Readable that Fastify can send
  const nodeStream =
    typeof Readable.fromWeb === "function"
      ? Readable.fromWeb(upstream.body)
      : Readable.from(upstream.body);

  return reply.send(nodeStream);
}

function loadServerConfig() {
  try {
    const rawConfig = nodeLocalStorage.getItem("serverConfig");
    if (typeof rawConfig === "string" && rawConfig.trim()) {
      const parsed = JSON.parse(rawConfig);
      if (parsed && typeof parsed === "object") {
        serverConfig = {
          ...serverConfig,
          ...parsed,
          downloadMode: parsed.downloadMode || serverConfig.downloadMode,
          downloadSubfolder: parsed.downloadSubfolder || serverConfig.downloadSubfolder,
          ytDlpCommand:
            typeof parsed.ytDlpCommand === "string" && parsed.ytDlpCommand.trim()
              ? parsed.ytDlpCommand.trim()
              : serverConfig.ytDlpCommand,
          ytDlpRemoteComponentsEnabled:
            typeof parsed.ytDlpRemoteComponentsEnabled === "boolean"
              ? parsed.ytDlpRemoteComponentsEnabled
              : serverConfig.ytDlpRemoteComponentsEnabled !== false,
          ytDlpRemoteComponentsSpec:
            typeof parsed.ytDlpRemoteComponentsSpec === "string" && parsed.ytDlpRemoteComponentsSpec.trim()
              ? parsed.ytDlpRemoteComponentsSpec.trim()
              : serverConfig.ytDlpRemoteComponentsSpec,
          ytDlpWarmupEnabled: parsed.ytDlpWarmupEnabled === true,
          ytDlpWarmupDelayMs: clampNumber(parsed.ytDlpWarmupDelayMs, {
            min: 0,
            max: 15000,
            fallback: serverConfig.ytDlpWarmupDelayMs
          }),
          ytDlpWarmupCooldownMs: clampNumber(parsed.ytDlpWarmupCooldownMs, {
            min: 0,
            max: 10 * 60 * 1000,
            fallback: serverConfig.ytDlpWarmupCooldownMs
          }),
          ytDlpWarmupBrowserCommand:
            typeof parsed.ytDlpWarmupBrowserCommand === "string"
              ? parsed.ytDlpWarmupBrowserCommand
              : serverConfig.ytDlpWarmupBrowserCommand,
          whisperCommand: typeof parsed.whisperCommand === "string" ? parsed.whisperCommand : serverConfig.whisperCommand,
          openaiKey: typeof parsed.openaiKey === "string" ? parsed.openaiKey : serverConfig.openaiKey,
          openaiBaseUrl: typeof parsed.openaiBaseUrl === "string" ? parsed.openaiBaseUrl : serverConfig.openaiBaseUrl,
          openaiModelDefault:
            typeof parsed.openaiModelDefault === "string" && parsed.openaiModelDefault.trim()
              ? parsed.openaiModelDefault
              : serverConfig.openaiModelDefault,
          youtubeLibraryFolder:
            typeof parsed.youtubeLibraryFolder === "string" && parsed.youtubeLibraryFolder.trim()
              ? parsed.youtubeLibraryFolder.trim()
              : serverConfig.youtubeLibraryFolder,
          moviesLibraryFolder:
            typeof parsed.moviesLibraryFolder === "string"
              ? parsed.moviesLibraryFolder.trim()
              : serverConfig.moviesLibraryFolder || ""
        };
      }
    } else {
      const legacyPath = nodeLocalStorage.getItem("ffmpegPath");
      if (typeof legacyPath === "string") {
        serverConfig.ffmpegPath = legacyPath;
      }
    }
  } catch {}
  if (!["default", "subfolder", "ask"].includes(serverConfig.downloadMode)) {
    serverConfig.downloadMode = "default";
  }
  serverConfig.downloadSubfolder = sanitizeSubfolder(serverConfig.downloadSubfolder || "YouTube");
  if (
    typeof serverConfig.youtubeLibraryFolder !== "string" ||
    !serverConfig.youtubeLibraryFolder.trim()
  ) {
    serverConfig.youtubeLibraryFolder = resolveInitialYoutubeLibraryFolder();
  }
  applyBundledToolDefaults();
  applyBundledYoutubeCookiesDefaults();
}

function persistServerConfig() {
  try {
    nodeLocalStorage.setItem(
      "serverConfig",
      JSON.stringify({
        ffmpegPath: serverConfig.ffmpegPath || "",
        downloadMode: serverConfig.downloadMode,
        downloadSubfolder: serverConfig.downloadSubfolder,
        ytDlpCookiesFromBrowser: serverConfig.ytDlpCookiesFromBrowser || "",
        ytDlpCookiesFile: serverConfig.ytDlpCookiesFile || "",
        ytDlpCommand: typeof serverConfig.ytDlpCommand === "string" && serverConfig.ytDlpCommand.trim()
          ? serverConfig.ytDlpCommand.trim()
          : "yt-dlp",
        ytDlpRemoteComponentsEnabled: serverConfig.ytDlpRemoteComponentsEnabled !== false,
        ytDlpRemoteComponentsSpec:
          typeof serverConfig.ytDlpRemoteComponentsSpec === "string" && serverConfig.ytDlpRemoteComponentsSpec.trim()
            ? serverConfig.ytDlpRemoteComponentsSpec.trim()
            : "ejs:github",
        ytDlpWarmupEnabled: serverConfig.ytDlpWarmupEnabled === true,
        ytDlpWarmupDelayMs: clampNumber(serverConfig.ytDlpWarmupDelayMs, { min: 0, max: 15000, fallback: 2500 }),
        ytDlpWarmupCooldownMs: clampNumber(serverConfig.ytDlpWarmupCooldownMs, {
          min: 0,
          max: 10 * 60 * 1000,
          fallback: 15000
        }),
        ytDlpWarmupBrowserCommand: serverConfig.ytDlpWarmupBrowserCommand || "",
        whisperCommand: serverConfig.whisperCommand || "",
        openaiKey: serverConfig.openaiKey || "",
        openaiBaseUrl: serverConfig.openaiBaseUrl || "",
        openaiModelDefault: serverConfig.openaiModelDefault || "gpt-4.1",
        youtubeLibraryFolder: serverConfig.youtubeLibraryFolder || "",
        moviesLibraryFolder: serverConfig.moviesLibraryFolder || ""
      })
    );
  } catch {}
}

let ytDlpHelpCache = {
  cmd: null,
  checkedAt: 0,
  hasRemoteComponents: false
};

async function probeYtDlpHasRemoteComponents(ytDlpCmd) {
  const now = Date.now();
  const shouldProbe = ytDlpHelpCache.cmd !== ytDlpCmd || now - ytDlpHelpCache.checkedAt > 10 * 60 * 1000;
  if (shouldProbe) {
    try {
      const { stdout, stderr } = await execOnce(ytDlpCmd, ["--help"], {});
      const helpText = `${stdout || ""}\n${stderr || ""}`;
      ytDlpHelpCache = {
        cmd: ytDlpCmd,
        checkedAt: now,
        hasRemoteComponents: helpText.toLowerCase().includes("--remote-components")
      };
    } catch {
      ytDlpHelpCache = { cmd: ytDlpCmd, checkedAt: now, hasRemoteComponents: false };
    }
  }
  return Boolean(ytDlpHelpCache.hasRemoteComponents);
}

async function getYtDlpRemoteComponentsArgs(ytDlpCmd) {
  if (serverConfig.ytDlpRemoteComponentsEnabled === false) {
    return [];
  }
  const spec =
    typeof serverConfig.ytDlpRemoteComponentsSpec === "string" && serverConfig.ytDlpRemoteComponentsSpec.trim()
      ? serverConfig.ytDlpRemoteComponentsSpec.trim()
      : "ejs:github";

  // Avoid passing flags that older yt-dlp versions don't support.
  const supported = await probeYtDlpHasRemoteComponents(ytDlpCmd);
  if (!supported) {
    return [];
  }
  return ["--remote-components", spec];
}

function resolveFfmpegPath(inputPath) {
  const candidates = [];
  if (inputPath) candidates.push(inputPath);
  if (serverConfig.ffmpegPath) candidates.push(serverConfig.ffmpegPath);
  const bundled = bundledToolPath("ffmpeg");
  if (bundled) candidates.push(bundled);
  const winDefault = path.join(downloadsDir, "ffmpeg.exe");
  const posixDefault = path.join(downloadsDir, "ffmpeg");
  candidates.push(winDefault, posixDefault, "ffmpeg");
  for (const p of candidates) {
    try {
      if (p === "ffmpeg") return p;
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return "ffmpeg";
}

function verifyFfmpeg(ffmpegPath) {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(ffmpegPath, ["-version"], { stdio: ["ignore", "ignore", "ignore"] });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve(true) : reject(new Error("ffmpeg failed"))));
    } catch (e) {
      reject(e);
    }
  });
}

function getStreamingData(info) {
  return info?.streaming_data || info?.streamingData || null;
}

function getAdaptiveFormats(streamingData) {
  if (!streamingData) return [];
  return (
    streamingData.adaptive_formats ||
    streamingData.adaptiveFormats ||
    streamingData.formats ||
    []
  );
}

function toMeta(format) {
  if (!format) return null;
  const mime = format.mime_type || format.mimeType || "";
  // Many raw streaming_data entries from InnerTube do NOT expose explicit
  // has_video / has_audio flags (they are present only on higher-level
  // Format objects). Rely on the MIME type instead so we actually see
  // adaptive video-only and audio-only formats and can build a mux plan.
  const hasVideo = /\bvideo\//.test(mime);
  const hasAudio = /\baudio\//.test(mime);
  return {
    format,
    mime,
    height: format.height || 0,
    bitrate: format.bitrate || format.average_bitrate || 0,
    hasVideo,
    hasAudio
  };
}

async function buildMuxPlan(info, innertube) {
  const streamingData = getStreamingData(info);
  if (!streamingData) return null;
  const adaptive = getAdaptiveFormats(streamingData);
  if (!adaptive.length) return null;
  fastify.log.info(
    {
      sample: adaptive.slice(0, 4).map((fmt) => ({
        itag: fmt.itag,
        mime: fmt.mime_type,
        hasUrl: Boolean(fmt.url),
        hasSig: Boolean(fmt.signature_cipher || fmt.signatureCipher || fmt.cipher)
      }))
    },
    "Adaptive formats sample"
  );

  // Filter out entries that clearly cannot be turned into a direct googlevideo
  // URL (no direct URL and no signature cipher). This avoids picking SABR-only
  // placeholders that youtubei.js cannot currently turn into downloadable
  // URLs, which would cause muxing to fail and always fall back to progressive.
  const metas = adaptive
    .filter((fmt) => {
      const hasUrl = hasDirectUrl(fmt);
      const hasSig =
        Boolean(fmt.signature_cipher) ||
        Boolean(fmt.signatureCipher) ||
        Boolean(fmt.cipher);
      return hasUrl || hasSig;
    })
    .map(toMeta)
    .filter(Boolean)
    .filter((m) => m.hasVideo || m.hasAudio);

  if (!metas.length) return null;

  const videosMp4 = metas.filter((m) => m.hasVideo && m.mime.includes("video/mp4"));
  const videosWebm = metas.filter((m) => m.hasVideo && m.mime.includes("video/webm"));
  const audiosMp4 = metas.filter((m) => m.hasAudio && m.mime.includes("audio/mp4"));
  const audiosWebm = metas.filter((m) => m.hasAudio && m.mime.includes("audio/webm"));

  const sortVideo = (a, b) =>
    (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0);
  const sortAudio = (a, b) => (b.bitrate || 0) - (a.bitrate || 0);

  videosMp4.sort(sortVideo);
  videosWebm.sort(sortVideo);
  audiosMp4.sort(sortAudio);
  audiosWebm.sort(sortAudio);

  const pickPlan = (videoMeta, audioMeta, container) =>
    videoMeta && audioMeta
      ? { video: videoMeta.format, audio: audioMeta.format, container }
      : null;

  const planMp4 = pickPlan(videosMp4[0], audiosMp4[0], "mp4");
  const planWebm = pickPlan(videosWebm[0], audiosWebm[0], "webm");

  const bestVideoOverall = [...videosMp4, ...videosWebm].sort(sortVideo)[0] || null;
  const bestAudioOverall = [...audiosMp4, ...audiosWebm].sort(sortAudio)[0] || null;
  const planMixed =
    bestVideoOverall && bestAudioOverall
      ? { video: bestVideoOverall.format, audio: bestAudioOverall.format, container: "mkv" }
      : null;

  const candidate = planMp4 || planWebm || planMixed;
  if (!candidate) return null;

  const videoUrl = await resolveFormatUrl(candidate.video, innertube);
  const audioUrl = await resolveFormatUrl(candidate.audio, innertube);
  if (!videoUrl || !audioUrl) {
    fastify.log.warn(
      {
        videoHasUrl: Boolean(candidate.video?.url),
        videoHasSig:
          Boolean(candidate.video?.signature_cipher) ||
          Boolean(candidate.video?.signatureCipher) ||
          Boolean(candidate.video?.cipher),
        videoHasDecipher: typeof candidate.video?.decipher === "function",
        audioHasUrl: Boolean(candidate.audio?.url),
        audioHasSig:
          Boolean(candidate.audio?.signature_cipher) ||
          Boolean(candidate.audio?.signatureCipher) ||
          Boolean(candidate.audio?.cipher),
        audioHasDecipher: typeof candidate.audio?.decipher === "function"
      },
      "Mux plan missing URLs; falling back"
    );
    return null;
  }

  const videoMime = candidate.video.mime_type || candidate.video.mimeType || "";
  const audioMime = candidate.audio.mime_type || candidate.audio.mimeType || "";

  return {
    container: candidate.container,
    videoUrl,
    audioUrl,
    videoHeight: candidate.video.height || 0,
    videoMime,
    audioMime
  };
}

async function resolveFormatUrl(format, innertube) {
  if (!format) return null;
  if (format.url) return format.url;
  if (typeof format.decipher === "function") {
    try {
      const deciphered = await format.decipher(innertube.session?.player);
      if (deciphered) return deciphered;
    } catch (err) {
      fastify.log.warn({ err: err?.message }, "Failed to decipher format URL");
    }
  }
  const sigCipher = format.signature_cipher || format.signatureCipher || format.cipher;
  if (sigCipher) {
    const params = new URLSearchParams(sigCipher);
    const url = params.get("url");
    if (url) return url;
  }
  return null;
}

async function muxAndStream(plan, safeTitle, reply) {
  const ffmpegPath = resolveFfmpegPath(serverConfig.ffmpegPath);
  if (ffmpegPath !== "ffmpeg" && !fs.existsSync(ffmpegPath)) {
    throw new Error(`FFmpeg executable not found at ${ffmpegPath}`);
  }
  const container = plan.container || "mp4";
  const outFormat = container === "mkv" ? "matroska" : container;
  const ext = container === "mkv" ? "mkv" : container;
  const contentType =
    container === "webm" ? "video/webm" : container === "mkv" ? "video/x-matroska" : "video/mp4";

  const commonArgs = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    plan.videoUrl,
    "-i",
    plan.audioUrl,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c",
    "copy"
  ];
  const mp4Flags = ["-movflags", "frag_keyframe+empty_moov"];
  const finalArgs =
    container === "mp4"
      ? [...commonArgs, ...mp4Flags, "-f", outFormat, "pipe:1"]
      : [...commonArgs, "-f", outFormat, "pipe:1"];

  reply
    .header("Content-Type", contentType)
    .header("Content-Disposition", `attachment; filename="${safeTitle}.${ext}"`)
    .header("Cache-Control", "no-store");

  const child = spawn(ffmpegPath, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => {
    try {
      const txt = String(chunk || "");
      if (txt && txt.toLowerCase().includes("error")) {
        fastify.log.warn({ ffmpeg: txt.trim() });
      }
    } catch {}
  });
  reply.raw.on("close", () => {
    try {
      child.kill("SIGKILL");
    } catch {}
  });
  return reply.send(child.stdout);
}

async function downloadWithYtDlp(videoUrl, safeTitle, reply, qualityParam) {
  const ytDlpCmd = resolveYtDlpCommand();
  const ffmpegPath = resolveFfmpegPath(serverConfig.ffmpegPath);
  await maybeWarmupYouTubeInBrowser(videoUrl).catch(() => {});
  // Use a temp file so yt-dlp behaves exactly like the CLI (writing to disk),
  // then stream that file to the browser. This avoids any stdout buffering
  // quirks and should match CLI performance (browser was WAY slower than CLI)
  const tmpDir = path.join(downloadsDir, "yt-saver-tmp");
  ensureDir(tmpDir);
  const tempFileBase = `${safeTitle || "youtube-video"}-${Date.now()}.mp4`;
  const tempFilePath = path.join(tmpDir, tempFileBase);

  const remoteArgs = await getYtDlpRemoteComponentsArgs(ytDlpCmd);
  const runOnce = async ({ useAltPlayerClient, skipCookies } = {}) => {
    const args = [
      videoUrl,
      ...getYtDlpCookieArgs({ skipCookies: Boolean(skipCookies) }),
      ...remoteArgs,
      ...buildYtDlpStabilityArgs({ useAltPlayerClient: Boolean(useAltPlayerClient) }),
      "-f",
      "bv*+ba/best",
      ...getYtDlpJsRuntimeArgs(),
      "--merge-output-format",
      "mp4",
      "-o",
      tempFilePath,
      "--quiet"
    ];

    // Apply a maximum resolution limit if provided (e.g. "1080", "720", ...).
    const allowedQualities = ["2160", "1440", "1080", "720", "480", "360"];
    if (qualityParam && allowedQualities.includes(String(qualityParam))) {
      args.push("-S", `res:${qualityParam}`);
    }

    if (ffmpegPath && ffmpegPath !== "ffmpeg") {
      args.push("--ffmpeg-location", ffmpegPath);
    }

    let stderrText = "";
    const child = spawnTool(ytDlpCmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    const onClose = () => {
      try {
        child.kill("SIGKILL");
      } catch {}
    };
    reply.raw.once("close", onClose);

    child.stderr.on("data", (chunk) => {
      try {
        const txt = String(chunk || "");
        if (txt) {
          stderrText = appendLimitedText(stderrText, txt);
          fastify.log.warn({ ytdlp: txt.trim() });
        }
      } catch {}
    });

    const exitCode = await new Promise((resolve) => {
      child.on("error", () => resolve(1));
      child.on("exit", (code) => resolve(typeof code === "number" ? code : 1));
    });
    try {
      reply.raw.removeListener("close", onClose);
    } catch {}
    return { exitCode, stderrText };
  };

  // 1) Attempt default WEB client first
  let result = await runOnce({ useAltPlayerClient: false });
  // 2) Chrome cookie DB copy often fails on Windows — retry without cookies
  if (
    result.exitCode !== 0 &&
    isYtDlpChromeCookieCopyError(result.stderrText) &&
    getYtDlpCookieArgs().length
  ) {
    fastify.log.warn(
      { videoId: extractVideoId(videoUrl) },
      "yt-dlp could not read Chrome cookies; retrying without cookies."
    );
    result = await runOnce({ useAltPlayerClient: false, skipCookies: true });
  }
  // 3) If we hit the reload wall, retry with alternate clients
  if (result.exitCode !== 0 && isYtDlpReloadError(result.stderrText)) {
    fastify.log.warn({ videoId: extractVideoId(videoUrl) }, "yt-dlp hit reload wall; retrying with alt player clients.");
    result = await runOnce({ useAltPlayerClient: true, skipCookies: isYtDlpChromeCookieCopyError(result.stderrText) });
  }
  if (result.exitCode !== 0) {
    throw new Error(`yt-dlp exited with code ${result.exitCode}`);
  }

  const stat = fs.statSync(tempFilePath);

  reply
    .header("Content-Type", "video/mp4")
    .header("Content-Disposition", `attachment; filename="${safeTitle}.mp4"`)
    .header("Content-Length", String(stat.size))
    .header("Cache-Control", "no-store");

  const stream = fs.createReadStream(tempFilePath);

  reply.raw.on("close", () => {
    try {
      fs.unlinkSync(tempFilePath);
    } catch {}
  });

  return reply.send(stream);
}
async function downloadTranscriptWithYtDlp(videoUrl, safeTitle, reply) {
  const ytDlpCmd = resolveYtDlpCommand();
  await maybeWarmupYouTubeInBrowser(videoUrl).catch(() => {});
  const tmpDir = path.join(downloadsDir, "yt-saver-tmp");
  ensureDir(tmpDir);
  const ffmpegPath = resolveFfmpegPath(serverConfig.ffmpegPath);

  const prefix = `${safeTitle || "youtube-video"}-${Date.now()}-subs`;
  const templatePath = path.join(tmpDir, `${prefix}.%(ext)s`);

  const remoteArgs = await getYtDlpRemoteComponentsArgs(ytDlpCmd);
  const makeBaseArgs = ({ useAltPlayerClient, skipCookies } = {}) => [
    videoUrl,
    ...getYtDlpCookieArgs({ skipCookies: Boolean(skipCookies) }),
    ...remoteArgs,
    ...buildYtDlpStabilityArgs({ useAltPlayerClient: Boolean(useAltPlayerClient) }),
    "--skip-download"
  ];
  // Prefer auto-generated English subs; match common regional variants.
  const autoSubsArgs = [
    "--write-auto-subs",
    "--sub-langs",
    "en.*,en",
    "--sub-format",
    "vtt",
    "--convert-subs",
    "vtt",
    ...getYtDlpJsRuntimeArgs(),
    "-o",
    templatePath,
    "--quiet"
  ];

  // Ensure yt-dlp can locate ffmpeg for any subtitle conversions (e.g. TTML → VTT).
  if (ffmpegPath && ffmpegPath !== "ffmpeg") {
    autoSubsArgs.push("--ffmpeg-location", ffmpegPath);
  }

  // Helper to invoke yt-dlp once for subtitles.
  async function runOnce(extraArgs, { useAltPlayerClient = false, skipCookies = false } = {}) {
    const args = [...makeBaseArgs({ useAltPlayerClient, skipCookies }), ...extraArgs];
    const child = spawnTool(ytDlpCmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderrText = "";

    child.stderr.on("data", (chunk) => {
      try {
        const txt = String(chunk || "");
        if (txt) {
          stderrText = appendLimitedText(stderrText, txt);
          fastify.log.warn({ ytdlp_subs: txt.trim() });
        }
      } catch {}
    });

    let exitCode = 0;
    await new Promise((resolve) => {
      child.on("error", (err) => {
        fastify.log.warn({ err: err?.message }, "yt-dlp (subs) process error");
        exitCode = exitCode || 1;
        resolve();
      });
      child.on("exit", (code) => {
        exitCode = typeof code === "number" ? code : exitCode;
        resolve();
      });
    });
    return { exitCode, stderrText };
  }

  // 1) Try auto-generated subs first
  let { exitCode, stderrText } = await runOnce(autoSubsArgs);
  if (
    exitCode !== 0 &&
    isYtDlpChromeCookieCopyError(stderrText) &&
    getYtDlpCookieArgs().length
  ) {
    fastify.log.warn(
      { videoId: extractVideoId(videoUrl) },
      "yt-dlp could not read Chrome cookies for transcript; retrying without cookies."
    );
    ({ exitCode, stderrText } = await runOnce(autoSubsArgs, { skipCookies: true }));
  }

  const files = fs.readdirSync(tmpDir);
  let candidates = files.filter((name) => name.startsWith(prefix));
  if (!candidates.length) {
    // 2) Fallback: try manually uploaded subtitles if auto-subs are missing
    const manualSubsArgs = [
      "--write-subs",
      "--sub-langs",
      "en.*,en",
      "--sub-format",
      "vtt",
      "--convert-subs",
      "vtt",
      ...getYtDlpJsRuntimeArgs(),
      "-o",
      templatePath,
      "--quiet"
    ];
    if (ffmpegPath && ffmpegPath !== "ffmpeg") {
      manualSubsArgs.push("--ffmpeg-location", ffmpegPath);
    }
    // Small backoff in case of transient limits
    await new Promise((r) => setTimeout(r, 1200));
    ({ exitCode, stderrText } = await runOnce(manualSubsArgs));
    if (
      exitCode !== 0 &&
      isYtDlpChromeCookieCopyError(stderrText) &&
      getYtDlpCookieArgs().length
    ) {
      ({ exitCode, stderrText } = await runOnce(manualSubsArgs, { skipCookies: true }));
    }

    const retryFiles = fs.readdirSync(tmpDir);
    candidates = retryFiles.filter((name) => name.startsWith(prefix));
    if (!candidates.length) {
      // Retry once with alternate clients if we hit the reload wall.
      if (exitCode !== 0 && isYtDlpReloadError(stderrText)) {
        await sleepMs(800);
        ({ exitCode, stderrText } = await runOnce(manualSubsArgs, { useAltPlayerClient: true }));
      }
      if (!candidates.length) {
        const finalFiles = fs.readdirSync(tmpDir);
        candidates = finalFiles.filter((name) => name.startsWith(prefix));
      }
      if (!candidates.length) {
        throw new Error(
          exitCode === 0
            ? "No transcript file produced by yt-dlp."
            : `Transcript download failed (exit code ${exitCode}) and no transcript file was created.`
        );
      }
    }
  }

  const chosen = candidates.find((n) => n.toLowerCase().endsWith(".vtt")) || candidates[0];
  const transcriptPath = path.join(tmpDir, chosen);
  const stat = fs.statSync(transcriptPath);

  reply
    .header("Content-Type", "text/plain; charset=utf-8")
    .header("Content-Disposition", `attachment; filename="${safeTitle}.vtt"`)
    .header("Content-Length", String(stat.size))
    .header("Cache-Control", "no-store");

  const stream = fs.createReadStream(transcriptPath);

  reply.raw.on("close", () => {
    try {
      fs.unlinkSync(transcriptPath);
    } catch {}
  });

  return reply.send(stream);
}

function loadLibraryFile() {
  try {
    if (!fs.existsSync(libraryFilePath)) {
      const initial = {
        version: 1,
        updatedAt: new Date().toISOString(),
        entries: []
      };
      fs.writeFileSync(libraryFilePath, JSON.stringify(initial));
      return initial;
    }
    const raw = fs.readFileSync(libraryFilePath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.entries)) {
      return parsed;
    }
  } catch (err) {
    fastify.log.error({ err: err?.message }, "Failed to load library.json; rebuilding.");
  }
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: []
  };
}

function saveLibraryState() {
  libraryState.updatedAt = new Date().toISOString();
  fs.writeFileSync(libraryFilePath, JSON.stringify(libraryState));
}

function addEntryToTitleIndex(byNormalizedTitle, key, entry) {
  if (!key || !entry) return;
  const list = byNormalizedTitle.get(key) || [];
  if (!list.includes(entry)) {
    list.push(entry);
  }
  byNormalizedTitle.set(key, list);
}

function buildLibraryIndex(data) {
  const byVideoId = new Map();
  const byNormalizedTitle = new Map();
  if (Array.isArray(data?.entries)) {
    for (const entry of data.entries) {
      if (entry?.videoId) {
        byVideoId.set(entry.videoId, entry);
      }
      if (entry?.normalizedTitle) {
        addEntryToTitleIndex(byNormalizedTitle, entry.normalizedTitle, entry);
      }
      for (const key of normalizeTitleKeysForMatch(entry.title || "")) {
        addEntryToTitleIndex(byNormalizedTitle, key, entry);
      }
    }
  }
  return { byVideoId, byNormalizedTitle };
}

function normalizeFsPath(p) {
  if (!p || typeof p !== "string") return "";
  return path.normalize(p);
}

function normalizeTitleKey(input) {
  if (!input || typeof input !== "string") return "";
  return input
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripWindowsCopySuffix(name) {
  if (!name || typeof name !== "string") return "";
  return name
    .replace(/\s*-\s*Copy(?:\s*\(\d+\))?$/iu, "")
    .replace(/\s*\(\d+\)$/u, "")
    .trim();
}

// Titles on disk follow sanitizeFileName(); YouTube titles often do not.
function normalizeTitleKeysForMatch(title) {
  const keys = [];
  const add = (key) => {
    if (key && !keys.includes(key)) keys.push(key);
  };
  if (!title || typeof title !== "string") return keys;
  add(normalizeTitleKey(title));
  const sanitized = sanitizeFileName(title);
  add(normalizeTitleKey(sanitized));
  add(normalizeTitleKey(stripWindowsCopySuffix(title)));
  add(normalizeTitleKey(stripWindowsCopySuffix(sanitized)));
  const episodeNums = extractEpisodeNumbersFromTitle(title);
  for (const num of episodeNums) {
    add(num);
    add(`episode ${num}`);
    add(`ep ${num}`);
  }
  return keys;
}

/** Episode indexes from titles like "188: …" or filenames "188 - …". */
function extractEpisodeNumbersFromTitle(title) {
  const numbers = new Set();
  if (!title || typeof title !== "string") return [];
  const trimmed = title.trim();
  const leading = trimmed.match(/^(\d{1,4})\s*[:.)-]/);
  if (leading) numbers.add(leading[1]);
  const epWord = trimmed.match(/\b(?:episode|ep)\s*[#.]?\s*(\d{1,4})\b/i);
  if (epWord) numbers.add(epWord[1]);
  for (const key of [normalizeTitleKey(trimmed), normalizeStoredFileTitle(trimmed)]) {
    const keyLead = key.match(/^(\d{1,4})\b/);
    if (keyLead) numbers.add(keyLead[1]);
  }
  return [...numbers];
}

function entryHasEpisodeNumber(entry, episodeNum) {
  if (!entry || !episodeNum) return false;
  const sources = [
    entry.title,
    entry.normalizedTitle,
    entry.video?.path ? path.basename(entry.video.path, path.extname(entry.video.path)) : null
  ].filter(Boolean);
  return sources.some((src) => extractEpisodeNumbersFromTitle(src).includes(episodeNum));
}

function findLibraryEntryByEpisodeNumber(episodeNum, channelKey, usedEntryIds) {
  if (!episodeNum) return null;
  const matches = libraryState.entries.filter((candidate) => {
    if (!candidate?.id || usedEntryIds.has(candidate.id)) return false;
    if (!candidate?.video?.path || !fs.existsSync(candidate.video.path)) return false;
    if (channelKey && candidate.channelKey && candidate.channelKey !== channelKey) {
      return false;
    }
    return entryHasEpisodeNumber(candidate, episodeNum);
  });
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];
  return matches.find((m) => m.videoId) || matches[0];
}

function normalizeStoredFileTitle(fileBaseName) {
  if (!fileBaseName || typeof fileBaseName !== "string") return "";
  const stripped = stripWindowsCopySuffix(fileBaseName);
  const sanitized = sanitizeFileName(stripped);
  return normalizeTitleKey(sanitized || stripped);
}

// Common tokens that cause false positives across a single channel
// (e.g. many videos share "the tim dillon show").
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "of",
  "to",
  "with",
  "in",
  "on",
  "for",
  "episode",
  "ep",
  "show",
  "podcast",
  "tim",
  "dillon"
]);

function normalizeChannelKey(input) {
  if (!input || typeof input !== "string") return "";
  return input
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9]+/g, "");
}

function tokenizeTitle(input) {
  const key = normalizeTitleKey(input);
  if (!key) return [];
  return key.split(" ").filter(Boolean);
}

function filterStopWords(tokens) {
  if (!Array.isArray(tokens) || !tokens.length) return [];
  return tokens.filter((t) => t && !STOP_WORDS.has(t));
}

function extractNumericTokens(tokens) {
  if (!Array.isArray(tokens) || !tokens.length) return [];
  return tokens.filter((t) => /^\d+$/.test(t));
}

function calculateTokenStats(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) {
    return { intersection: 0, union: 0, jaccard: 0, containmentA: 0, containmentB: 0 };
  }
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  const containmentA = setA.size > 0 ? intersection / setA.size : 0;
  const containmentB = setB.size > 0 ? intersection / setB.size : 0;
  return { intersection, union, jaccard, containmentA, containmentB };
}

function sanitizeSubfolder(input) {
  if (!input || typeof input !== "string") return "YouTube";
  return input
    .replace(/\\+/g, "/")
    .split("/")
    .map((segment) => segment.replace(/[<>:"|?*]+/g, "").trim())
    .filter(Boolean)
    .join("/");
}

function getDownloadRoots() {
  const roots = new Set();

  const configuredYoutube =
    typeof serverConfig.youtubeLibraryFolder === "string"
      ? serverConfig.youtubeLibraryFolder.trim()
      : "";
  if (configuredYoutube) {
    roots.add(configuredYoutube);
  } else {
    roots.add(path.join(downloadsDir, "YouTube"));
  }

  if (serverConfig.downloadMode === "subfolder") {
    const cleaned = sanitizeSubfolder(serverConfig.downloadSubfolder || "YouTube");
    if (cleaned) {
      roots.add(path.join(downloadsDir, ...cleaned.split("/")));
    }
  }

  return Array.from(roots);
}

/** Shipped with the extension: YoutubeDownloaderExtension/youtube-cookies.txt */
function discoverBundledYoutubeCookiesFile() {
  const candidates = [];
  // Parent of yt-saver-bridge is always YoutubeDownloaderExtension/
  candidates.push(path.resolve(BRIDGE_DIR, "..", "youtube-cookies.txt"));
  const extRoot =
    typeof process.env.STREAMSTEIN_EXTENSION_ROOT === "string"
      ? process.env.STREAMSTEIN_EXTENSION_ROOT.trim()
      : "";
  if (extRoot) {
    candidates.push(path.join(path.resolve(extRoot), "youtube-cookies.txt"));
  }
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // try next candidate
    }
  }
  return "";
}

function resolveYoutubeCookiesFilePath() {
  // Always prefer the bundled extension cookies file when it exists.
  const bundled = discoverBundledYoutubeCookiesFile();
  if (bundled) {
    return bundled;
  }
  const configured = (serverConfig.ytDlpCookiesFile || "").trim();
  if (configured) {
    try {
      if (fs.existsSync(configured)) {
        return path.resolve(configured);
      }
    } catch {
      // no valid cookies file
    }
  }
  return "";
}

function applyBundledYoutubeCookiesDefaults() {
  const bundled = discoverBundledYoutubeCookiesFile();
  if (!bundled) {
    return;
  }
  let changed = false;

  if (serverConfig.ytDlpCookiesFile !== bundled) {
    serverConfig.ytDlpCookiesFile = bundled;
    changed = true;
  }

  // Never use --cookies-from-browser when the shipped cookies file is present.
  if (serverConfig.ytDlpCookiesFromBrowser) {
    serverConfig.ytDlpCookiesFromBrowser = "";
    changed = true;
  }

  if (changed) {
    try {
      persistServerConfig();
    } catch {
      // non-fatal
    }
  }
}

function isYtDlpChromeCookieCopyError(stderrText) {
  return /could not copy chrome cookie database/i.test(String(stderrText || ""));
}

function getYtDlpCookieArgs(options = {}) {
  if (options.skipCookies) {
    return [];
  }
  const cookiesFile = resolveYoutubeCookiesFilePath();
  if (cookiesFile) {
    return ["--cookies", cookiesFile];
  }

  // Only fall back to browser cookies when no cookies file exists at all.
  const fromBrowser = (serverConfig.ytDlpCookiesFromBrowser || "").trim();
  if (fromBrowser) {
    return ["--cookies-from-browser", fromBrowser];
  }

  return [];
}

function summarizeLibrary() {
  const summary = {
    updatedAt: libraryState.updatedAt,
    totalEntries: libraryState.entries.length,
    videosWithFile: 0,
    audioWithFile: 0,
    transcriptsWithFile: 0,
    roots: getDownloadRoots()
  };
  for (const entry of libraryState.entries) {
    if (entry?.video && entry.video.path && fs.existsSync(entry.video.path)) {
      summary.videosWithFile++;
    }
    if (entry?.audio && entry.audio.path && fs.existsSync(entry.audio.path)) {
      summary.audioWithFile++;
    }
    if (
      entry?.transcript &&
      entry.transcript.path &&
      fs.existsSync(entry.transcript.path)
    ) {
      summary.transcriptsWithFile++;
    }
  }
  return summary;
}

async function rescanLibrary(options = {}) {
  // Fully rebuild the in-memory library from disk so that each physical
  // video + transcript pair collapses into a single logical entry. This
  // avoids stale/duplicate entries from older schemas and guarantees that
  // matching for the channel snapshot reflects the real files on disk.
  const previousEntries = Array.isArray(libraryState?.entries) ? libraryState.entries : [];
  const previousByPath = new Map();
  const previousVideoIdByTitle = new Map();
  for (const entry of previousEntries) {
    if (entry?.video?.path) {
      previousByPath.set(normalizeFsPath(entry.video.path), entry);
    }
    if (entry?.videoId) {
      const keys = new Set();
      if (entry.normalizedTitle) keys.add(entry.normalizedTitle);
      for (const key of normalizeTitleKeysForMatch(entry.title || "")) {
        keys.add(key);
      }
      for (const key of keys) {
        if (key && !previousVideoIdByTitle.has(key)) {
          previousVideoIdByTitle.set(key, entry.videoId);
        }
      }
    }
  }

  const catalogByPath = new Map();
  try {
    const catalogData = youtubeCatalog.loadCatalog();
    for (const rec of catalogData.records || []) {
      if (rec?.filePath) {
        catalogByPath.set(normalizeFsPath(rec.filePath), rec);
      }
    }
  } catch {
    // catalog is optional during rescan
  }

  libraryState = {
    version: libraryState?.version || 1,
    updatedAt: new Date().toISOString(),
    entries: []
  };
  libraryIndex = {
    byVideoId: new Map(),
    byNormalizedTitle: new Map()
  };

  const roots = getDownloadRoots();
  const seenPaths = new Set();
  let scanned = 0;
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    const files = walkFiles(root);
    for (const filePath of files) {
      const ext = path.extname(filePath).toLowerCase();
      const isVideo = isVideoExtension(ext);
      const isAudio = isAudioExtension(ext);
      const isTranscript = TRANSCRIPT_EXTENSIONS.has(ext);
      if (!isVideo && !isAudio && !isTranscript) continue;
      scanned++;
      const baseName = path.basename(filePath, ext);
      const displayTitle = stripWindowsCopySuffix(baseName);
      const stats = safeStat(filePath);
      const normPath = normalizeFsPath(filePath);
      const previous = previousByPath.get(normPath);
      const catalogRec = catalogByPath.get(normPath);
      const fileNorm = normalizeStoredFileTitle(baseName);
      const restoredVideoId =
        previous?.videoId ||
        catalogRec?.videoId ||
        previousVideoIdByTitle.get(fileNorm) ||
        null;
      registerLibraryFile(
        {
          videoId: restoredVideoId,
          title: catalogRec?.title || displayTitle,
          normalizedTitle: fileNorm,
          path: filePath,
          type: isTranscript ? "transcript" : isAudio ? "audio" : "video",
          size: stats?.size ?? null,
          mtime: stats?.mtimeMs ?? null,
          source: "scan",
          watchUrl: catalogRec?.watchUrl || null,
          shortUrl: catalogRec?.shortUrl || null,
          thumbnailUrl: catalogRec?.thumbnailUrl || null,
          channelId: catalogRec?.channelId || null,
          channelName: catalogRec?.channelName || null
        },
        { deferSave: true, skipCatalog: true }
      );
      seenPaths.add(normPath);
    }
  }
  pruneMissingFiles(seenPaths);
  saveLibraryState();
  libraryIndex = buildLibraryIndex(libraryState);
  invalidateCatalogMatchCache();
  const summary = summarizeLibrary();
  return {
    scannedFiles: scanned,
    librarySummary: summary
  };
}

function walkFiles(root) {
  return walkFolderMediaFiles(root, { mediaOnly: false });
}

function walkFolderMediaFiles(root, options = {}) {
  const mediaOnly = options.mediaOnly !== false;
  const recursive = options.recursive !== false;
  const results = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let dirents = [];
    try {
      dirents = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      fastify.log.warn({ err: err?.message, current }, "Failed to read directory during scan");
      continue;
    }
    for (const dirent of dirents) {
      const full = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        if (recursive) stack.push(full);
      } else if (dirent.isFile()) {
        if (!mediaOnly) {
          results.push(full);
          continue;
        }
        const kind = mediaKindFromPath(full);
        if (kind) results.push({ path: full, kind });
      }
    }
  }
  return results;
}

function listFolderMediaMissingTranscripts(folderPath, options = {}) {
  const recursive = options.recursive !== false;
  const mediaFiles = walkFolderMediaFiles(folderPath, { mediaOnly: true, recursive });
  const targets = [];
  for (const item of mediaFiles) {
    if (!item?.path || hasSiblingVtt(item.path)) continue;
    const stats = safeStat(item.path);
    targets.push({
      path: item.path,
      kind: item.kind,
      name: path.basename(item.path),
      size: stats?.size ?? null,
      mtime: stats?.mtimeMs ?? null
    });
  }
  targets.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  return targets;
}

async function runAsrOnMediaPath(sourcePath, options = {}) {
  const model = options.model || "medium.en";
  const language = options.language || "en";
  const previewSeconds = Math.max(0, Number(options.previewSeconds || 0) || 0);
  const engine = options.engine === "faster-whisper" ? "faster-whisper" : "whisper";
  const videoId = options.videoId || null;

  const asrResult =
    engine === "faster-whisper"
      ? await generateTranscriptWithFasterWhisper({
          sourcePath,
          model,
          language,
          previewSeconds
        })
      : await generateTranscriptWithWhisper({
          sourcePath,
          model,
          language,
          previewSeconds
        });
  const transcriptPath = asrResult.transcriptPath;

  try {
    const baseName = path.basename(sourcePath, path.extname(sourcePath));
    const stats = safeStat(transcriptPath);
    registerLibraryFile(
      {
        videoId: videoId || null,
        title: baseName,
        normalizedTitle: normalizeTitleKey(baseName),
        path: transcriptPath,
        type: "transcript",
        size: stats?.size ?? null,
        mtime: stats?.mtimeMs ?? null,
        source: "asr"
      },
      { deferSave: false }
    );
  } catch (e) {
    fastify.log.warn({ err: e?.message }, "Failed to register ASR transcript in library");
  }

  return asrResult;
}

async function runFolderAsrBatch(targets, options = {}) {
  return withAsrLock(async () => {
    const model = options.model || "medium.en";
    const language = options.language || "en";
    const previewSeconds = Math.max(0, Number(options.previewSeconds || 0) || 0);
    const engine = options.engine === "faster-whisper" ? "faster-whisper" : "whisper";
    const results = {
      total: targets.length,
      completed: 0,
      failed: 0,
      items: []
    };

    asrProgress = {
      active: true,
      phase: "batch",
      currentChunk: 0,
      totalChunks: 0,
      engine,
      batchActive: true,
      batchCurrent: 0,
      batchTotal: targets.length,
      batchFile: null
    };

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const sourcePath = target.path;
      asrProgress.batchCurrent = i + 1;
      asrProgress.batchFile = target.name || path.basename(sourcePath);
      asrProgress.phase = "batch-file";

      if (!sourcePath || !fs.existsSync(sourcePath) || hasSiblingVtt(sourcePath)) {
        results.items.push({
          path: sourcePath,
          ok: false,
          skipped: true,
          error: "File missing or transcript already exists."
        });
        continue;
      }

      try {
        const asrResult = await runAsrOnMediaPath(sourcePath, {
          model,
          language,
          previewSeconds,
          engine
        });
        results.completed += 1;
        results.items.push({
          path: sourcePath,
          ok: true,
          transcriptPath: asrResult.transcriptPath
        });
      } catch (err) {
        results.failed += 1;
        results.items.push({
          path: sourcePath,
          ok: false,
          error: err?.message || "Transcription failed."
        });
      }
    }

    asrProgress = {
      active: false,
      phase: "done",
      currentChunk: 0,
      totalChunks: 0,
      engine,
      batchActive: false,
      batchCurrent: results.completed + results.failed,
      batchTotal: targets.length,
      batchFile: null
    };

    return results;
  });
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function registerLibraryFile(meta, options = {}) {
  if (!meta || !meta.path) {
    return null;
  }
  const now = new Date().toISOString();
  const normalizedPath = normalizeFsPath(meta.path);
  const normalizedTitle =
    meta.normalizedTitle ||
    normalizeStoredFileTitle(meta.title || path.basename(meta.path, path.extname(meta.path)));
  const channelKeyFromPath = deriveChannelKeyFromPath(normalizedPath);
  let entry = meta.videoId ? libraryIndex.byVideoId.get(meta.videoId) : null;
  if (!entry && normalizedTitle) {
    const candidates = libraryIndex.byNormalizedTitle.get(normalizedTitle);
    if (candidates && candidates.length) {
      entry = candidates[0];
    }
  }
  if (!entry && meta.title) {
    for (const key of normalizeTitleKeysForMatch(meta.title)) {
      const candidates = libraryIndex.byNormalizedTitle.get(key);
      if (candidates && candidates.length) {
        entry = candidates[0];
        break;
      }
    }
  }

  const urls = youtubeCatalog.buildYoutubeUrls(meta.videoId, meta.watchUrl);

  if (!entry) {
    entry = {
      id: `lib-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      videoId: meta.videoId || null,
      title: meta.title || path.basename(meta.path),
      normalizedTitle: normalizedTitle || null,
      channelKey: channelKeyFromPath || null,
      watchUrl: meta.watchUrl || urls.watchUrl || null,
      shortUrl: meta.shortUrl || urls.shortUrl || null,
      thumbnailUrl: meta.thumbnailUrl || urls.thumbnailUrl || null,
      channelId: meta.channelId || null,
      channelName: meta.channelName || null,
      video: null,
      audio: null,
      transcript: null,
      createdAt: now,
      updatedAt: now
    };
    libraryState.entries.push(entry);
    refreshEntryIndexes(entry, null, null);
  } else {
    const prevKey = entry.normalizedTitle || null;
    const prevVideoId = entry.videoId || null;
    if (meta.videoId && !entry.videoId) {
      entry.videoId = meta.videoId;
    }
    if (normalizedTitle && normalizedTitle !== entry.normalizedTitle) {
      entry.normalizedTitle = normalizedTitle;
    }
    if (meta.title) {
      entry.title = meta.title;
    }
    if (channelKeyFromPath) {
      entry.channelKey = channelKeyFromPath;
    }
    if (meta.watchUrl) entry.watchUrl = meta.watchUrl;
    else if (!entry.watchUrl && urls.watchUrl) entry.watchUrl = urls.watchUrl;
    if (meta.shortUrl) entry.shortUrl = meta.shortUrl;
    else if (!entry.shortUrl && urls.shortUrl) entry.shortUrl = urls.shortUrl;
    if (meta.thumbnailUrl) entry.thumbnailUrl = meta.thumbnailUrl;
    else if (!entry.thumbnailUrl && urls.thumbnailUrl) entry.thumbnailUrl = urls.thumbnailUrl;
    if (meta.channelId) entry.channelId = meta.channelId;
    if (meta.channelName) entry.channelName = meta.channelName;
    refreshEntryIndexes(entry, prevKey, prevVideoId);
  }

  entry.updatedAt = now;
  const record = {
    path: normalizedPath,
    size: meta.size ?? null,
    mtime: meta.mtime ?? null,
    recordedAt: now,
    source: meta.source || "register"
  };

  if (meta.type === "transcript") {
    entry.transcript = record;
  } else if (meta.type === "audio") {
    entry.audio = record;
  } else {
    entry.video = record;
  }

  if (!options.deferSave) {
    saveLibraryState();
    libraryIndex = buildLibraryIndex(libraryState);
  }

  if (!options.skipCatalog && meta.source !== "scan") {
    try {
      const stats = safeStat(normalizedPath);
      youtubeCatalog.recordDownload({
        status: "completed",
        videoId: entry.videoId,
        watchUrl: entry.watchUrl,
        shortUrl: entry.shortUrl,
        thumbnailUrl: entry.thumbnailUrl,
        title: entry.title,
        normalizedTitle: entry.normalizedTitle,
        channelId: entry.channelId,
        channelName: entry.channelName,
        channelKey: entry.channelKey,
        assetType: meta.type === "transcript" ? "transcript" : meta.type === "audio" ? "audio" : "video",
        path: normalizedPath,
        intendedPath: meta.intendedPath || null,
        size: meta.size ?? stats?.size ?? null,
        mtime: meta.mtime ?? stats?.mtimeMs ?? null,
        source: meta.source || "register",
        quality: meta.quality || null,
        libraryEntryId: entry.id
      });
      notifyYoutubeCatalogUpdated({
        videoId: entry.videoId || null,
        title: entry.title || null,
        assetType: meta.type === "transcript" ? "transcript" : meta.type === "audio" ? "audio" : "video",
        source: meta.source || "register"
      });
    } catch (err) {
      fastify.log.warn({ err: err?.message }, "Failed to update YouTube catalog");
    }
  }

  return entry;
}

function refreshEntryIndexes(entry, previousTitleKey, previousVideoId) {
  if (!entry) return;
  if (previousVideoId && previousVideoId !== entry.videoId) {
    libraryIndex.byVideoId.delete(previousVideoId);
  }
  if (entry.videoId) {
    libraryIndex.byVideoId.set(entry.videoId, entry);
  }

  if (previousTitleKey && previousTitleKey !== entry.normalizedTitle) {
    const prevList = libraryIndex.byNormalizedTitle.get(previousTitleKey);
    if (prevList) {
      libraryIndex.byNormalizedTitle.set(
        previousTitleKey,
        prevList.filter((item) => item !== entry)
      );
      if (!libraryIndex.byNormalizedTitle.get(previousTitleKey)?.length) {
        libraryIndex.byNormalizedTitle.delete(previousTitleKey);
      }
    }
  }

  if (entry.normalizedTitle) {
    const list = libraryIndex.byNormalizedTitle.get(entry.normalizedTitle) || [];
    if (!list.includes(entry)) {
      list.push(entry);
    }
    libraryIndex.byNormalizedTitle.set(entry.normalizedTitle, list);
  }
}

function pruneMissingFiles(seenPaths) {
  let removed = 0;
  libraryState.entries = libraryState.entries.filter((entry) => {
    let changed = false;
    if (
      entry.video &&
      entry.video.path &&
      !seenPaths.has(normalizeFsPath(entry.video.path)) &&
      !fs.existsSync(entry.video.path)
    ) {
      entry.video = null;
      changed = true;
    }
    if (
      entry.audio &&
      entry.audio.path &&
      !seenPaths.has(normalizeFsPath(entry.audio.path)) &&
      !fs.existsSync(entry.audio.path)
    ) {
      entry.audio = null;
      changed = true;
    }
    if (
      entry.transcript &&
      entry.transcript.path &&
      !seenPaths.has(normalizeFsPath(entry.transcript.path)) &&
      !fs.existsSync(entry.transcript.path)
    ) {
      entry.transcript = null;
      changed = true;
    }
    const keep = entry.video || entry.audio || entry.transcript || entry.videoId;
    if (!keep) {
      removed++;
      if (entry.videoId) {
        libraryIndex.byVideoId.delete(entry.videoId);
      }
      if (entry.normalizedTitle) {
        const list = libraryIndex.byNormalizedTitle.get(entry.normalizedTitle);
        if (list) {
          libraryIndex.byNormalizedTitle.set(
            entry.normalizedTitle,
            list.filter((item) => item !== entry)
          );
          if (!libraryIndex.byNormalizedTitle.get(entry.normalizedTitle)?.length) {
            libraryIndex.byNormalizedTitle.delete(entry.normalizedTitle);
          }
        }
      }
      return false;
    }
    if (changed) {
      refreshEntryIndexes(entry, entry.normalizedTitle, entry.videoId);
    }
    return true;
  });
  return removed;
}

function deriveChannelKeyFromPath(filePath) {
  try {
    const normalized = normalizeFsPath(filePath);
    const parts = normalized.split(path.sep).filter(Boolean);
    const youtubeIndex = parts.lastIndexOf("YouTube");
    if (youtubeIndex !== -1 && youtubeIndex < parts.length - 1) {
      return normalizeChannelKey(parts[youtubeIndex + 1]);
    }
    if (parts.length >= 2) {
      return normalizeChannelKey(parts[parts.length - 2]);
    }
  } catch {
    return "";
  }
  return "";
}

let catalogMatchCache = null;

function invalidateCatalogMatchCache() {
  catalogMatchCache = null;
}

function buildCatalogMatchIndex() {
  const catalog = youtubeCatalog.loadCatalog();
  const byVideoId = new Map();
  const byNormalizedTitle = new Map();
  const transcriptVideoIds = new Set();
  let videoCount = 0;

  for (const rec of catalog.records || []) {
    if (!rec) continue;
    const assetType = rec.assetType || "video";
    if (assetType === "transcript") {
      if (rec.videoId && rec.filePath && fs.existsSync(rec.filePath)) {
        transcriptVideoIds.add(rec.videoId);
      }
      continue;
    }
    if (assetType === "audio") continue;

    const filePath = rec.filePath ? normalizeFsPath(rec.filePath) : "";
    if (!filePath || !fs.existsSync(filePath)) continue;
    const ext = path.extname(filePath).toLowerCase();
    if (!isVideoExtension(ext)) continue;

    videoCount += 1;
    if (rec.videoId) {
      byVideoId.set(rec.videoId, rec);
    }
    const titleKeys = normalizeTitleKeysForMatch(
      rec.title || rec.fileName || path.basename(filePath, ext)
    );
    if (rec.normalizedTitle) titleKeys.push(rec.normalizedTitle);
    for (const key of titleKeys) {
      if (!key) continue;
      const list = byNormalizedTitle.get(key) || [];
      if (!list.includes(rec)) list.push(rec);
      byNormalizedTitle.set(key, list);
    }
  }

  return {
    updatedAt: catalog.updatedAt,
    byVideoId,
    byNormalizedTitle,
    transcriptVideoIds,
    videoCount
  };
}

function getCatalogMatchIndex() {
  const catalog = youtubeCatalog.loadCatalog();
  if (
    !catalogMatchCache ||
    catalogMatchCache.updatedAt !== catalog.updatedAt
  ) {
    catalogMatchCache = buildCatalogMatchIndex();
  }
  return catalogMatchCache;
}

function resolveCatalogMatch(videoId, titleKeys) {
  const index = getCatalogMatchIndex();
  if (!index.videoCount) return null;

  let rec = null;
  let matchedBy = null;

  if (videoId && index.byVideoId.has(videoId)) {
    rec = index.byVideoId.get(videoId);
    matchedBy = "catalogVideoId";
  } else if (titleKeys.length) {
    for (const key of titleKeys) {
      const candidates = index.byNormalizedTitle.get(key);
      if (candidates?.length) {
        rec = candidates[0];
        matchedBy = "catalogTitle";
        break;
      }
    }
  }

  if (!rec?.filePath || !fs.existsSync(rec.filePath)) return null;

  const hasVideo = isVideoExtension(path.extname(rec.filePath).toLowerCase());
  const hasTranscript =
    (rec.videoId && index.transcriptVideoIds.has(rec.videoId)) ||
    hasSiblingVtt(rec.filePath);

  return {
    hasVideo,
    hasTranscript,
    matchedBy,
    recordedTitle: rec.title || null,
    videoId: rec.videoId || videoId || null
  };
}

function checkLibraryMatches(videos, options = {}) {
  const summary = {
    total: Array.isArray(videos) ? videos.length : 0,
    haveVideo: 0,
    haveTranscript: 0,
    missingVideo: 0,
    missingTranscript: 0
  };
  const normalizedResults = [];
  const channelKey =
    options && typeof options.channelHint === "string"
      ? normalizeChannelKey(options.channelHint)
      : "";
  const debugMode = options.debug === true;

  if (!Array.isArray(videos)) {
    return { summary, videos: normalizedResults };
  }

  // Track which entries we already matched via fuzzy route to reduce
  // pathological cases where many channel items latch onto a single file.
  const usedEntryIds = new Set();

  videos.forEach((item, index) => {
    const videoId = typeof item?.videoId === "string" ? item.videoId : null;
    const providedTitle = typeof item?.title === "string" ? item.title : "";
    const titleKeys =
      providedTitle.length > 0
        ? normalizeTitleKeysForMatch(providedTitle)
        : typeof item?.normalizedTitle === "string" && item.normalizedTitle
          ? [item.normalizedTitle]
          : [];
    const providedNorm = titleKeys[0] || "";
    let entry = null;
    let matchedBy = null;
    const debugLog = [];

    if (debugMode) {
      debugLog.push(
        `Input title: "${providedTitle || "<empty>"}" (keys=${titleKeys.join(" | ") || "<empty>"})`
      );
    }

    if (videoId && libraryIndex.byVideoId.has(videoId)) {
      entry = libraryIndex.byVideoId.get(videoId);
      matchedBy = "videoId";
      if (debugMode) debugLog.push(`Matched by videoId: ${videoId}`);
    } else if (options.includeLoose !== false && titleKeys.length) {
      let matchedKey = null;
      for (const key of titleKeys) {
        const candidates = libraryIndex.byNormalizedTitle.get(key);
        if (candidates && candidates.length) {
          entry = candidates[0];
          matchedKey = key;
          break;
        }
      }
      if (entry) {
        matchedBy = "normalizedTitle";
        if (debugMode) debugLog.push(`Matched by normalizedTitle: ${matchedKey}`);
      } else {
        const episodeNums = extractEpisodeNumbersFromTitle(providedTitle);
        for (const episodeNum of episodeNums) {
          const episodeEntry = findLibraryEntryByEpisodeNumber(
            episodeNum,
            channelKey,
            usedEntryIds
          );
          if (episodeEntry) {
            entry = episodeEntry;
            matchedBy = "episodeNumber";
            usedEntryIds.add(episodeEntry.id);
            if (debugMode) debugLog.push(`Matched by episodeNumber: ${episodeNum}`);
            break;
          }
        }
      }
      if (!entry) {
        // Fuzzy match on normalized title tokens (bag-of-words), but apply
        // stricter gating to avoid false positives across a channel with highly
        // repetitive naming.
        const rawTokensProvided = tokenizeTitle(providedNorm || providedTitle);
        const tokensProvided = filterStopWords(rawTokensProvided);
        const numsProvided = extractNumericTokens(rawTokensProvided);
        let bestScore = 0;
        let bestEntry = null;
        let bestEntryId = null;
        let bestDebug = null;

        if (debugMode) {
          debugLog.push(
            `Token count: provided=${tokensProvided.length} raw=${
              rawTokensProvided.length
            }${
              tokensProvided.length ? ` (${tokensProvided.join(", ")})` : ""
            }`
          );
        }

        const candidatePool = libraryState.entries.filter((candidate) => {
          if (!channelKey) return true;
          if (!candidate?.channelKey) return true;
          return candidate.channelKey === channelKey;
        });
        const searchEntries = candidatePool.length ? candidatePool : libraryState.entries;

        for (const candidate of searchEntries) {
          if (!candidate?.normalizedTitle) continue;
          const rawTokensCandidate = candidate._titleTokensRaw
            ? candidate._titleTokensRaw
            : tokenizeTitle(candidate.normalizedTitle);
          const tokensCandidate = candidate._titleTokens
            ? candidate._titleTokens
            : filterStopWords(rawTokensCandidate);
          const numsCandidate = candidate._titleNums
            ? candidate._titleNums
            : extractNumericTokens(rawTokensCandidate);
          if (!candidate._titleTokens) {
            candidate._titleTokens = tokensCandidate;
          }
          if (!candidate._titleTokensRaw) {
            candidate._titleTokensRaw = rawTokensCandidate;
          }
          if (!candidate._titleNums) {
            candidate._titleNums = numsCandidate;
          }

          const stats = calculateTokenStats(tokensProvided, tokensCandidate);
          let score = stats.jaccard; // base score on de-noised tokens

          // Boost if the search query is substantially contained in the filename
          if (tokensProvided.length >= 2 && stats.containmentA >= 0.8) {
            score = Math.max(score, 0.9);
          }
          // Also boost if the local filename is contained in the search query
          if (tokensCandidate.length >= 2 && stats.containmentB >= 0.8) {
            score = Math.max(score, 0.9);
          }

          // Strong gating: if both sides have numbers (e.g., episode indexes),
          // require at least one number in common.
          const hasNums = numsProvided.length && numsCandidate.length;
          const shareNum =
            hasNums && numsProvided.some((n) => numsCandidate.includes(n));
          if (hasNums && !shareNum) {
            // Treat as very weak similarity if episode numbers disagree.
            score = Math.min(score, 0.1);
          }

          if (score > bestScore) {
            bestScore = score;
            bestEntry = candidate;
            bestEntryId = candidate.id || null;
            if (debugMode) {
              bestDebug = `score=${score.toFixed(2)} numsProvided=[${numsProvided.join(
                ","
              )}] numsCandidate=[${numsCandidate.join(",")}]`;
            }
          }

          // Log mid-tier matches for debugging
          if (debugMode && score >= 0.2 && score < 0.4) {
            debugLog.push(
              `Near miss: "${candidate.title || candidate.normalizedTitle}" score=${score.toFixed(
                2
              )}, tokens=${tokensCandidate.join(", ")}`
            );
          }
        }

        // Require a much stronger score than before to avoid "everything matches".
        const FUZZY_THRESHOLD = 0.55;
        // Also require at least two non-stopword tokens in common.
        const requireTokenOverlap = tokensProvided.length >= 3;

        if (bestEntry && bestScore >= FUZZY_THRESHOLD) {
          // Avoid reusing the same entry for many items when relying on fuzzy only.
          if (!usedEntryIds.has(bestEntryId)) {
            const interStats = calculateTokenStats(
              tokensProvided,
              bestEntry._titleTokens || []
            );
            if (!requireTokenOverlap || interStats.intersection >= 2) {
              entry = bestEntry;
              matchedBy = "fuzzyTitle";
              usedEntryIds.add(bestEntryId);
              if (debugMode)
                debugLog.push(
                  `Matched fuzzy: "${
                    bestEntry.title || bestEntry.normalizedTitle
                  }" ${bestDebug || `score=${bestScore.toFixed(2)}`}`
                );
            } else if (debugMode) {
              debugLog.push(
                `Rejected fuzzy best (insufficient token overlap): "${bestEntry.title || bestEntry.normalizedTitle}" ${bestDebug ||
                  `score=${bestScore.toFixed(2)}`}`
              );
            }
          } else if (debugMode) {
            debugLog.push(
              `Rejected fuzzy best (already used by another item): "${
                bestEntry.title || bestEntry.normalizedTitle
              }"`
            );
          }
        } else if (debugMode) {
          debugLog.push(
            `No fuzzy match >= ${FUZZY_THRESHOLD}. Best=${bestScore.toFixed(2)} for "${
              bestEntry?.title || bestEntry?.normalizedTitle || "n/a"
            }"`
          );
        }
      }
    } else if (debugMode) {
       debugLog.push("No videoId and no normalized title provided.");
    }
    
    let hasVideo = false;
    let hasTranscript = false;
    let catalogHit = null;

    if (entry && entry.video && entry.video.path && fs.existsSync(entry.video.path)) {
      hasVideo = true;
      try {
        const videoPath = entry.video.path;
        const dir = path.dirname(videoPath);
        const base = path.basename(videoPath, path.extname(videoPath));
        const transcriptPath = path.join(dir, `${base}.vtt`);
        hasTranscript = fs.existsSync(transcriptPath);
      } catch {
        hasTranscript = false;
      }
    } else if (!entry) {
      catalogHit = resolveCatalogMatch(videoId, titleKeys);
      if (catalogHit) {
        hasVideo = catalogHit.hasVideo;
        hasTranscript = catalogHit.hasTranscript;
        matchedBy = catalogHit.matchedBy;
        if (debugMode) {
          debugLog.push(`Matched via youtube-catalog.json (${catalogHit.matchedBy})`);
        }
      }
    } else if (debugMode && entry) {
       debugLog.push(`Entry found but file check failed. Path: ${entry?.video?.path} Exists: ${entry?.video?.path ? fs.existsSync(entry.video.path) : 'false'}`);
    }
    
    if (hasVideo) summary.haveVideo += 1;
    else summary.missingVideo += 1;
    if (hasTranscript) summary.haveTranscript += 1;
    else summary.missingTranscript += hasVideo ? 1 : 0;

    normalizedResults.push({
      index,
      videoId,
      normalizedTitle: providedNorm || null,
      hasVideo,
      hasTranscript,
      matchedBy,
      entryId: entry?.id || null,
      recordedTitle: entry?.title || catalogHit?.recordedTitle || null,
      debug: debugMode ? debugLog.join("; ") : null
    });
  });

  return { summary, videos: normalizedResults };
}

function ensureDir(target) {
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (err) {
    if (err.code !== "EEXIST") {
      throw err;
    }
  }
}

async function execOnce(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const { env: optionEnv, ...rest } = options;
      const child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...rest,
        env: buildToolSpawnEnv(optionEnv),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        try {
          const txt = String(chunk || "");
          if (txt) stdout += txt;
        } catch {}
      });
      child.stderr.on("data", (chunk) => {
        try {
          const txt = String(chunk || "");
          if (txt) stderr += txt;
        } catch {}
      });
      child.on("error", (e) => reject(e));
      child.on("exit", (code) => {
        if (code === 0) resolve({ code, stdout, stderr });
        else reject(new Error(stderr || `${cmd} exited with code ${code}`));
      });
    } catch (e) {
      reject(e);
    }
  });
}

function formatVttTimestamp(sec) {
  const ms = Math.max(0, Math.floor(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msPart = ms % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(msPart, 3)}`;
}

function renderYouTubeStyleVtt(segments, lang = "en") {
  const lines = [];
  lines.push("WEBVTT");
  lines.push("Kind: captions");
  lines.push(`Language: ${lang}`);
  lines.push("");
  for (const seg of segments) {
    const start = Number(seg.start || 0);
    const end = Number(seg.end || 0);
    let text = String(seg.text || "").trim();
    if (!text) continue;
    const startStr = formatVttTimestamp(start);
    const endStr = formatVttTimestamp(end);
    const words = text.split(/\s+/g).filter(Boolean);
    const duration = Math.max(0.001, end - start);
    const inline = [];
    if (words.length) {
      inline.push(words[0]);
      for (let i = 1; i < words.length; i++) {
        const t = start + (duration * i) / words.length;
        inline.push(`<${formatVttTimestamp(t)}><c> ${words[i]}</c>`);
      }
    }
    lines.push(`${startStr} --> ${endStr} align:start position:0%`);
    lines.push(inline.join(""));
    lines.push("");
    // Also emit a plain-text duplicate cue to better resemble YouTube exports
    lines.push(`${startStr} --> ${endStr} align:start position:0%`);
    lines.push(text);
    lines.push("");
  }
  return lines.join("\n");
}

function parseTimecodeToSeconds(s) {
  const m = String(s).trim().match(/^(\d{2}):(\d{2}):(\d{2})([.,](\d{1,3}))?$/);
  if (!m) return 0;
  const hh = Number(m[1]) || 0;
  const mm = Number(m[2]) || 0;
  const ss = Number(m[3]) || 0;
  const ms = Number(m[5] || 0);
  return hh * 3600 + mm * 60 + ss + ms / 1000;
}

function parseVttToSegments(text) {
  const lines = String(text || "").split(/\r?\n/);
  const segments = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || !line.includes("-->")) continue;
    const times = line.split("-->");
    const start = parseTimecodeToSeconds(times[0].split(/\s+/)[0]);
    const end = parseTimecodeToSeconds(times[1].split(/\s+/)[0]);
    const buf = [];
    i++;
    while (i < lines.length && lines[i].trim() !== "") {
      buf.push(lines[i]);
      i++;
    }
    const txt = buf.join(" ").replace(/<[^>]+>/g, "").trim();
    if (txt) segments.push({ start, end, text: txt });
  }
  return segments;
}

function parseSrtToSegments(text) {
  const blocks = String(text || "").split(/\r?\n\r?\n/);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) continue;
    const timeLine = lines[1];
    if (!timeLine || !timeLine.includes("-->")) continue;
    const times = timeLine.split("-->");
    const start = parseTimecodeToSeconds(times[0].replace(",", ".").trim());
    const end = parseTimecodeToSeconds(times[1].replace(",", ".").trim());
    const txt = lines.slice(2).join(" ").replace(/<[^>]+>/g, "").trim();
    if (txt) segments.push({ start, end, text: txt });
  }
  return segments;
}

async function probeDurationSeconds(filePath) {
  const ffmpegPath = resolveFfmpegPath(serverConfig.ffmpegPath);
  const candidates = [];
  if (ffmpegPath && ffmpegPath !== "ffmpeg") {
    const dir = path.dirname(ffmpegPath);
    candidates.push(path.join(dir, "ffprobe.exe"), path.join(dir, "ffprobe"));
  }
  candidates.push("ffprobe");
  for (const exe of candidates) {
    try {
      const { stdout } = await execOnce(exe, [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nw=1:nk=1",
        filePath
      ]);
      const n = Number(String(stdout || "").trim());
      if (Number.isFinite(n) && n > 0) {
        return n;
      }
    } catch {
      continue;
    }
  }
  return 0;
}

function slugifyBase(input) {
  return (
    String(input || "")
      .normalize("NFKD")
      .replace(/[^\w\s-]+/g, "")
      .replace(/\s+/g, "-")
      .toLowerCase() || "audio"
  );
}

function tokenizeCommand(input) {
  if (!input || typeof input !== "string") return [];
  const tokens = [];
  let current = "";
  let inQuotes = false;
  let quoteChar = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === quoteChar) {
        inQuotes = false;
        quoteChar = "";
      } else if (ch === "\\" && i + 1 < input.length) {
        current += input[++i];
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuotes = true;
      quoteChar = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

async function runWhisperOnAudio(audioPath, tmpDir, model, language, options = {}) {
  const ffmpegResolved = resolveFfmpegPath(serverConfig.ffmpegPath);
  const ffmpegDir =
    ffmpegResolved && ffmpegResolved !== "ffmpeg" ? path.dirname(ffmpegResolved) : "";
  const whisperEnv = {
    ...process.env,
    FFMPEG_BINARY: ffmpegResolved || "ffmpeg",
    PATH: ffmpegDir ? `${ffmpegDir}${path.delimiter}${process.env.PATH || ""}` : process.env.PATH
  };
  const preferDevice = options.preferDevice === "cpu" ? "cpu" : "cuda";
  const deviceOrder = preferDevice === "cpu" ? ["cpu", "cuda"] : ["cuda", "cpu"];

  let ok = false;
  let lastErr = null;
  let lastLabel = "";
  let chosenDevice = null;
  let gpuFallbackError = null;

  for (const device of deviceOrder) {
    const common = [
      "--model",
      model,
      "--language",
      language,
      "--task",
      "transcribe",
      "--output_dir",
      tmpDir,
      "--verbose",
      "False",
      "--device",
      device
    ];
    const appendFormatArgs = (args) => [audioPath, "--output_format", "all", ...args];
    const attempts = [];
    const resolvedPython = getResolvedWhisperPythonCmd();

    if (serverConfig.whisperCommand) {
      const tokens = tokenizeCommand(serverConfig.whisperCommand);
      if (tokens.length) {
        const customCmd = tokens.shift();
        const customArgs = tokens.concat(appendFormatArgs(common));
        attempts.push({
          cmd: customCmd,
          args: customArgs,
          label: serverConfig.whisperCommand,
          env: whisperEnv
        });
      }
    } else if (resolvedPython && resolvedPython !== "python") {
      attempts.push({
        cmd: resolvedPython,
        args: ["-m", "whisper", ...appendFormatArgs(common)],
        label: `${resolvedPython} -m whisper`,
        env: whisperEnv
      });
    }

    if (!attempts.length) {
      attempts.push(
        { cmd: "whisper", args: appendFormatArgs(common), label: "whisper", env: whisperEnv },
        {
          cmd: "python3",
          args: ["-m", "whisper", ...appendFormatArgs(common)],
          label: "python3 -m whisper",
          env: whisperEnv
        },
        {
          cmd: "python",
          args: ["-m", "whisper", ...appendFormatArgs(common)],
          label: "python -m whisper",
          env: whisperEnv
        },
        {
          cmd: "py",
          args: ["-m", "whisper", ...appendFormatArgs(common)],
          label: "py -m whisper",
          env: whisperEnv
        }
      );
    }

    let deviceOk = false;
    let deviceErr = null;
    let deviceLabel = "";
    for (const a of attempts) {
      try {
        await execOnce(a.cmd, a.args, { env: a.env });
        deviceOk = true;
        deviceErr = null;
        deviceLabel = a.label || a.cmd;
        break;
      } catch (e) {
        deviceErr = e;
        deviceLabel = a.label || a.cmd;
      }
    }

    if (deviceOk) {
      ok = true;
      chosenDevice = device;
      lastErr = null;
      lastLabel = deviceLabel;
      break;
    }

    if (device === "cuda" && !gpuFallbackError && deviceErr) {
      gpuFallbackError = deviceErr.message || String(deviceErr);
    }
    lastErr = deviceErr;
    lastLabel = deviceLabel;
  }

  if (!ok) {
    throw new Error(
      `Failed to invoke Whisper CLI (last attempt: ${lastLabel}). ${lastErr?.message || ""}`
    );
  }

  const wrapResult = (segs) => ({
    segments: segs,
    device: chosenDevice || preferDevice,
    gpuFallbackError
  });

  const base = path.basename(audioPath, path.extname(audioPath));
  // Poll for outputs – on some environments Whisper flushes files shortly after exit.
  let files = [];
  for (let i = 0; i < 40; i++) {
    try {
      files = fs.readdirSync(tmpDir);
      const found = files.some(
        (f) =>
          f.startsWith(base) &&
          (f.toLowerCase().endsWith(".json") ||
            f.toLowerCase().endsWith(".vtt") ||
            f.toLowerCase().endsWith(".srt"))
      );
      if (found) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  files = fs.readdirSync(tmpDir);
  const hasPrefix = (name) => name.startsWith(base);

  const jsonName = files.find((f) => f.toLowerCase().endsWith(".json") && hasPrefix(f));
  if (jsonName) {
    try {
      const raw = fs.readFileSync(path.join(tmpDir, jsonName), "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.segments)) {
        return wrapResult(
          parsed.segments.map((s) => ({ start: s.start, end: s.end, text: s.text }))
        );
      }
    } catch {}
  }
  const vttName = files.find((f) => f.toLowerCase().endsWith(".vtt") && hasPrefix(f));
  if (vttName) {
    const raw = fs.readFileSync(path.join(tmpDir, vttName), "utf8");
    return wrapResult(parseVttToSegments(raw));
  }
  const srtName = files.find((f) => f.toLowerCase().endsWith(".srt") && hasPrefix(f));
  if (srtName) {
    const raw = fs.readFileSync(path.join(tmpDir, srtName), "utf8");
    return wrapResult(parseSrtToSegments(raw));
  }

  // Fallback: scan any recent whisper outputs in tmpDir (in case basename changed)
  const recent = files
    .filter((f) => /\.(json|vtt|srt)$/i.test(f))
    .map((f) => ({ f, t: safeStat(path.join(tmpDir, f))?.mtimeMs || 0 }))
    .sort((a, b) => b.t - a.t)
    .slice(0, 3);
  for (const { f } of recent) {
    const full = path.join(tmpDir, f);
    try {
      if (f.toLowerCase().endsWith(".json")) {
        const raw = fs.readFileSync(full, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.segments)) {
          return wrapResult(
            parsed.segments.map((s) => ({ start: s.start, end: s.end, text: s.text }))
          );
        }
      } else if (f.toLowerCase().endsWith(".vtt")) {
        const raw = fs.readFileSync(full, "utf8");
        const segs = parseVttToSegments(raw);
        if (segs.length) return wrapResult(segs);
      } else if (f.toLowerCase().endsWith(".srt")) {
        const raw = fs.readFileSync(full, "utf8");
        const segs = parseSrtToSegments(raw);
        if (segs.length) return wrapResult(segs);
      }
    } catch {}
  }
  throw new Error(
    `Whisper command completed but produced no outputs. Check ${tmpDir} for files. Last command: ${lastLabel}.`
  );
}

async function generateTranscriptWithWhisper(options) {
  const sourcePath = options.sourcePath;
  const model = options.model || "medium.en";
  const language = options.language || "en";
  const previewSeconds = Math.max(0, Number(options.previewSeconds || 0) || 0);

  if (!fs.existsSync(sourcePath)) {
    throw new Error("Source file not found for ASR.");
  }

  asrProgress = {
    active: true,
    phase: previewSeconds > 0 ? "preview" : "preparing-audio",
    currentChunk: 0,
    totalChunks: 0,
    engine: "whisper"
  };

  const tmpDir = asrWorkDir;
  ensureDir(tmpDir);

  const base = path.basename(sourcePath, path.extname(sourcePath));
  const slug = slugifyBase(base);
  const audioPrefix = `${slug}-${Date.now()}`;
  const audioPath = path.join(tmpDir, `${audioPrefix}.wav`);
  fastify.log.info(
    { sourcePath, audioPath, previewSeconds, model, language },
    "Starting Whisper transcription job"
  );

  // 1) Extract 16 kHz mono audio with ffmpeg (optionally trim).
  const ffmpegPath = resolveFfmpegPath(serverConfig.ffmpegPath);
  const ffArgs = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    sourcePath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000"
  ];
  if (previewSeconds > 0) {
    ffArgs.push("-t", String(previewSeconds));
  }
  ffArgs.push("-f", "wav", audioPath);
  await execOnce(ffmpegPath || "ffmpeg", ffArgs);

  // 2) Run whisper — single pass for preview, chunked for full.
  const segments = [];
  const CHUNK_SECONDS = 120;
  let whisperDevice = null;
  let whisperFallbackError = null;
  if (previewSeconds > 0) {
    const result = await runWhisperOnAudio(audioPath, tmpDir, model, language, {
      preferDevice: "cuda"
    });
    segments.push(...result.segments);
    whisperDevice = result.device || whisperDevice;
    if (!whisperFallbackError && result.gpuFallbackError) {
      whisperFallbackError = result.gpuFallbackError;
    }
  } else {
    const total =
      (await probeDurationSeconds(sourcePath)) ||
      (await probeDurationSeconds(audioPath)) ||
      0;
    const hasTotal = total > 0;
    const estimatedChunks = hasTotal ? Math.ceil(total / CHUNK_SECONDS) : 0;
    asrProgress.phase = "chunking";
    asrProgress.totalChunks = estimatedChunks || 0;
    let offset = 0;
    let chunkIndex = 0;
    while (true) {
      if (hasTotal && offset >= total - 0.01) {
        break;
      }
      const remaining = hasTotal ? Math.max(0, total - offset) : CHUNK_SECONDS;
      const span = hasTotal ? Math.min(CHUNK_SECONDS, remaining) : CHUNK_SECONDS;
      if (span <= 0.5) {
        break;
      }
      asrProgress.phase = "chunk";
      asrProgress.currentChunk = chunkIndex + 1;
      const chunkPath = path.join(tmpDir, `${audioPrefix}-chunk-${chunkIndex}.wav`);
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        String(offset),
        "-t",
        String(span),
        "-i",
        audioPath,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        chunkPath
      ];
      let chunkOk = true;
      try {
        await execOnce(ffmpegPath || "ffmpeg", args);
      } catch (err) {
        const msg = err?.message || "";
        if (/Output file is empty|Invalid data/i.test(msg)) {
          chunkOk = false;
        } else {
          throw err;
        }
      }
      const chunkStat = safeStat(chunkPath);
      if (!chunkOk || !chunkStat || chunkStat.size < 2048) {
        try {
          if (chunkStat) fs.unlinkSync(chunkPath);
        } catch {}
        break;
      }
      const result = await runWhisperOnAudio(chunkPath, tmpDir, model, language, {
        preferDevice: whisperDevice || "cuda"
      });
      if (!whisperDevice) {
        whisperDevice = result.device || whisperDevice;
      }
      if (!whisperFallbackError && result.gpuFallbackError) {
        whisperFallbackError = result.gpuFallbackError;
      }
      const segs = result.segments;
      for (const s of segs) {
        segments.push({ start: s.start + offset, end: s.end + offset, text: s.text });
      }
      try {
        fs.unlinkSync(chunkPath);
      } catch {}
      offset += span;
      chunkIndex += 1;
      if (!hasTotal && segs.length === 0 && chunkStat.size < 4096) {
        break;
      }
    }
  }
  if (!segments.length) {
    throw new Error("Whisper did not produce any transcript output.");
  }

  // 3) Render VTT in YouTube-like format
  const vttText = renderYouTubeStyleVtt(segments, language);

  // 4) Save next to video
  const videoDir = path.dirname(sourcePath);
  const targetVttPath = path.join(videoDir, `${base}.vtt`);
  fs.writeFileSync(targetVttPath, vttText, "utf8");

  // Cleanup temp files
  try {
    fs.unlinkSync(audioPath);
  } catch {}
  // Remove whisper leftovers for this audioPrefix
  try {
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.startsWith(audioPrefix));
    for (const f of leftovers) {
      try {
        fs.unlinkSync(path.join(tmpDir, f));
      } catch {}
    }
  } catch {}

  const resolvedDevice = whisperDevice || "unknown";
  const whisperMode =
    resolvedDevice === "cuda" ? "gpu" : resolvedDevice === "cpu" ? "cpu" : "unknown";

  asrProgress = {
    active: false,
    phase: "done",
    currentChunk: asrProgress.totalChunks || asrProgress.currentChunk || 1,
    totalChunks: asrProgress.totalChunks || asrProgress.currentChunk || 1,
    engine: "whisper"
  };

  return {
    transcriptPath: targetVttPath,
    whisperDevice: resolvedDevice,
    whisperMode,
    whisperFallbackError: whisperFallbackError || null
  };
}

// ===== Faster-Whisper integration =====
// Spawns Python to run faster-whisper and returns parsed segments.
async function runFasterWhisperOnAudio(audioPath, model, language, options = {}) {
  const preferDevice = options.preferDevice === "cpu" ? "cpu" : "cuda";
  const pythonCmd = getResolvedWhisperPythonCmd();
  const script = [
    "import sys, json",
    "try:",
    "  from faster_whisper import WhisperModel",
    "except Exception as e:",
    "  print(json.dumps({'error': 'faster-whisper not installed: %s' % str(e)}))",
    "  sys.exit(0)",
    "audio_path = sys.argv[1]",
    "model_name = sys.argv[2]",
    "device = sys.argv[3]",
    "compute_type = sys.argv[4]",
    "language = sys.argv[5] if len(sys.argv) > 5 else ''",
    "try:",
    "  model = WhisperModel(model_name, device=device, compute_type=compute_type)",
    "  kwargs = {'beam_size': 5}",
    "  if language:",
    "    kwargs['language'] = language",
    "  segments, info = model.transcribe(audio_path, **kwargs)",
    "  out = {'segments': [], 'device': device, 'language': getattr(info, 'language', language)}",
    "  for s in segments:",
    "    out['segments'].append({'start': float(getattr(s,'start',0.0)), 'end': float(getattr(s,'end',0.0)), 'text': getattr(s,'text','')})",
    "  print(json.dumps(out))",
    "except Exception as e:",
    "  print(json.dumps({'error': str(e)}))"
  ].join("\n");
  // Attempt multiple compute types and devices to mitigate GPU crashes (e.g. Windows 0xC0000409).
  const deviceOrder = preferDevice === "cpu" ? ["cpu", "cuda"] : ["cuda", "cpu"];
  const computeTypesByDevice = {
    cuda:
      options.computeTypesGpu && Array.isArray(options.computeTypesGpu) && options.computeTypesGpu.length
        ? options.computeTypesGpu
        : ["float16", "int8_float16", "int8"],
    cpu:
      options.computeTypesCpu && Array.isArray(options.computeTypesCpu) && options.computeTypesCpu.length
        ? options.computeTypesCpu
        : ["int8", "float32"]
  };
  let lastErr = null;
  for (const device of deviceOrder) {
    const computeTypes = computeTypesByDevice[device] || [];
    for (const computeType of computeTypes) {
      try {
        const args = ["-c", script, audioPath, model, device, computeType, language || ""];
        const { stdout } = await execOnce(pythonCmd, args, {});
        let parsed = null;
        try {
          parsed = JSON.parse(stdout || "{}");
        } catch {
          parsed = { error: "Failed to parse faster-whisper output.", raw: stdout || "" };
        }
        if (parsed && parsed.error) {
          lastErr = new Error(parsed.error);
          continue;
        }
        const segments = Array.isArray(parsed?.segments) ? parsed.segments : [];
        const usedDevice = parsed?.device || device;
        if (segments.length) {
          return { segments, device: usedDevice };
        }
        lastErr = new Error("No segments produced by faster-whisper.");
      } catch (e) {
        // execOnce rejected (e.g., python crashed with an access violation). Try next attempt.
        lastErr = e;
      }
    }
  }
  throw new Error(lastErr?.message || "faster-whisper failed on all attempts.");
}

async function generateTranscriptWithFasterWhisper(options) {
  const sourcePath = options.sourcePath;
  const model = options.model || "medium.en";
  const language = options.language || "en";
  const previewSeconds = Math.max(0, Number(options.previewSeconds || 0) || 0);

  if (!fs.existsSync(sourcePath)) {
    throw new Error("Source file not found for ASR.");
  }

  asrProgress = {
    active: true,
    phase: previewSeconds > 0 ? "preview" : "preparing-audio",
    currentChunk: 0,
    totalChunks: 0,
    engine: "faster-whisper"
  };

  const tmpDir = asrWorkDir;
  ensureDir(tmpDir);

  const base = path.basename(sourcePath, path.extname(sourcePath));
  const slug = slugifyBase(base);
  const audioPrefix = `${slug}-${Date.now()}`;
  const audioPath = path.join(tmpDir, `${audioPrefix}.wav`);
  fastify.log.info(
    { sourcePath, audioPath, previewSeconds, model, language },
    "Starting Faster-Whisper transcription job"
  );

  // Extract audio (optionally trimmed)
  const ffmpegPath = resolveFfmpegPath(serverConfig.ffmpegPath);
  const ffArgs = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    sourcePath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000"
  ];
  if (previewSeconds > 0) {
    ffArgs.push("-t", String(previewSeconds));
  }
  ffArgs.push("-f", "wav", audioPath);
  await execOnce(ffmpegPath || "ffmpeg", ffArgs);

  // Run faster-whisper
  const segments = [];
  const CHUNK_SECONDS = 120;
  let fwDevice = null;
  if (previewSeconds > 0) {
    asrProgress.phase = "preview";
    asrProgress.currentChunk = 1;
    asrProgress.totalChunks = 1;
    const result = await runFasterWhisperOnAudio(audioPath, model, language, { preferDevice: "cuda" });
    segments.push(...(result.segments || []));
    fwDevice = result.device || fwDevice;
  } else {
    const total =
      (await probeDurationSeconds(sourcePath)) ||
      (await probeDurationSeconds(audioPath)) ||
      0;
    const hasTotal = total > 0;
    const estimatedChunks = hasTotal ? Math.ceil(total / CHUNK_SECONDS) : 0;
    asrProgress.phase = "chunking";
    asrProgress.totalChunks = estimatedChunks || 0;
    let offset = 0;
    let chunkIndex = 0;
    while (true) {
      if (hasTotal && offset >= total - 0.01) {
        break;
      }
      const remaining = hasTotal ? Math.max(0, total - offset) : CHUNK_SECONDS;
      const span = hasTotal ? Math.min(CHUNK_SECONDS, remaining) : CHUNK_SECONDS;
      if (span <= 0.5) {
        break;
      }
      asrProgress.phase = "chunk";
      asrProgress.currentChunk = chunkIndex + 1;
      const chunkPath = path.join(tmpDir, `${audioPrefix}-fw-chunk-${chunkIndex}.wav`);
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        String(offset),
        "-t",
        String(span),
        "-i",
        audioPath,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        chunkPath
      ];
      let chunkOk = true;
      try {
        await execOnce(ffmpegPath || "ffmpeg", args);
      } catch (err) {
        const msg = err?.message || "";
        if (/Output file is empty|Invalid data/i.test(msg)) {
          chunkOk = false;
        } else {
          throw err;
        }
      }
      const chunkStat = safeStat(chunkPath);
      if (!chunkOk || !chunkStat || chunkStat.size < 2048) {
        try { if (chunkStat) fs.unlinkSync(chunkPath); } catch {}
        break;
      }
      const result = await runFasterWhisperOnAudio(chunkPath, model, language, { preferDevice: fwDevice || "cuda" });
      if (!fwDevice) fwDevice = result.device || fwDevice;
      const segs = result.segments || [];
      for (const s of segs) {
        segments.push({ start: s.start + offset, end: s.end + offset, text: s.text });
      }
      try { fs.unlinkSync(chunkPath); } catch {}
      offset += span;
      chunkIndex += 1;
      if (!hasTotal && segs.length === 0 && chunkStat.size < 4096) {
        break;
      }
    }
  }
  if (!segments.length) {
    throw new Error("Faster-Whisper did not produce any transcript output.");
  }

  // Render VTT and save next to the video
  const vttText = renderYouTubeStyleVtt(segments, language);
  const videoDir = path.dirname(sourcePath);
  const targetVttPath = path.join(videoDir, `${base}.vtt`);
  fs.writeFileSync(targetVttPath, vttText, "utf8");

  // Cleanup
  try { fs.unlinkSync(audioPath); } catch {}
  try {
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.startsWith(audioPrefix));
    for (const f of leftovers) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
    }
  } catch {}

  asrProgress = {
    active: false,
    phase: "done",
    currentChunk: asrProgress.totalChunks || asrProgress.currentChunk || 1,
    totalChunks: asrProgress.totalChunks || asrProgress.currentChunk || 1,
    engine: "faster-whisper"
  };
  const resolvedDevice = fwDevice || "unknown";
  const whisperMode = resolvedDevice === "cuda" ? "gpu" : resolvedDevice === "cpu" ? "cpu" : "unknown";
  return { transcriptPath: targetVttPath, whisperDevice: resolvedDevice, whisperMode };
}

/*
This command works to download HD videos with Node using yt-dlp directly: yt-dlp -f bv*+ba/best --js-runtimes node --merge-output-format mp4 -o test2.mp4 https://www.youtube.com/watch?v=QtxVdC7pBQM --ffmpeg-location C:\Users\PC\Documents\Downloader_Extension\ffmpeg*/

// =========================
// Chat: creators, corpus, news, generation
// =========================

function listCreators() {
  const byKey = new Map();
  for (const e of libraryState.entries) {
    const key =
      e.channelKey ||
      (e.video && e.video.path ? deriveChannelKeyFromPath(e.video.path) : null) ||
      null;
    const hasTranscript = Boolean(e.transcript?.path);
    if (!key || !hasTranscript) continue;
    const folder = path.dirname(e.transcript.path);
    const item =
      byKey.get(key) ||
      {
        key,
        label: key,
        count: 0,
        folders: new Map()
      };
    item.count += 1;
    item.folders.set(folder, (item.folders.get(folder) || 0) + 1);
    byKey.set(key, item);
  }
  const result = [];
  for (const item of byKey.values()) {
    let bestFolder = null;
    let bestCount = -1;
    for (const [f, c] of item.folders.entries()) {
      if (c > bestCount) {
        bestFolder = f;
        bestCount = c;
      }
    }
    result.push({
      key: item.key,
      label: item.key,
      count: item.count,
      rootDir: bestFolder
    });
  }
  result.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return result;
}

function resolveCreator(channelKey) {
  const norm = normalizeChannelKey(channelKey);
  const list = listCreators();
  return list.find((c) => c.key === norm) || null;
}

function collectCreatorTranscripts(channelKey) {
  const norm = normalizeChannelKey(channelKey);
  const paths = [];
  for (const e of libraryState.entries) {
    const key =
      e.channelKey ||
      (e.video && e.video.path ? deriveChannelKeyFromPath(e.video.path) : null) ||
      null;
    if (key !== norm) continue;
    if (e.transcript && e.transcript.path && fs.existsSync(e.transcript.path)) {
      paths.push(e.transcript.path);
    }
  }
  paths.sort((a, b) => (safeStat(b)?.mtimeMs || 0) - (safeStat(a)?.mtimeMs || 0));
  return paths;
}

function readVttCorpusFromPaths(paths, options = {}) {
  const maxChars = Number(options.maxChars || 240_000);
  const maxFiles = Number(options.maxFiles || 80);
  const pickEveryNth = Number(options.pickEveryNth || 6);
  const examples = [];
  let totalChars = 0;
  let used = 0;
  for (let i = 0; i < paths.length && used < maxFiles && totalChars < maxChars; i++) {
    const p = paths[i];
    try {
      const raw = fs.readFileSync(p, "utf8");
      const segs = parseVttToSegments(raw);
      if (!segs.length) continue;
      for (let j = 0; j < segs.length; j += pickEveryNth) {
        const t = (segs[j].text || "").trim();
        if (!t) continue;
        const clip = t.length > 320 ? t.slice(0, 320) : t;
        examples.push(clip);
        totalChars += clip.length + 1;
        if (totalChars >= maxChars) break;
      }
      used++;
    } catch {}
  }
  return { examples, transcriptsUsed: used, totalExamples: examples.length };
}

async function fetchNewsFromGdelt(topics = [], days = 7, maxPerTopic = 10) {
  const results = [];
  const clampDays = Math.max(1, Math.min(14, Number(days || 7) || 7));
  const base = "https://api.gdeltproject.org/api/v2/doc/doc";
  const fetchOne = async (q) => {
    const url =
      `${base}?query=${encodeURIComponent(q)}&mode=ArtList&format=json` +
      `&maxrecords=${Math.max(1, Math.min(50, maxPerTopic || 10))}&sort=DateDesc&timespan=${clampDays}d`;
    try {
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      const arts = Array.isArray(data?.articles) ? data.articles : [];
      return arts.map((a) => ({
        title: a.title || "",
        url: a.url || "",
        seendate: a.seendate || null,
        lang: a.language || null,
        source: a.sourceCountry || null
      }));
    } catch {
      return [];
    }
  };
  for (const t of topics) {
    const items = await fetchOne(t);
    results.push({ topic: t, items });
  }
  return results;
}

function buildNewsBullets(newsResults) {
  const lines = [];
  for (const grp of newsResults) {
    if (!grp?.items || !grp.items.length) continue;
    lines.push(`Topic: ${grp.topic}`);
    const top = grp.items.slice(0, 6);
    for (const a of top) {
      const title = (a.title || "").trim();
      const u = a.url || "";
      if (title) lines.push(`- ${title}${u ? ` (${u})` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildStylePrimerFromExamples(examples) {
  const header =
    "You are to model comedic monologue style. Here are authentic transcript lines to learn voice, rhythm, and tone:";
  const bullet = examples.map((t) => `• ${t}`).join("\n");
  const guidance =
    "\nGuidelines:\n- Preserve comedic pacing, cadence, and persona quirks.\n- Avoid disclaimers or meta-talk about being AI.\n- Use vivid specifics and callbacks.\n- Keep language natural and performative; write for speech, not prose.\n";
  return `${header}\n${bullet}\n${guidance}`;
}

function getOpenAIClient() {
  const cfg = {
    apiKey: serverConfig.openaiKey
  };
  if (serverConfig.openaiBaseUrl && serverConfig.openaiBaseUrl.trim()) {
    cfg.baseURL = serverConfig.openaiBaseUrl.trim();
  }
  return new OpenAI(cfg);
}

async function generateOutlineWithOpenAI({ client, model, minutes, topics, stylePrimer }) {
  const segments = Math.max(6, Math.min(24, Math.round(minutes / 5)));
  const system = [
    "You are a showrunner generating a comedic monologue outline.",
    "Return strict JSON with fields: segments: [{title, minutes, bullets: [string]}].",
    `Target total minutes: ${minutes}. Segment count close to ${segments}.`
  ].join("\n");
  const user = [
    "High-level topics (optional):",
    (topics && topics.length ? topics.join(", ") : "(none)"),
    "",
    "Style primer:",
    stylePrimer.slice(0, 10000)
  ].join("\n");
  const resp = await client.chat.completions.create({
    model,
    temperature: 0.6,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    response_format: { type: "json_object" }
  });
  const text = resp?.choices?.[0]?.message?.content || "{}";
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.segments) && parsed.segments.length) {
      return parsed.segments;
    }
  } catch {}
  const out = [];
  for (let i = 0; i < segments; i++) {
    out.push({ title: `Segment ${i + 1}`, minutes: Math.round(minutes / segments), bullets: [] });
  }
  return out;
}

async function generateMonologueBlock({ client, model, stylePrimer, newsBullets, segment, minutes, episodeTitle }) {
  const approxWords = Math.max(150, Math.round(minutes * 150));
  const system = [
    "You are a comedy writer crafting a spoken monologue segment.",
    "Output only the monologue text for performance (no headings, no disclaimers, no stage directions).",
    "Write for speech, with rhythm and punchlines. Use callbacks where natural."
  ].join("\n");
  const user = [
    `Episode: ${episodeTitle || "New Episode"}`,
    "",
    "Style primer (excerpts):",
    stylePrimer.slice(0, 12000),
    "",
    segment?.title ? `Segment focus: ${segment.title}` : "",
    segment?.bullets && segment.bullets.length ? `Segment bullets:\n- ${segment.bullets.join("\n- ")}` : "",
    newsBullets ? `Relevant current items:\n${newsBullets}` : "",
    "",
    `Length target: ~${approxWords} words (spoken).`,
    "Please produce only the monologue paragraphs."
  ].join("\n");
  const resp = await client.chat.completions.create({
    model,
    temperature: 0.8,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });
  const text = (resp?.choices?.[0]?.message?.content || "").trim();
  return text;
}

function splitIntoSentences(text) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const parts = cleaned.split(/(?<=[.!?])\s+/g).map((s) => s.trim()).filter(Boolean);
  return parts;
}

function countWords(s) {
  return (String(s || "").trim().match(/\b[\w'-]+\b/g) || []).length;
}

function sentencesToTimedSegments(sentences, totalSeconds) {
  const wordsPerSec = 2.5;
  const durations = sentences.map((s) => Math.max(1.2, countWords(s) / wordsPerSec));
  const sum = durations.reduce((a, b) => a + b, 0) || 1;
  const scale = totalSeconds / sum;
  const scaled = durations.map((d) => Math.max(0.8, d * scale));
  const segs = [];
  let t = 0;
  for (let i = 0; i < sentences.length; i++) {
    const start = t;
    const end = t + scaled[i];
    segs.push({ start, end, text: sentences[i] });
    t = end;
  }
  return segs;
}

function buildVttFromBlocks(blocks, totalMinutes) {
  const totalSeconds = Math.max(60, Math.round(Number(totalMinutes || 60) * 60));
  const joined = (blocks || []).join("\n\n");
  const sentences = splitIntoSentences(joined);
  if (!sentences.length) {
    throw new Error("No content generated.");
  }
  const segs = sentencesToTimedSegments(sentences, totalSeconds);
  return renderYouTubeStyleVtt(segs, "en");
}

function uniqueEpisodeFilename(baseDir, baseNameNoExt) {
  const safeBase = sanitizeFileName(baseNameNoExt || "New Episode");
  let name = `${safeBase}.vtt`;
  let p = path.join(baseDir, name);
  let idx = 2;
  while (fs.existsSync(p)) {
    name = `${safeBase} (${idx}).vtt`;
    p = path.join(baseDir, name);
    idx++;
  }
  return p;
}

async function runChatJob(job) {
  job.phase = "collecting-corpus";
  job.message = "Collecting style corpus from transcripts…";
  const creator = resolveCreator(job.creatorKey);
  if (!creator) throw new Error("Creator not found.");
  const transcriptPaths = collectCreatorTranscripts(job.creatorKey);
  if (!transcriptPaths.length) throw new Error("No transcripts found for this creator.");
  const corpus = readVttCorpusFromPaths(transcriptPaths, { maxChars: 260_000, maxFiles: 100, pickEveryNth: 6 });
  if (!corpus.examples.length) throw new Error("Failed to extract corpus examples.");

  const stylePrimer = buildStylePrimerFromExamples(corpus.examples.slice(0, 1200));

  let newsBullets = "";
  if (job.autoNews || (job.topics && job.topics.length)) {
    job.phase = "fetching-news";
    job.message = "Fetching recent items…";
    const news = await fetchNewsFromGdelt(job.topics && job.topics.length ? job.topics : ["news"], job.newsDays, 10);
    newsBullets = buildNewsBullets(news);
  }

  job.phase = "outlining";
  job.message = "Generating episode outline…";
  const client = getOpenAIClient();
  const model = job.model || serverConfig.openaiModelDefault || "gpt-4.1";
  const outline = await generateOutlineWithOpenAI({
    client,
    model,
    minutes: job.minutes,
    topics: job.topics || [],
    stylePrimer
  });
  const totalSegments = outline.length || Math.max(8, Math.round(job.minutes / 5));
  job.total = totalSegments;

  const blocks = [];
  for (let i = 0; i < totalSegments; i++) {
    job.phase = "writing";
    job.current = i + 1;
    const seg = outline[i] || { title: `Segment ${i + 1}`, minutes: Math.round(job.minutes / totalSegments), bullets: [] };
    job.message = `Writing segment ${job.current}/${totalSegments}: ${seg.title || ""}`;
    const minutes = Math.max(3, Number(seg.minutes || Math.round(job.minutes / totalSegments)));
    const text = await generateMonologueBlock({
      client,
      model,
      stylePrimer,
      newsBullets,
      segment: seg,
      minutes,
      episodeTitle: job.episodeTitle
    });
    blocks.push(text);
  }

  job.phase = "rendering";
  job.message = "Rendering .vtt transcript…";
  const vtt = buildVttFromBlocks(blocks, job.minutes);

  job.phase = "saving";
  job.message = "Saving transcript to library…";
  const baseDir =
    creator.rootDir && fs.existsSync(creator.rootDir)
      ? creator.rootDir
      : path.join(os.homedir(), "Downloads", "YouTube");
  const stamp = new Date().toISOString().slice(0, 10);
  const baseName = sanitizeFileName(job.episodeTitle || `New Episode ${stamp}`);
  const targetPath = uniqueEpisodeFilename(baseDir, baseName);
  fs.writeFileSync(targetPath, vtt, "utf8");
  const st = safeStat(targetPath);

  try {
    registerLibraryFile(
      {
        videoId: null,
        title: baseName,
        normalizedTitle: normalizeTitleKey(baseName),
        path: targetPath,
        type: "transcript",
        size: st?.size ?? null,
        mtime: st?.mtimeMs ?? null,
        source: "chat"
      },
      { deferSave: false }
    );
  } catch {}

  job.phase = "done";
  job.message = "Episode transcript created.";
  job.active = false;
  job.targetPath = targetPath;
}