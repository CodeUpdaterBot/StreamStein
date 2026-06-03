import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_MATCH_CONFIG,
  DEFAULT_DURATION_MATCH,
  DEFAULT_IGNORE_CHARS,
  MATCH_FIELD_LIST,
  normalizeMatchConfig,
  normalizeDurationMatch,
  normalizeIgnoreChars,
  describeMatchConfig,
  describeDurationMatch,
  describeSearchPreview,
  newMatchRowId,
} from "../utils/youtubeEnrichMatch.js";

function MatchFieldDropdown({ value, onChange, disabled, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const selected =
    MATCH_FIELD_LIST.find((f) => f.id === value) || MATCH_FIELD_LIST[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="yt-match-dropdown" ref={wrapRef}>
      <button
        type="button"
        className="yt-match-dropdown__trigger"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-expanded={open}
      >
        <span>{selected.label}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="yt-match-dropdown__menu" role="listbox">
          {MATCH_FIELD_LIST.map((f) => (
            <button
              key={f.id}
              type="button"
              role="option"
              aria-selected={f.id === value}
              className={`yt-match-dropdown__item${
                f.id === value ? " yt-match-dropdown__item--active" : ""
              }`}
              onClick={() => {
                onChange(f.id);
                setOpen(false);
              }}
            >
              <span>{f.label}</span>
              {f.id === value && <span className="yt-match-dropdown__check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RowOperatorToggle({ value, onChange, disabled }) {
  return (
    <div className="yt-match-row-op">
      <button
        type="button"
        className={`yt-match-row-op__btn${value === "and" ? " yt-match-row-op__btn--active" : ""}`}
        onClick={() => onChange("and")}
        disabled={disabled}
      >
        AND
      </button>
      <button
        type="button"
        className={`yt-match-row-op__btn${value === "or" ? " yt-match-row-op__btn--active" : ""}`}
        onClick={() => onChange("or")}
        disabled={disabled}
      >
        OR
      </button>
    </div>
  );
}

function formatIgnoreChipLabel(ch) {
  if (ch === "'") return "apostrophe '";
  if (ch === "\u2019") return "curly '";
  if (ch === ",") return "comma";
  if (ch === ".") return "period";
  return ch.length === 1 ? `“${ch}”` : ch;
}

export default function YoutubeMatchLogicBuilder({
  value,
  onChange,
  disabled = false,
}) {
  const config = useMemo(() => normalizeMatchConfig(value), [value]);
  const [ignoreDraft, setIgnoreDraft] = useState("");

  const updateConfig = useCallback(
    (next) => {
      onChange?.(normalizeMatchConfig(next));
    },
    [onChange],
  );

  const setRowField = useCallback(
    (rowIndex, fieldIndex, field) => {
      const rows = config.rows.map((row, ri) => {
        if (ri !== rowIndex) return row;
        const fields = [...row.fields];
        fields[fieldIndex] = field;
        return { ...row, fields };
      });
      updateConfig({ ...config, rows });
    },
    [config, updateConfig],
  );

  const setRowOperator = useCallback(
    (index, op) => {
      const rowOperators = [...config.rowOperators];
      rowOperators[index] = op === "or" ? "or" : "and";
      updateConfig({ ...config, rowOperators });
    },
    [config, updateConfig],
  );

  const addFieldToRow = useCallback(
    (rowIndex) => {
      const row = config.rows[rowIndex];
      if (!row || row.fields.length >= 2) return;
      const rows = config.rows.map((r, i) =>
        i === rowIndex
          ? { ...r, fields: [...r.fields, "title"] }
          : r,
      );
      updateConfig({ ...config, rows });
    },
    [config, updateConfig],
  );

  const removeFieldFromRow = useCallback(
    (rowIndex, fieldIndex) => {
      const row = config.rows[rowIndex];
      if (!row || row.fields.length <= 1) return;
      const rows = config.rows.map((r, i) =>
        i === rowIndex
          ? { ...r, fields: r.fields.filter((_, fi) => fi !== fieldIndex) }
          : r,
      );
      updateConfig({ ...config, rows });
    },
    [config, updateConfig],
  );

  const addRow = useCallback(() => {
    if (config.rows.length >= 8) return;
    const rows = [
      ...config.rows,
      { id: newMatchRowId(), fields: ["title"] },
    ];
    const rowOperators =
      rows.length > 1
        ? [...config.rowOperators, "and"]
        : [];
    updateConfig({ ...config, rows, rowOperators });
  }, [config, updateConfig]);

  const removeRow = useCallback(
    (rowIndex) => {
      if (config.rows.length <= 1) return;
      const rows = config.rows.filter((_, i) => i !== rowIndex);
      const rowOperators = config.rowOperators.filter((_, i) => {
        if (rowIndex === 0) return i !== 0;
        return i !== rowIndex - 1;
      });
      updateConfig({ ...config, rows, rowOperators });
    },
    [config, updateConfig],
  );

  const setMinScore = useCallback(
    (minScore) => {
      updateConfig({ ...config, minScore: Number(minScore) });
    },
    [config, updateConfig],
  );

  const addIgnoreChar = useCallback(
    (raw) => {
      const piece = String(raw || "").trim();
      if (!piece) return;
      const next = normalizeIgnoreChars([...config.ignoreChars, piece]);
      updateConfig({ ...config, ignoreChars: next });
    },
    [config, updateConfig],
  );

  const removeIgnoreChar = useCallback(
    (ch) => {
      const next = config.ignoreChars.filter((c) => c !== ch);
      updateConfig({
        ...config,
        ignoreChars: next.length ? next : [...DEFAULT_IGNORE_CHARS],
      });
    },
    [config, updateConfig],
  );

  const commitIgnoreDraft = useCallback(() => {
    const text = ignoreDraft.trim();
    if (!text) return;
    text.split(/[,]+/).forEach((part) => {
      const p = part.trim();
      if (p) addIgnoreChar(p);
    });
    setIgnoreDraft("");
  }, [addIgnoreChar, ignoreDraft]);

  const resetDefaults = useCallback(() => {
    updateConfig({
      ...DEFAULT_MATCH_CONFIG,
      rows: [{ id: newMatchRowId(), fields: ["channel_name", "title"] }],
      rowOperators: [],
      ignoreChars: [...DEFAULT_IGNORE_CHARS],
      durationMatch: { ...DEFAULT_DURATION_MATCH },
    });
    setIgnoreDraft("");
  }, [updateConfig]);

  const setDurationMatch = useCallback(
    (patch) => {
      const dm = normalizeDurationMatch(config);
      updateConfig({
        ...config,
        durationMatch: normalizeDurationMatch({ ...dm, ...patch }),
      });
    },
    [config, updateConfig],
  );

  const logicLabel = describeMatchConfig(config);
  const durationLabel = describeDurationMatch(config);
  const searchPreview = describeSearchPreview(config);
  const durationMatch = normalizeDurationMatch(config);

  return (
    <div className="yt-match-panel">
      <div className="yt-match-panel__header">
        <div>
          <div className="yt-match-panel__title">Matching logic</div>
          <div className="yt-match-panel__subtitle">
            Build search rows (up to 2 fields each), chain with AND/OR, confirm
            with local file duration when titles drift, and strip ignored
            characters when comparing.
          </div>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn--sm yt-match-panel__reset"
          onClick={resetDefaults}
          disabled={disabled}
        >
          Reset defaults
        </button>
      </div>

      <div className="yt-match-panel__preview">
        <span className="yt-match-panel__preview-label">Logic</span>
        <span className="yt-match-panel__preview-value">{logicLabel}</span>
      </div>

      <div className="yt-match-panel__preview">
        <span className="yt-match-panel__preview-label">Duration</span>
        <span className="yt-match-panel__preview-value">{durationLabel}</span>
      </div>

      <div className="yt-match-duration">
        <div className="yt-match-builder__label">Duration confirmation</div>
        <p className="yt-match-duration__hint">
          Probes each local file with ffprobe, then confirms YouTube results by
          runtime (handles renamed podcast titles). Your library title is never
          overwritten — only video ID, thumbnail, and links are filled in.
        </p>
        <label className="yt-match-duration__toggle">
          <input
            type="checkbox"
            checked={durationMatch.enabled}
            onChange={(e) => setDurationMatch({ enabled: e.target.checked })}
            disabled={disabled}
          />
          <span>Use local file duration to confirm matches</span>
        </label>

        {durationMatch.enabled && (
          <>
            <div className="yt-match-threshold yt-match-duration__slider-block">
              <div className="yt-match-threshold__head">
                <span className="yt-match-threshold__label">
                  Duration tolerance
                </span>
                <span className="yt-match-threshold__value">
                  ±{(durationMatch.tolerancePercent * 100).toFixed(1)}% (min{" "}
                  {durationMatch.toleranceSecondsMin}s)
                </span>
              </div>
              <input
                type="range"
                className="yt-match-threshold__slider"
                min={0.5}
                max={10}
                step={0.5}
                value={durationMatch.tolerancePercent * 100}
                onChange={(e) =>
                  setDurationMatch({
                    tolerancePercent: Number(e.target.value) / 100,
                  })
                }
                disabled={disabled}
              />
              <div className="yt-match-threshold__hints">
                <span>Stricter</span>
                <span>Looser</span>
              </div>
            </div>

            <div className="yt-match-threshold">
              <div className="yt-match-threshold__head">
                <span className="yt-match-threshold__label">
                  Title threshold when duration matches
                </span>
                <span className="yt-match-threshold__value">
                  {durationMatch.titleMinScoreWhenDurationMatches.toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                className="yt-match-threshold__slider"
                min={0.15}
                max={0.55}
                step={0.05}
                value={durationMatch.titleMinScoreWhenDurationMatches}
                onChange={(e) =>
                  setDurationMatch({
                    titleMinScoreWhenDurationMatches: Number(e.target.value),
                  })
                }
                disabled={disabled}
              />
              <div className="yt-match-threshold__hints">
                <span>Looser title</span>
                <span>Stricter title</span>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="yt-match-builder">
        <div className="yt-match-builder__head">
          <div className="yt-match-builder__label">Field rows</div>
          {config.rows.length < 8 && (
            <button
              type="button"
              className="btn btn-secondary btn--sm"
              onClick={addRow}
              disabled={disabled}
            >
              + Add row
            </button>
          )}
        </div>

        <div className="yt-match-rows">
          {config.rows.map((row, rowIndex) => (
            <div key={row.id} className="yt-match-rows__block">
              {rowIndex > 0 && (
                <RowOperatorToggle
                  value={config.rowOperators[rowIndex - 1] || "and"}
                  onChange={(op) => setRowOperator(rowIndex - 1, op)}
                  disabled={disabled}
                />
              )}

              <div className="yt-match-row-card">
                <div className="yt-match-row-card__head">
                  <span className="yt-match-row-card__title">
                    Row {rowIndex + 1}
                  </span>
                  {config.rows.length > 1 && (
                    <button
                      type="button"
                      className="yt-match-row-card__remove"
                      onClick={() => removeRow(rowIndex)}
                      disabled={disabled}
                      title="Remove row"
                    >
                      Remove row
                    </button>
                  )}
                </div>

                <div className="yt-match-row-card__fields">
                  {row.fields.map((field, fieldIndex) => (
                    <div key={`${row.id}-${fieldIndex}`} className="yt-match-row-field">
                      {fieldIndex > 0 && (
                        <span className="yt-match-row-field__and">AND</span>
                      )}
                      <MatchFieldDropdown
                        value={field}
                        onChange={(f) => setRowField(rowIndex, fieldIndex, f)}
                        disabled={disabled}
                        ariaLabel={`Row ${rowIndex + 1} field ${fieldIndex + 1}`}
                      />
                      {row.fields.length > 1 && (
                        <button
                          type="button"
                          className="yt-match-row-field__remove"
                          onClick={() => removeFieldFromRow(rowIndex, fieldIndex)}
                          disabled={disabled}
                          title="Remove field"
                          aria-label="Remove field"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))}

                  {row.fields.length < 2 && (
                    <button
                      type="button"
                      className="btn btn-ghost btn--sm yt-match-row-card__add-field"
                      onClick={() => addFieldToRow(rowIndex)}
                      disabled={disabled}
                    >
                      + Field in row
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="yt-match-ignore">
        <div className="yt-match-builder__label">Ignore when matching</div>
        <p className="yt-match-ignore__hint">
          Characters stripped before comparing titles (presence or absence
          won&apos;t affect the score). Type a character and press Enter or
          comma to add.
        </p>
        <div className="yt-match-ignore__chips">
          {config.ignoreChars.map((ch) => (
            <span key={ch} className="yt-match-ignore__chip">
              <span>{formatIgnoreChipLabel(ch)}</span>
              <button
                type="button"
                className="yt-match-ignore__chip-remove"
                onClick={() => removeIgnoreChar(ch)}
                disabled={disabled}
                aria-label={`Remove ignore ${formatIgnoreChipLabel(ch)}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <input
          type="text"
          className="apikey-input yt-match-ignore__input"
          style={{ marginBottom: 0 }}
          placeholder="e.g. ' or , then Enter"
          value={ignoreDraft}
          onChange={(e) => setIgnoreDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commitIgnoreDraft();
            }
          }}
          onBlur={commitIgnoreDraft}
          disabled={disabled}
        />
      </div>

      <div className="yt-match-threshold">
        <div className="yt-match-threshold__head">
          <span className="yt-match-threshold__label">Match threshold</span>
          <span className="yt-match-threshold__value">
            {config.minScore.toFixed(2)}
          </span>
        </div>
        <input
          type="range"
          className="yt-match-threshold__slider"
          min={0.3}
          max={0.9}
          step={0.05}
          value={config.minScore}
          onChange={(e) => setMinScore(e.target.value)}
          disabled={disabled}
        />
        <div className="yt-match-threshold__hints">
          <span>Looser</span>
          <span>Stricter</span>
        </div>
      </div>

      <div className="yt-match-panel__footnote">{searchPreview}</div>
    </div>
  );
}
