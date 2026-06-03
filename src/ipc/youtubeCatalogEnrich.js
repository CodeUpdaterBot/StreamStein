// YouTube catalog metadata enrichment — spawns runYoutubeCatalogEnrich.js
// with Electron's embedded Node and streams stdout to the renderer.

const { ipcMain } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const toolPaths = require("./toolPaths");

const SUMMARY_PREFIX = "__STREAMSTEIN_ENRICH_SUMMARY__";

let enrichChild = null;
let enrichIsSingleRecord = false;
let getMainWindow = null;
let lastSummary = null;

function buildEnrichEnv(matchConfig) {
  const tools = toolPaths.publishBundledEnv();
  const binDir = tools.bundledBinDir || process.env.STREAMSTEIN_BIN_DIR || "";
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  let envPath = process.env[pathKey] || process.env.PATH || "";
  if (binDir) {
    const prefix = path.resolve(binDir);
    if (!envPath.toLowerCase().includes(prefix.toLowerCase())) {
      envPath = `${prefix}${path.delimiter}${envPath}`;
    }
  }
  const env = {
    ...process.env,
    [pathKey]: envPath,
    ELECTRON_RUN_AS_NODE: "1",
    STREAMSTEIN_NODE: process.execPath,
    STREAMSTEIN_BIN_DIR: binDir,
  };
  if (matchConfig && typeof matchConfig === "object") {
    try {
      env.STREAMSTEIN_ENRICH_MATCH = JSON.stringify(matchConfig);
    } catch {
      // ignore
    }
  }
  return env;
}

function applySingleRecordEnv(env, recordId) {
  const id = typeof recordId === "string" ? recordId.trim() : "";
  if (id) {
    env.STREAMSTEIN_ENRICH_RECORD_ID = id;
  }
  return env;
}

function sendProgress(update) {
  const mw = getMainWindow?.();
  if (mw && !mw.isDestroyed()) {
    mw.webContents.send("youtube-enrich-progress", update);
  }
}

function parseSummaryFromLine(line) {
  if (!line?.startsWith(SUMMARY_PREFIX)) return null;
  try {
    return JSON.parse(line.slice(SUMMARY_PREFIX.length));
  } catch {
    return null;
  }
}

function handleStreamChunk(bufferRef, chunk, isError) {
  bufferRef.value += String(chunk);
  const parts = bufferRef.value.split(/\r?\n/);
  bufferRef.value = parts.pop() ?? "";
  for (const line of parts) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    const summary = parseSummaryFromLine(trimmed);
    if (summary) {
      lastSummary = summary;
      sendProgress({ summary, line: trimmed });
    } else {
      sendProgress({ line: trimmed, type: isError ? "stderr" : "stdout" });
    }
  }
}

function register(getWin) {
  getMainWindow = getWin;

  ipcMain.handle("start-youtube-catalog-enrich", async (_, opts = {}) => {
    if (enrichChild && !enrichChild.killed) {
      return { ok: false, error: "Metadata sync is already running." };
    }

    lastSummary = null;
    const scriptPath = path.join(__dirname, "runYoutubeCatalogEnrich.js");
    const args = [scriptPath];
    const folder = typeof opts.folder === "string" ? opts.folder.trim() : "";
    if (folder) {
      args.push("--folder", folder);
    }
    if (opts.dryRun) args.push("--dry-run");
    const recordId =
      typeof opts.recordId === "string" ? opts.recordId.trim() : "";
    if (recordId) {
      args.push("--record-id", recordId);
      args.push("--limit", "1");
    } else if (opts.limit && Number.isFinite(Number(opts.limit))) {
      args.push("--limit", String(Math.max(1, Number(opts.limit))));
    }
    if (opts.verbose || recordId) args.push("--verbose");

    const matchConfig =
      opts.matchConfig && typeof opts.matchConfig === "object"
        ? opts.matchConfig
        : null;

    const startLine = recordId
      ? "Starting metadata sync for this video…"
      : "Starting metadata sync…";
    sendProgress({ phase: "starting", line: startLine, recordId: recordId || null });

    let env = buildEnrichEnv(matchConfig);
    env = applySingleRecordEnv(env, recordId);

    enrichIsSingleRecord = Boolean(recordId);
    enrichChild = spawn(process.execPath, args, {
      env,
      cwd: path.dirname(scriptPath),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdoutBuf = { value: "" };
    const stderrBuf = { value: "" };

    enrichChild.stdout?.on("data", (chunk) => {
      handleStreamChunk(stdoutBuf, chunk, false);
    });

    enrichChild.stderr?.on("data", (chunk) => {
      handleStreamChunk(stderrBuf, chunk, true);
    });

    enrichChild.on("exit", (code, signal) => {
      if (stdoutBuf.value.trim()) {
        handleStreamChunk(stdoutBuf, "\n", false);
      }
      if (stderrBuf.value.trim()) {
        handleStreamChunk(stderrBuf, "\n", true);
      }

      const singleRecord = enrichIsSingleRecord;
      enrichIsSingleRecord = false;
      let error = null;
      if (code !== 0) {
        if (signal) {
          error = "Metadata sync was stopped.";
        } else if (singleRecord) {
          error =
            lastSummary?.error === "record_not_found"
              ? "This video is no longer in the catalog."
              : "Metadata sync failed. Your file was not deleted — check the log below.";
        } else {
          error = "Metadata sync exited with an error.";
        }
      }

      sendProgress({
        done: true,
        code: code === 0 ? 0 : code ?? 1,
        signal: signal || null,
        summary: lastSummary,
        error,
      });
      enrichChild = null;
    });

    enrichChild.on("error", (err) => {
      sendProgress({
        done: true,
        code: 1,
        error: err?.message || "Failed to start metadata sync.",
      });
      enrichChild = null;
    });

    return { ok: true, pid: enrichChild.pid };
  });

  ipcMain.handle("cancel-youtube-catalog-enrich", () => {
    if (!enrichChild || enrichChild.killed) {
      return { ok: false, error: "No sync is running." };
    }
    try {
      enrichChild.kill();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("get-youtube-catalog-enrich-status", () => ({
    ok: true,
    running: Boolean(enrichChild && !enrichChild.killed),
  }));
}

module.exports = { register };
