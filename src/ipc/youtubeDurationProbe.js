// Fast local video duration via ffprobe (container metadata only).

const { spawnSync } = require("child_process");
const fs = require("fs");
const toolPaths = require("./toolPaths");

function parseDurationSeconds(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1000) / 1000;
}

function probeVideoDurationSeconds(filePath) {
  const resolved = String(filePath || "").trim();
  if (!resolved || !fs.existsSync(resolved)) return null;

  const ffprobe = toolPaths.resolveTool("ffprobe");
  if (!ffprobe) return null;

  try {
    const r = spawnSync(
      ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        resolved,
      ],
      { encoding: "utf8", timeout: 20000, windowsHide: true },
    );
    if (r.status !== 0 || !r.stdout) return null;
    const line = String(r.stdout).trim().split(/\r?\n/)[0];
    return parseDurationSeconds(line);
  } catch {
    return null;
  }
}

function ensureRecordDurationSeconds(record, { save } = {}) {
  if (!record || typeof record !== "object") return null;
  const existing = parseDurationSeconds(record.durationSeconds);
  if (existing) return existing;

  const filePath = record.filePath;
  if (!filePath) return null;

  const probed = probeVideoDurationSeconds(filePath);
  if (probed) {
    record.durationSeconds = probed;
    if (typeof save === "function") save();
  }
  return probed;
}

module.exports = {
  parseDurationSeconds,
  probeVideoDurationSeconds,
  ensureRecordDurationSeconds,
};
