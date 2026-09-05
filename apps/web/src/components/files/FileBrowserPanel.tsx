import { RefreshIcon } from "~/components/ui/refresh-icon";
import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
} from "@pierre/trees";
import type {
  EnvironmentId,
  ProjectDirectoryEntry,
  ProjectEntry,
  ProjectListDirectoryResult,
} from "@t3tools/contracts";
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelector } from "@pierre/trees/react";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { ChevronsDownUpIcon, ChevronsUpDownIcon, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useTheme } from "~/hooks/useTheme";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";
import { useServerConfigs } from "~/state/entities";
import { useProjectPathSearch } from "~/state/queries";

import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "./fileTreeExpansion";
import { loadProjectDirectory, useProjectDirectoryQuery } from "./projectFilesQueryState";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  /** File currently open in the preview pane; revealed and selected in the tree. */
  selectedPath: string | null;
  /** Bumped when the same path should be revealed again (e.g. re-opened from search). */
  selectedPathRevealId: number;
  onOpenFile: (relativePath: string) => void;
  onRefreshSelectedFile?: () => void;
  workspaceMutationId: string | null;
}

function treePath(entry: ProjectEntry | ProjectDirectoryEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh workspace files"
            onClick={props.onRefresh}
          />
        }
      >
        <RefreshIcon refreshing={props.isPending} />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
    </Tooltip>
  );
}

function FileSearchField(props: {
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  value: string;
}) {
  return (
    <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
      <InputGroupInput
        type="search"
        name={props.name}
        size="sm"
        value={props.value}
        aria-label={props.ariaLabel}
        placeholder="Search files"
        spellCheck={false}
        onChange={(event) => props.onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          props.onClose();
          event.currentTarget.blur();
        }}
      />
    </InputGroup>
  );
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath,
  selectedPathRevealId,
  onOpenFile,
  onRefreshSelectedFile,
  workspaceMutationId,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const composerRef = useComposerHandleContext();
  const serverConfigs = useServerConfigs();
  const supportsDirectoryListing =
    serverConfigs.get(environmentId)?.environment.capabilities.projectDirectoryListing === true;
  const rootDirectoryQuery = useProjectDirectoryQuery(
    environmentId,
    cwd,
    "",
    supportsDirectoryListing,
  );
  const entryKindsRef = useRef(new Map<string, ProjectEntry["kind"]>());
  const loadedDirectoriesRef = useRef(new Set<string>());
  const loadingDirectoriesRef = useRef(new Map<string, Promise<void>>());
  const rootResultRef = useRef<ProjectListDirectoryResult | null>(null);
  const loadGenerationRef = useRef(0);
  const refreshDirectoryQueriesRef = useRef(false);
  const [loadingDirectoryCount, setLoadingDirectoryCount] = useState(0);
  const [treeRevision, setTreeRevision] = useState(0);
  const expandAllRequestedRef = useRef(false);
  const syncingSelectionRef = useRef(false);
  const treeSelectionPathRef = useRef<string | null>(null);
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(null);

  // The tree renders rows in shadow DOM and its anchor rect is unreliable, so
  // capture the right-click position ourselves; contextmenu is a composed
  // event, so a capture-phase listener sees it with viewport coordinates.
  const contextMenuPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);
  useEffect(() => {
    const capturePointer = (event: MouseEvent) => {
      contextMenuPointerRef.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    };
    document.addEventListener("contextmenu", capturePointer, true);
    return () => document.removeEventListener("contextmenu", capturePointer, true);
  }, []);

  const showEntryContextMenu = async (
    item: TreeContextMenuItem,
    context: TreeContextMenuOpenContext,
  ) => {
    const api = readLocalApi();
    if (!api) {
      context.close();
      return;
    }
    const relativePath = item.path.replace(/\/$/, "");
    const mention = serializeComposerFileLink(relativePath);
    const pointer = contextMenuPointerRef.current;
    const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
    const anchorRect = context.anchorElement.getBoundingClientRect();
    const position = pointerIsFresh
      ? { x: pointer.x, y: pointer.y }
      : { x: anchorRect.left, y: anchorRect.bottom };
    try {
      const clicked = await api.contextMenu.show(
        [
          { id: "copy-mention", label: "Copy mention" },
          { id: "add-to-chat", label: "Add to chat" },
        ],
        position,
      );
      if (clicked === "copy-mention") {
        try {
          await writeTextToClipboard(mention);
          toastManager.add({ type: "success", title: "Mention copied", description: relativePath });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to copy mention",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }
      if (clicked === "add-to-chat") {
        const composer = composerRef?.current;
        if (!composer) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "Open a chat for this project and try again.",
          });
          return;
        }
        const inserted = composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true });
        if (!inserted) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "The chat isn't ready to accept input right now.",
          });
        }
      }
    } finally {
      context.close();
    }
  };
  const showEntryContextMenuRef = useRef(showEntryContextMenu);
  useEffect(() => {
    showEntryContextMenuRef.current = showEntryContextMenu;
  });

  const treeModelRef = useRef<ReturnType<typeof useFileTree>["model"] | null>(null);
  const dragMention = useMemo(
    () =>
      createFileTreeDragMentionController({
        deselect: (path) => treeModelRef.current?.getItem(path)?.deselect(),
      }),
    [],
  );
  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: "right-click",
        onOpen: (item, context) => {
          void showEntryContextMenuRef.current(item, context);
        },
      },
    },
    // Rows only need to be draggable so entries can be dropped into the chat
    // composer; rearranging files inside the tree stays off.
    dragAndDrop: { canDrop: () => false },
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: false,
    initialExpansion: "closed",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      // The drag controller's selection cache must track every change,
      // including reveal-driven ones, or drags act on a stale selection.
      dragMention.handleSelectionChange(selectedPaths);
      // Selection changes driven by the reveal sync below are echoes of an
      // already-open file, not a request to open it again.
      if (syncingSelectionRef.current) return;
      // Starting a drag selects the dragged row; that selection is a side
      // effect of the gesture, not a request to open the file.
      if (dragMention.isDragInProgress()) {
        return;
      }
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) === "file") {
        treeSelectionPathRef.current = selectedPath;
        onOpenFile(selectedPath);
      }
    },
    paths: [],
    search: false,
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  const search = useFileTreeSearch(model);
  const indexedSearch = useProjectPathSearch({ environmentId, cwd, query: search.value }, 200);
  const directoryPaths = useMemo(() => {
    void treeRevision;
    return [...entryKindsRef.current]
      .filter(([, kind]) => kind === "directory")
      .map(([path]) => `${path}/`);
  }, [treeRevision]);
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, directoryPaths),
  );
  const toggleAllDirectories = () => {
    const expand = !allDirectoriesExpanded;
    expandAllRequestedRef.current = expand;
    setAllDirectoriesExpanded(model, directoryPaths, expand);
  };
  const handleSearchValueChange = (value: string) => {
    if (value.trim().length === 0) {
      search.close();
      return;
    }
    search.setValue(value);
  };
  const applyDirectoryResult = useCallback(
    (directoryPath: string, result: ProjectListDirectoryResult, resetRoot = false) => {
      const paths = result.entries.map(treePath);
      if (resetRoot) {
        entryKindsRef.current.clear();
        loadedDirectoriesRef.current.clear();
        for (const entry of result.entries) entryKindsRef.current.set(entry.path, entry.kind);
        loadedDirectoriesRef.current.add("");
        model.resetPaths(paths);
      } else {
        const additions = [];
        for (const entry of result.entries) {
          entryKindsRef.current.set(entry.path, entry.kind);
          const path = treePath(entry);
          if (model.getItem(path) === null) additions.push({ type: "add" as const, path });
        }
        if (additions.length > 0) model.batch(additions);
        loadedDirectoriesRef.current.add(directoryPath);
      }

      if (expandAllRequestedRef.current) {
        setAllDirectoriesExpanded(
          model,
          [...entryKindsRef.current]
            .filter(([, kind]) => kind === "directory")
            .map(([path]) => `${path}/`),
          true,
        );
      }
      setTreeRevision((revision) => revision + 1);
    },
    [model],
  );

  const loadDirectory = useCallback(
    (directoryPath: string, options?: { readonly refresh?: boolean }): Promise<void> => {
      if (!options?.refresh && loadedDirectoriesRef.current.has(directoryPath)) {
        return Promise.resolve();
      }
      const existing = loadingDirectoriesRef.current.get(directoryPath);
      if (existing) return existing;

      const generation = loadGenerationRef.current;
      const request = loadProjectDirectory(
        environmentId,
        cwd,
        directoryPath,
        supportsDirectoryListing,
        supportsDirectoryListing && refreshDirectoryQueriesRef.current
          ? { ...options, refresh: true }
          : options,
      )
        .then((result) => {
          if (loadGenerationRef.current !== generation) return;
          applyDirectoryResult(directoryPath, result);
        })
        .catch((error: unknown) => {
          if (loadGenerationRef.current !== generation) return;
          toastManager.add({
            type: "error",
            title: "Failed to load folder",
            description: error instanceof Error ? error.message : directoryPath,
          });
        })
        .finally(() => {
          if (loadingDirectoriesRef.current.get(directoryPath) !== request) return;
          loadingDirectoriesRef.current.delete(directoryPath);
          setLoadingDirectoryCount(loadingDirectoriesRef.current.size);
        });
      loadingDirectoriesRef.current.set(directoryPath, request);
      setLoadingDirectoryCount(loadingDirectoriesRef.current.size);
      return request;
    },
    [applyDirectoryResult, cwd, environmentId, supportsDirectoryListing],
  );

  useEffect(() => {
    loadGenerationRef.current += 1;
    rootResultRef.current = null;
    refreshDirectoryQueriesRef.current = false;
    expandAllRequestedRef.current = false;
    loadingDirectoriesRef.current.clear();
    setLoadingDirectoryCount(0);
    entryKindsRef.current.clear();
    loadedDirectoriesRef.current.clear();
    model.resetPaths([]);
    setTreeRevision((revision) => revision + 1);
  }, [cwd, environmentId, model]);

  useEffect(() => {
    const result = rootDirectoryQuery.data;
    if (result === null || rootResultRef.current === result) return;
    loadGenerationRef.current += 1;
    loadingDirectoriesRef.current.clear();
    setLoadingDirectoryCount(0);
    rootResultRef.current = result;
    applyDirectoryResult("", result, true);
  }, [applyDirectoryResult, rootDirectoryQuery.data]);

  const handleRefresh = useCallback(() => {
    refreshDirectoryQueriesRef.current = true;
    rootDirectoryQuery.refresh();
    onRefreshSelectedFile?.();
  }, [onRefreshSelectedFile, rootDirectoryQuery.refresh]);
  useWorkspaceMutationRefresh({
    mutationId: workspaceMutationId,
    refresh: rootDirectoryQuery.refresh,
    resourceKey: `files:${environmentId}:${cwd}`,
  });

  useEffect(() => {
    const loadExpandedDirectories = () => {
      for (const [path, kind] of entryKindsRef.current) {
        if (kind !== "directory" || loadedDirectoriesRef.current.has(path)) continue;
        const item = model.getItem(path);
        if (item && "isExpanded" in item && item.isExpanded()) void loadDirectory(path);
      }
    };
    loadExpandedDirectories();
    return model.subscribe(loadExpandedDirectories);
  }, [loadDirectory, model]);

  useEffect(() => {
    if (
      search.value.trim().length === 0 ||
      indexedSearch.isPending ||
      indexedSearch.searchedQuery !== search.value.trim()
    ) {
      return;
    }
    const additions = new Map<string, { readonly type: "add"; readonly path: string }>();
    for (const entry of indexedSearch.entries) {
      const segments = entry.path.split("/");
      let ancestorPath = "";
      for (const segment of segments.slice(0, -1)) {
        ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
        entryKindsRef.current.set(ancestorPath, "directory");
      }
      entryKindsRef.current.set(entry.path, entry.kind);
      const path = treePath(entry);
      if (model.getItem(path) === null) additions.set(path, { type: "add", path });
    }
    if (additions.size > 0) {
      model.batch([...additions.values()]);
      setTreeRevision((revision) => revision + 1);
    }
  }, [
    indexedSearch.entries,
    indexedSearch.isPending,
    indexedSearch.searchedQuery,
    model,
    search.value,
  ]);

  useEffect(() => {
    if (!selectedPath) {
      handledRevealRef.current = null;
      return;
    }
    const revealRequest = { path: selectedPath, revealId: selectedPathRevealId };
    const handledReveal = handledRevealRef.current;
    // Entry refreshes rebuild the tree while the same preview stays open.
    // Replaying a handled reveal would close an active tree search and steal focus.
    if (
      handledReveal?.path === revealRequest.path &&
      handledReveal.revealId === revealRequest.revealId
    ) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const segments = selectedPath.split("/");
      let ancestorPath = "";
      for (const segment of segments.slice(0, -1)) {
        ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
        const item = model.getItem(ancestorPath);
        if (!item || !("expand" in item)) return;
        item.expand();
        await loadDirectory(ancestorPath);
        if (cancelled) return;
      }

      if (entryKindsRef.current.get(selectedPath) !== "file") return;
      const selectedItem = model.getItem(selectedPath);
      if (!selectedItem || cancelled) return;

      // A selection that originated inside the tree is already visible.
      // Re-revealing it would close search and clobber the user's context.
      const selectedInTree = model
        .getSelectedPaths()
        .some((path) => path.replace(/\/$/, "") === selectedPath);
      if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
        treeSelectionPathRef.current = null;
        handledRevealRef.current = revealRequest;
        return;
      }
      treeSelectionPathRef.current = null;
      handledRevealRef.current = revealRequest;
      syncingSelectionRef.current = true;
      model.closeSearch();
      for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect();
      selectedItem.select();
      model.scrollToPath(selectedPath, { focus: true, offset: "center" });
      queueMicrotask(() => {
        syncingSelectionRef.current = false;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [loadDirectory, model, rootDirectoryQuery.data, selectedPath, selectedPathRevealId]);

  // Tag tree drags with the composer mention payload. The row is read from
  // the composed event path (the tree's shadow root is open), so this does
  // not depend on running after the tree's own dragstart handler; the drag
  // data store is writable for every dragstart listener in the dispatch.
  // The capture phase runs before the tree's own dragstart handler selects
  // the dragged row, so the drag flag is up before that selection emits.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    treeModelRef.current = model;
  }, [model]);
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const handleDragStart = (event: DragEvent) => dragMention.handleDragStart(event);
    const handleDragEnd = () => dragMention.handleDragEnd();
    panel.addEventListener("dragstart", handleDragStart, true);
    panel.addEventListener("dragend", handleDragEnd);
    return () => {
      panel.removeEventListener("dragstart", handleDragStart, true);
      panel.removeEventListener("dragend", handleDragEnd);
    };
  }, [dragMention]);

  return (
    <div
      ref={panelRef}
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-1 in-data-[preview-panel-mode=inline]:h-9 in-data-[preview-panel-mode=inline]:min-h-9 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <RefreshFilesButton
          isPending={rootDirectoryQuery.isPending || loadingDirectoryCount > 0}
          onRefresh={handleRefresh}
        />
        <FileSearchField
          name="project-files-search"
          ariaLabel={`Search ${projectName} files`}
          value={search.value}
          onValueChange={handleSearchValueChange}
          onClose={search.close}
        />
        {directoryPaths.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={
                    allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"
                  }
                  onClick={toggleAllDirectories}
                />
              }
            >
              {allDirectoriesExpanded ? (
                <ChevronsDownUpIcon className="size-3.5" />
              ) : (
                <ChevronsUpDownIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup>
              {allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {rootDirectoryQuery.error && rootDirectoryQuery.data === null ? (
        <div className="p-4 text-xs leading-relaxed text-destructive">
          {rootDirectoryQuery.error}
        </div>
      ) : (
        <FileTree
          model={model}
          aria-label={`${projectName} files`}
          className="min-h-0 flex-1 overflow-hidden"
          style={pierreTreeStyle(resolvedTheme)}
        />
      )}
    </div>
  );
}
