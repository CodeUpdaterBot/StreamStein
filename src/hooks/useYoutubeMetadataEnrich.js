import { useCallback, useEffect, useRef, useState } from "react";
import { isElectron } from "../utils/storage";

const SUMMARY_PREFIX = "__STREAMSTEIN_ENRICH_SUMMARY__";

export function parseYoutubeEnrichSummaryLine(line) {
  if (!line?.startsWith(SUMMARY_PREFIX)) return null;
  try {
    return JSON.parse(line.slice(SUMMARY_PREFIX.length));
  } catch {
    return null;
  }
}

/**
 * Run YouTube catalog metadata sync (batch or single record).
 * Uses match rules from Settings → YouTube → Metadata sync.
 */
export function useYoutubeMetadataEnrich() {
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState([]);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const handlerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (handlerRef.current) {
        window.electron?.offYoutubeEnrichProgress?.(handlerRef.current);
        handlerRef.current = null;
      }
    };
  }, []);

  const appendLine = useCallback((line) => {
    if (!line) return;
    const parsed = parseYoutubeEnrichSummaryLine(line);
    if (parsed) {
      setSummary(parsed);
      return;
    }
    setLines((prev) => {
      const next = [...prev, line];
      return next.length > 200 ? next.slice(-200) : next;
    });
  }, []);

  const run = useCallback(
    async ({ folder, matchConfig, recordId, limit, verbose } = {}) => {
      if (!isElectron || !window.electron?.startYoutubeCatalogEnrich) {
        const msg = "Metadata sync requires the Streamstein desktop app.";
        setError(msg);
        return { ok: false, error: msg };
      }
      if (running) {
        return { ok: false, error: "Metadata sync is already running." };
      }

      const status = await window.electron.getYoutubeCatalogEnrichStatus?.();
      if (status?.running) {
        return { ok: false, error: "Metadata sync is already running." };
      }

      setRunning(true);
      setLines([]);
      setSummary(null);
      setError(null);

      return new Promise((resolve) => {
        const handler = (update) => {
          if (update?.line) appendLine(update.line);
          if (update?.error) setError(update.error);
          if (update?.summary) setSummary(update.summary);
          if (update?.done) {
            setRunning(false);
            if (update.summary) setSummary(update.summary);
            if (update.code !== 0 && update.error) setError(update.error);
            if (handlerRef.current) {
              window.electron?.offYoutubeEnrichProgress?.(handlerRef.current);
              handlerRef.current = null;
            }
            resolve({
              ok: update.code === 0,
              code: update.code,
              summary: update.summary,
              error: update.error || null,
            });
          }
        };

        handlerRef.current = handler;
        window.electron.onYoutubeEnrichProgress?.(handler);

        window.electron
          .startYoutubeCatalogEnrich({
            folder,
            matchConfig,
            recordId: recordId || null,
            limit: recordId ? 1 : limit,
            verbose: verbose ?? Boolean(recordId),
          })
          .then((res) => {
            if (!res?.ok) {
              setRunning(false);
              setError(res?.error || "Could not start metadata sync.");
              window.electron?.offYoutubeEnrichProgress?.(handler);
              handlerRef.current = null;
              resolve({ ok: false, error: res?.error || "Could not start." });
            }
          })
          .catch((err) => {
            setRunning(false);
            const msg = err?.message || "Failed to start metadata sync.";
            setError(msg);
            window.electron?.offYoutubeEnrichProgress?.(handler);
            handlerRef.current = null;
            resolve({ ok: false, error: msg });
          });
      });
    },
    [appendLine, running],
  );

  const cancel = useCallback(async () => {
    await window.electron?.cancelYoutubeCatalogEnrich?.();
    appendLine("\nCancelled.");
    setRunning(false);
  }, [appendLine]);

  const reset = useCallback(() => {
    setLines([]);
    setSummary(null);
    setError(null);
  }, []);

  return {
    running,
    lines,
    summary,
    error,
    run,
    cancel,
    reset,
    appendLine,
  };
}
