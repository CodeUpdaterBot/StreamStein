import { useState, useEffect, useMemo } from "react";
import { storage, STORAGE_KEYS, isElectron } from "../utils/storage";
import {
  getRawLocalEntries,
  groupLocalLibraryForDisplay,
  LOCAL_FILES_CHANGED,
} from "../utils/localLibrary";

/**
 * Resolves installed local movies/series for Home and Library sections.
 */
export function useLocalLibrary(downloads) {
  const [localFiles, setLocalFiles] = useState(
    () => storage.get(STORAGE_KEYS.LOCAL_FILES) || [],
  );
  const [fileExistsCache, setFileExistsCache] = useState({});

  const refreshLocalFiles = () => {
    setLocalFiles(storage.get(STORAGE_KEYS.LOCAL_FILES) || []);
  };

  useEffect(() => {
    refreshLocalFiles();
    const onChanged = () => refreshLocalFiles();
    window.addEventListener(LOCAL_FILES_CHANGED, onChanged);
    window.addEventListener("focus", onChanged);
    return () => {
      window.removeEventListener(LOCAL_FILES_CHANGED, onChanged);
      window.removeEventListener("focus", onChanged);
    };
  }, []);

  useEffect(() => {
    refreshLocalFiles();
  }, [downloads]);

  const rawEntries = useMemo(
    () => getRawLocalEntries(downloads, localFiles),
    [downloads, localFiles],
  );

  const finishedWithPaths = useMemo(
    () =>
      rawEntries.filter(
        (d) => !d.isLocalOnly && d.status === "completed" && d.filePath,
      ),
    [rawEntries],
  );

  useEffect(() => {
    if (!isElectron) return;
    let mounted = true;
    finishedWithPaths.forEach((d) => {
      window.electron.fileExists(d.filePath).then((exists) => {
        if (!mounted) return;
        setFileExistsCache((prev) => {
          if (prev[d.id] === exists) return prev;
          return { ...prev, [d.id]: exists };
        });
      });
    });
    return () => {
      mounted = false;
    };
  }, [finishedWithPaths]);

  const items = useMemo(
    () => groupLocalLibraryForDisplay(rawEntries, fileExistsCache),
    [rawEntries, fileExistsCache],
  );

  return { items };
}
