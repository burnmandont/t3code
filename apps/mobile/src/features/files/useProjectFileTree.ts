import type { EnvironmentId, ProjectEntry, ProjectListEntriesResult } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useEnvironmentServerConfig } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useComposerPathSearch } from "../../state/queries";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";

export function useProjectFileTree(input: {
  readonly cwd: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly searchQuery: string;
  readonly selectedPath?: string | null;
}) {
  const serverConfig = useEnvironmentServerConfig(input.environmentId);
  const supportsDirectoryListing =
    serverConfig?.environment.capabilities.projectDirectoryListing === true;
  const rootQuery = useEnvironmentQuery(
    input.environmentId === null || input.cwd === null || serverConfig === null
      ? null
      : supportsDirectoryListing
        ? projectEnvironment.listDirectory({
            environmentId: input.environmentId,
            input: { cwd: input.cwd, relativePath: "" },
          })
        : projectEnvironment.listEntries({
            environmentId: input.environmentId,
            input: { cwd: input.cwd },
          }),
  );
  const runListDirectory = useAtomQueryRunner(projectEnvironment.listDirectory, {
    reportDefect: false,
    reportFailure: false,
  });
  const indexedSearch = useComposerPathSearch({
    environmentId: input.environmentId,
    cwd: input.cwd,
    query: supportsDirectoryListing ? input.searchQuery : "",
  });
  const [loadedEntries, setLoadedEntries] = useState<ReadonlyMap<string, ProjectEntry>>(
    () => new Map(),
  );
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [loadingDirectoryCount, setLoadingDirectoryCount] = useState(0);
  const loadedDirectoriesRef = useRef(new Set<string>());
  const loadingDirectoriesRef = useRef(new Map<string, Promise<void>>());
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    loadedDirectoriesRef.current.clear();
    loadingDirectoriesRef.current.clear();
    setLoadedEntries(new Map());
    setDirectoryError(null);
    setLoadingDirectoryCount(0);
  }, [input.cwd, input.environmentId, supportsDirectoryListing]);

  useEffect(() => {
    if (rootQuery.data === null) return;
    const entries = (rootQuery.data as ProjectListEntriesResult).entries;
    setLoadedEntries(new Map(entries.map((entry) => [entry.path, entry])));
    loadedDirectoriesRef.current = new Set([""]);
    loadingDirectoriesRef.current.clear();
    setDirectoryError(null);
    setLoadingDirectoryCount(0);
  }, [rootQuery.data]);

  const loadDirectory = useCallback(
    (relativePath: string) => {
      if (
        input.environmentId === null ||
        input.cwd === null ||
        !supportsDirectoryListing ||
        loadedDirectoriesRef.current.has(relativePath)
      )
        return;
      if (loadingDirectoriesRef.current.has(relativePath)) return;

      const generation = generationRef.current;
      const request = runListDirectory({
        environmentId: input.environmentId,
        input: { cwd: input.cwd, relativePath },
      })
        .then((result) => {
          if (generationRef.current !== generation) return;
          if (result._tag !== "Success") {
            setDirectoryError(`Failed to load folder '${relativePath}'.`);
            return;
          }
          setLoadedEntries((current) => {
            const next = new Map(current);
            for (const entry of result.value.entries) next.set(entry.path, entry);
            return next;
          });
          loadedDirectoriesRef.current.add(relativePath);
          setDirectoryError(null);
        })
        .finally(() => {
          if (generationRef.current !== generation) return;
          loadingDirectoriesRef.current.delete(relativePath);
          setLoadingDirectoryCount(loadingDirectoriesRef.current.size);
        });
      loadingDirectoriesRef.current.set(relativePath, request);
      setLoadingDirectoryCount(loadingDirectoriesRef.current.size);
    },
    [input.cwd, input.environmentId, runListDirectory, supportsDirectoryListing],
  );

  const entries = useMemo(() => {
    if (!supportsDirectoryListing || indexedSearch.entries.length === 0) {
      return [...loadedEntries.values()];
    }
    const combined = new Map(loadedEntries);
    for (const entry of indexedSearch.entries) combined.set(entry.path, entry);
    return [...combined.values()];
  }, [indexedSearch.entries, loadedEntries, supportsDirectoryListing]);

  useEffect(() => {
    if (!input.selectedPath || !supportsDirectoryListing) return;
    const segments = input.selectedPath.split("/").filter(Boolean);
    for (let index = 1; index < segments.length; index += 1) {
      loadDirectory(segments.slice(0, index).join("/"));
    }
  }, [input.selectedPath, loadDirectory, supportsDirectoryListing]);

  const refreshRoot = rootQuery.refresh;
  const refresh = useCallback(() => {
    generationRef.current += 1;
    loadedDirectoriesRef.current.clear();
    loadingDirectoriesRef.current.clear();
    setLoadedEntries(new Map());
    setLoadingDirectoryCount(0);
    refreshRoot();
  }, [refreshRoot]);

  return {
    entries,
    error: rootQuery.error ?? directoryError ?? indexedSearch.error,
    isPending: rootQuery.isPending || loadingDirectoryCount > 0 || indexedSearch.isPending,
    loadDirectory,
    refresh,
  };
}
