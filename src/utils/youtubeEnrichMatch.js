// UI helpers for YouTube enrich matching (mirrors src/ipc/youtubeEnrichMatch.js).

export const MATCH_FIELDS = {
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

export const MATCH_FIELD_LIST = Object.values(MATCH_FIELDS);

export const DEFAULT_IGNORE_CHARS = ["'", "\u2019"];

export const DEFAULT_DURATION_MATCH = {
  enabled: true,
  tolerancePercent: 0.03,
  toleranceSecondsMin: 5,
  titleMinScoreWhenDurationMatches: 0.28,
};

export const DEFAULT_MATCH_CONFIG = {
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

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
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
      rows: DEFAULT_MATCH_CONFIG.rows.map((r) => ({ ...r, id: newRowId() })),
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
      rows.push({
        id: newRowId(),
        fields: clause.slice(i, i + 2),
      });
    }
  }

  return { rows, rowOperators };
}

export function normalizeIgnoreChars(input) {
  if (!Array.isArray(input)) return [...DEFAULT_IGNORE_CHARS];
  const out = [];
  for (const item of input) {
    if (typeof item !== "string" || !item) continue;
    if (!out.includes(item)) out.push(item);
  }
  return out.length ? out : [...DEFAULT_IGNORE_CHARS];
}

export function normalizeDurationMatch(input) {
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

export function normalizeMatchConfig(input) {
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

function formatRowLabel(row) {
  return row.fields
    .map((f) => MATCH_FIELDS[f]?.shortLabel || f)
    .join(" + ");
}

export function describeMatchConfig(config) {
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

export function describeDurationMatch(config) {
  const normalized = normalizeMatchConfig(config);
  const dm = normalized.durationMatch;
  if (!dm.enabled) return "Duration confirmation: off";
  const pct = Math.round(dm.tolerancePercent * 1000) / 10;
  return `Duration confirmation: ±${pct}% (min ${dm.toleranceSecondsMin}s) · looser title at ${dm.titleMinScoreWhenDurationMatches.toFixed(2)} when duration matches`;
}

export function describeSearchPreview(config) {
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
      ? ` · ignoring ${normalized.ignoreChars.map((c) => (c === "'" ? "apostrophe" : c === "\u2019" ? "curly apostrophe" : JSON.stringify(c))).join(", ")}`
      : "";
  const durationNote = normalized.durationMatch.enabled
    ? " · loose guest/channel search when local duration is known"
    : "";
  return `Search groups: ${clauseText || "Title"}${ignore}${durationNote}`;
}

export function newMatchRowId() {
  return newRowId();
}
