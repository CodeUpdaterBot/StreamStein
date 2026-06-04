// Shared YouTube metadata enrich matching rules (CJS — used by runner + Vite UI).

const path = require("path");
const { parseDurationSeconds } = require("./youtubeDurationProbe");

const MATCH_FIELDS = {
  channel_name: {
    id: "channel_name",
    label: "Channel name",
    shortLabel: "Channel",
    description: "Creator or channel folder name",
  },
  title: {
    id: "title",
    label: "Title",
    shortLabel: "Title",
    description: "Video title from catalog or filename",
  },
  filename: {
    id: "filename",
    label: "Filename",
    shortLabel: "Filename",
    description: "File name without extension",
  },
  folder: {
    id: "folder",
    label: "Folder name",
    shortLabel: "Folder",
    description: "Top-level subfolder under your YouTube library",
  },
};

const FIELD_WEIGHTS = {
  title: 0.75,
  filename: 0.7,
  channel_name: 0.25,
  folder: 0.2,
};

const DEFAULT_IGNORE_CHARS = ["'", "\u2019"];

const DEFAULT_DURATION_MATCH = {
  enabled: true,
  tolerancePercent: 0.03,
  toleranceSecondsMin: 5,
  titleMinScoreWhenDurationMatches: 0.28,
};

const DEFAULT_MATCH_CONFIG = {
  version: 2,
  minScore: 0.55,
  ignoreChars: [...DEFAULT_IGNORE_CHARS],
  rows: [{ id: "default-row", fields: ["channel_name", "title"] }],
  rowOperators: [],
  durationMatch: { ...DEFAULT_DURATION_MATCH },
};

function newRowId() {
  return `row-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function basenameNoExt(filePath) {
  if (!filePath) return "";
  const base = path.basename(filePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function normalizeIgnoreChars(input) {
  if (!Array.isArray(input)) return [...DEFAULT_IGNORE_CHARS];
  const out = [];
  for (const item of input) {
    if (typeof item !== "string" || !item) continue;
    if (!out.includes(item)) out.push(item);
  }
  return out.length ? out : [...DEFAULT_IGNORE_CHARS];
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeDurationMatch(input) {
  const src =
    input && typeof input === "object" && input.durationMatch
      ? input.durationMatch
      : input;
  if (!src || typeof src !== "object") {
    return { ...DEFAULT_DURATION_MATCH };
  }
  const tolerancePercent = Number(src.tolerancePercent);
  const toleranceSecondsMin = Number(src.toleranceSecondsMin);
  const titleMinScoreWhenDurationMatches = Number(
    src.titleMinScoreWhenDurationMatches,
  );
  return {
    enabled: src.enabled !== false,
    tolerancePercent: Number.isFinite(tolerancePercent)
      ? clamp(tolerancePercent, 0.005, 0.15)
      : DEFAULT_DURATION_MATCH.tolerancePercent,
    toleranceSecondsMin: Number.isFinite(toleranceSecondsMin)
      ? clamp(toleranceSecondsMin, 1, 120)
      : DEFAULT_DURATION_MATCH.toleranceSecondsMin,
    titleMinScoreWhenDurationMatches: Number.isFinite(
      titleMinScoreWhenDurationMatches,
    )
      ? clamp(titleMinScoreWhenDurationMatches, 0.15, 0.9)
      : DEFAULT_DURATION_MATCH.titleMinScoreWhenDurationMatches,
  };
}

function durationsMatch(localSeconds, remoteSeconds, durationMatch) {
  const local = parseDurationSeconds(localSeconds);
  const remote = parseDurationSeconds(remoteSeconds);
  if (!local || !remote) return false;
  const dm = normalizeDurationMatch(durationMatch);
  const tolerance = Math.max(
    dm.toleranceSecondsMin,
    local * dm.tolerancePercent,
  );
  return Math.abs(local - remote) <= tolerance;
}

function formatDurationClock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function splitIntoOrClausesFromFields(fields, operators) {
  if (!fields.length) return [];
  const clauses = [];
  let clause = [fields[0]];
  for (let i = 0; i < operators.length; i++) {
    if (operators[i] === "or") {
      clauses.push(clause);
      clause = [fields[i + 1]];
    } else {
      clause.push(fields[i + 1]);
    }
  }
  clauses.push(clause);
  return clauses;
}

function migratePartsToRows(parts, operators) {
  const fields = parts
    .map((p) => p?.field)
    .filter((f) => f && MATCH_FIELDS[f]);
  if (!fields.length) {
    return {
      rows: [{ id: newRowId(), fields: ["channel_name", "title"] }],
      rowOperators: [],
    };
  }

  const clauses = splitIntoOrClausesFromFields(fields, operators || []);
  const rows = [];
  const rowOperators = [];

  for (let c = 0; c < clauses.length; c++) {
    const clause = clauses[c];
    for (let i = 0; i < clause.length; i += 2) {
      if (rows.length > 0) {
        rowOperators.push(c > 0 && i === 0 ? "or" : "and");
      }
      rows.push({ id: newRowId(), fields: clause.slice(i, i + 2) });
    }
  }

  return { rows, rowOperators };
}

function normalizeMatchConfig(input) {
  const base = {
    version: 2,
    minScore: DEFAULT_MATCH_CONFIG.minScore,
    ignoreChars: [...DEFAULT_IGNORE_CHARS],
    rows: [{ id: newRowId(), fields: ["channel_name", "title"] }],
    rowOperators: [],
    durationMatch: { ...DEFAULT_DURATION_MATCH },
  };

  if (!input || typeof input !== "object") return base;

  const minScore = Number(input.minScore);
  if (Number.isFinite(minScore)) {
    base.minScore = Math.max(0.2, Math.min(0.95, minScore));
  }
  base.ignoreChars = normalizeIgnoreChars(input.ignoreChars);
  base.durationMatch = normalizeDurationMatch(input);

  if (Array.isArray(input.rows) && input.rows.length) {
    const rows = input.rows
      .map((row, idx) => {
        const fields = (Array.isArray(row?.fields) ? row.fields : [])
          .filter((f) => MATCH_FIELDS[f])
          .slice(0, 2);
        if (!fields.length) return null;
        return {
          id:
            typeof row?.id === "string" && row.id.trim()
              ? row.id.trim()
              : `row-${idx}`,
          fields,
        };
      })
      .filter(Boolean)
      .slice(0, 8);

    if (rows.length) {
      base.rows = rows;
      const ops = Array.isArray(input.rowOperators) ? input.rowOperators : [];
      base.rowOperators = [];
      for (let i = 0; i < base.rows.length - 1; i++) {
        base.rowOperators.push(ops[i] === "or" ? "or" : "and");
      }
    }
  } else if (Array.isArray(input.parts) && input.parts.length) {
    const migrated = migratePartsToRows(input.parts, input.operators);
    base.rows = migrated.rows;
    base.rowOperators = migrated.rowOperators;
  }

  return base;
}

function normalizeTitle(value, ignoreChars) {
  let s = String(value || "");
  const chars = normalizeIgnoreChars(ignoreChars);
  for (const ch of chars) {
    if (ch) s = s.split(ch).join("");
  }
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(value, ignoreChars) {
  return new Set(
    normalizeTitle(value, ignoreChars)
      .split(" ")
      .filter((w) => w.length > 2),
  );
}

function extractLooseTitleTokens(title, ignoreChars, maxTokens = 5) {
  return [...tokenSet(title, ignoreChars)]
    .filter((t) => t.length > 3)
    .sort((a, b) => b.length - a.length)
    .slice(0, maxTokens);
}

function titleScore(a, b, ignoreChars) {
  const A = tokenSet(a, ignoreChars);
  const B = tokenSet(b, ignoreChars);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) {
    if (B.has(t)) inter++;
  }
  return inter / Math.max(A.size, B.size);
}

function channelScore(channelHint, uploader, channel, ignoreChars) {
  const hint = normalizeTitle(channelHint, ignoreChars);
  if (!hint) return 0.5;
  const hay = normalizeTitle(`${uploader || ""} ${channel || ""}`, ignoreChars);
  if (!hay) return 0;
  if (hay.includes(hint) || hint.includes(hay)) return 1;
  const hintTokens = hint.split(" ").filter((w) => w.length > 2);
  if (!hintTokens.length) return 0;
  let hits = 0;
  for (const t of hintTokens) {
    if (hay.includes(t)) hits++;
  }
  return hits / hintTokens.length;
}

function resolveFieldValue(field, record, youtubeRoot) {
  switch (field) {
    case "title":
      return (
        record.title ||
        record.fileName ||
        basenameNoExt(record.filePath)
      );
    case "channel_name":
      if (record.channelName) return record.channelName;
      if (record.channelKey) {
        return record.channelKey
          .replace(/vtt$/i, "")
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .replace(/[-_]/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
      }
      return resolveFieldValue("folder", record, youtubeRoot);
    case "filename":
      return basenameNoExt(record.filePath);
    case "folder": {
      const dir =
        record.directory || (record.filePath ? path.dirname(record.filePath) : "");
      if (dir && youtubeRoot) {
        const rel = path.relative(path.normalize(youtubeRoot), path.normalize(dir));
        if (rel && rel !== "." && !rel.startsWith("..")) {
          return rel.split(path.sep)[0];
        }
      }
      return "";
    }
    default:
      return "";
  }
}

function formatRowLabel(row) {
  return row.fields
    .map((f) => MATCH_FIELDS[f]?.shortLabel || f)
    .join(" + ");
}

function buildSearchQueries(record, youtubeRoot, config) {
  const normalized = normalizeMatchConfig(config);
  const groups = [[]];

  for (let i = 0; i < normalized.rows.length; i++) {
    groups[groups.length - 1].push(normalized.rows[i]);
    if (normalized.rowOperators[i] === "or") groups.push([]);
  }

  const queries = groups
    .map((group) => {
      const values = [];
      for (const row of group) {
        for (const field of row.fields) {
          const v = resolveFieldValue(field, record, youtubeRoot);
          if (v) values.push(String(v).trim());
        }
      }
      return values.join(" ").trim();
    })
    .filter(Boolean);

  if (!queries.length) {
    const fallback = resolveFieldValue("title", record, youtubeRoot);
    if (fallback) queries.push(String(fallback).trim());
  }

  return [...new Set(queries)];
}

/** Broader ytsearch when local duration is known (creator may have renamed the video). */
function buildLooseSearchQueries(record, youtubeRoot, config) {
  const normalized = normalizeMatchConfig(config);
  const channel = resolveFieldValue("channel_name", record, youtubeRoot);
  const title = resolveFieldValue("title", record, youtubeRoot);
  const tokens = extractLooseTitleTokens(title, normalized.ignoreChars);
  const parts = [];
  if (channel) parts.push(String(channel).trim());
  parts.push(...tokens);
  const q = parts.join(" ").trim();
  return q ? [q] : [];
}

function scoreField(field, candidate, record, youtubeRoot, ignoreChars) {
  const value = resolveFieldValue(field, record, youtubeRoot);
  switch (field) {
    case "title":
    case "filename":
      return titleScore(value, candidate.title, ignoreChars);
    case "channel_name":
    case "folder":
      return channelScore(value, candidate.uploader, candidate.channel, ignoreChars);
    default:
      return 0;
  }
}

function scoreRow(row, candidate, record, youtubeRoot, ignoreChars) {
  if (!row?.fields?.length) return 0;
  let total = 0;
  let weightSum = 0;
  for (const field of row.fields) {
    const score = scoreField(field, candidate, record, youtubeRoot, ignoreChars);
    const weight = FIELD_WEIGHTS[field] || 0.5;
    total += score * weight;
    weightSum += weight;
  }
  return weightSum ? total / weightSum : 0;
}

function pickBestCandidateWithConfig(candidates, record, youtubeRoot, config) {
  const normalized = normalizeMatchConfig(config);
  const { rows, rowOperators, ignoreChars, durationMatch } = normalized;
  if (!rows.length) return null;

  const localDur = parseDurationSeconds(record.durationSeconds);
  const useDurationGate =
    durationMatch.enabled && localDur != null && localDur > 0;

  let pool = candidates;
  let usedDurationGate = false;
  if (useDurationGate) {
    const durationFiltered = candidates.filter((c) =>
      durationsMatch(localDur, c.durationSeconds, durationMatch),
    );
    if (durationFiltered.length) {
      pool = durationFiltered;
      usedDurationGate = true;
    }
  }

  const effectiveMinScore = usedDurationGate
    ? Math.min(
        normalized.minScore,
        durationMatch.titleMinScoreWhenDurationMatches,
      )
    : normalized.minScore;

  let best = null;
  for (const c of pool) {
    let combined = scoreRow(rows[0], c, record, youtubeRoot, ignoreChars);
    for (let i = 0; i < rowOperators.length; i++) {
      const next = scoreRow(rows[i + 1], c, record, youtubeRoot, ignoreChars);
      combined =
        rowOperators[i] === "or"
          ? Math.max(combined, next)
          : (combined + next) / 2;
    }
    if (combined >= effectiveMinScore && (!best || combined > best.combined)) {
      best = {
        ...c,
        combined,
        durationMatched: usedDurationGate,
        effectiveMinScore,
      };
    }
  }

  return best;
}

function describeMatchConfig(config) {
  const normalized = normalizeMatchConfig(config);
  const segments = [];
  for (let i = 0; i < normalized.rows.length; i++) {
    segments.push(`(${formatRowLabel(normalized.rows[i])})`);
    if (i < normalized.rowOperators.length) {
      segments.push(normalized.rowOperators[i] === "or" ? "OR" : "AND");
    }
  }
  return segments.join(" ");
}

function describeDurationMatch(config) {
  const normalized = normalizeMatchConfig(config);
  const dm = normalized.durationMatch;
  if (!dm.enabled) return "Duration confirmation: off";
  const pct = Math.round(dm.tolerancePercent * 1000) / 10;
  return `Duration confirmation: ±${pct}% (min ${dm.toleranceSecondsMin}s) · looser title at ${dm.titleMinScoreWhenDurationMatches.toFixed(2)} when duration matches`;
}

function describeSearchPreview(config) {
  const normalized = normalizeMatchConfig(config);
  const groups = [[]];
  for (let i = 0; i < normalized.rows.length; i++) {
    groups[groups.length - 1].push(normalized.rows[i]);
    if (normalized.rowOperators[i] === "or") groups.push([]);
  }
  const clauseText = groups
    .map((group) => group.map((row) => formatRowLabel(row)).join(" + "))
    .join("  ·  or  ·  ");
  const ignore =
    normalized.ignoreChars.length > 0
      ? ` · ignoring ${normalized.ignoreChars
          .map((c) =>
            c === "'"
              ? "apostrophe"
              : c === "\u2019"
                ? "curly apostrophe"
                : JSON.stringify(c),
          )
          .join(", ")}`
      : "";
  const durationNote = normalized.durationMatch.enabled
    ? " · loose guest/channel search when local duration is known"
    : "";
  return `Search groups: ${clauseText || "Title"}${ignore}${durationNote}`;
}

module.exports = {
  MATCH_FIELDS,
  MATCH_FIELD_LIST: Object.values(MATCH_FIELDS),
  DEFAULT_IGNORE_CHARS,
  DEFAULT_DURATION_MATCH,
  DEFAULT_MATCH_CONFIG,
  normalizeMatchConfig,
  normalizeDurationMatch,
  normalizeIgnoreChars,
  resolveFieldValue,
  buildSearchQueries,
  buildLooseSearchQueries,
  pickBestCandidateWithConfig,
  durationsMatch,
  formatDurationClock,
  parseDurationSeconds,
  describeMatchConfig,
  describeDurationMatch,
  describeSearchPreview,
};
