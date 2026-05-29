import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import type { ChatStatus } from "ai";
import { PromptInputProvider } from "@ai-elements";
import { toast } from "sonner";
import { PanelLeftOpen, PanelLeftClose, PanelRightOpen, Settings } from "lucide-react";
import { cn } from "./lib/utils";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./components/ui/resizable";
import { ChatWorkspaceContainer } from "./features/chat/chat-workspace-container";
import { SessionsSidebar } from "./features/sessions/sessions";
import { CreateSessionDialog } from "./features/sessions/create-session-dialog";
import { Toaster } from "./components/ui/sonner";
import { formatRelativeTime } from "./hooks/utils";
import { useSessions } from "./hooks/useSessions";
import { useTheme } from "./hooks/use-theme";
import { ThemeToggle } from "./components/ui/theme-toggle";
import { SettingsDialog } from "./features/settings/settings-dialog";
import type { SessionStatus } from "./lib/api/models";
import type { PanelSize, PanelImperativeHandle } from "react-resizable-panels";
import { consumeAuthTokenFromUrl, setAuthToken } from "./lib/auth";
import { isTauri, showWindow } from "./lib/tauri-api";
import { useDomTranslations } from "./lib/i18n";
import {
  KIMI_CODE_URL,
  openKimiCodeWebsite,
  shouldInterceptKimiCodeLink,
} from "./lib/kimi-code-link";
import {
  EMPTY_WORKBENCH_STREAM_SNAPSHOT,
  WorkspacePanel,
  areWorkbenchStreamSnapshotsEqual,
  type WorkbenchStreamSnapshot,
} from "./features/workbench/workspace-panel";

/**
 * Get session ID from URL search params
 */
function getSessionIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("session");
}

/**
 * Update URL with session ID without triggering page reload
 */
function updateUrlWithSession(sessionId: string | null): void {
  const url = new URL(window.location.href);
  if (sessionId) {
    url.searchParams.set("session", sessionId);
  } else {
    url.searchParams.delete("session");
  }
  window.history.replaceState({}, "", url.toString());
}

const SIDEBAR_COLLAPSED_SIZE = 48;
const SIDEBAR_MIN_SIZE = 200;
const SIDEBAR_DEFAULT_SIZE = 260;
const WORKSPACE_PANEL_COLLAPSED_SIZE = 48;
const WORKSPACE_PANEL_MIN_SIZE = 280;
const WORKSPACE_PANEL_DEFAULT_SIZE = 320;
const SIDEBAR_ANIMATION_MS = 250;

function App() {
  useDomTranslations();

  // Initialize theme on app startup
  useTheme();

  // Show window on first mount in Tauri (replaces Rust setup immediate show)
  useEffect(() => {
    if (isTauri()) {
      showWindow().catch(() => {
        // ignore
      });
    }
  }, []);

  const sidebarElementRef = useRef<HTMLDivElement | null>(null);
  const sidebarPanelRef = useRef<PanelImperativeHandle | null>(null);
  const workspacePanelRef = useRef<PanelImperativeHandle | null>(null);
  const sessionsHook = useSessions();
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === "undefined") {
      return true;
    }
    return window.matchMedia("(min-width: 1024px)").matches;
  });

  const {
    sessions,
    archivedSessions,
    selectedSessionId,
    createSession,
    deleteSession,
    selectSession,
    uploadSessionFile,
    getSessionFile,
    getSessionFileUrl,
    listSessionDirectory,
    refreshSession,
    refreshSessions,
    refreshArchivedSessions,
    loadMoreSessions,
    loadMoreArchivedSessions,
    hasMoreSessions,
    hasMoreArchivedSessions,
    isLoadingMore,
    isLoadingMoreArchived,
    isLoadingArchived,
    searchQuery,
    setSearchQuery,
    applySessionStatus,
    fetchWorkDirs,
    fetchStartupDir,
    renameSession,
    generateTitle,
    archiveSession,
    unarchiveSession,
    bulkArchiveSessions,
    bulkUnarchiveSessions,
    bulkDeleteSessions,
    forkSession,
    error: sessionsError,
  } = sessionsHook;

  const currentSession = useMemo(
    () => sessions.find((session) => session.sessionId === selectedSessionId),
    [sessions, selectedSessionId],
  );

  const [streamStatus, setStreamStatus] = useState<ChatStatus>("ready");
  const [streamSnapshot, setStreamSnapshot] = useState<WorkbenchStreamSnapshot>(
    EMPTY_WORKBENCH_STREAM_SNAPSHOT,
  );

  useEffect(() => {
    const token = consumeAuthTokenFromUrl();
    if (token) {
      setAuthToken(token);
    }
  }, []);

  // Create session dialog state (lifted to App for unified access)
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  // Auto-open create dialog or create session directly from URL params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const action = params.get("action");
    if (action === "create") {
      setShowCreateDialog(true);
    } else if (action === "create-in-dir") {
      const workDir = params.get("workDir");
      if (!workDir) return; // invalid params, ignore silently
      createSession(workDir).catch(() => {
        // Errors are already handled globally via sessionsError → toast
      });
    } else {
      return;
    }
    params.delete("action");
    params.delete("workDir");
    const url = new URL(window.location.href);
    url.search = params.toString();
    window.history.replaceState({}, "", url.toString());
  }, [createSession]);

  const handleOpenCreateDialog = useCallback(() => {
    setShowCreateDialog(true);
    setIsMobileSidebarOpen(false);
  }, []);

  const handleOpenMobileSidebar = useCallback(() => {
    setIsMobileSidebarOpen(true);
  }, []);

  const handleOpenSettings = useCallback(() => {
    setShowSettingsDialog(true);
  }, []);

  const handleKimiCodeClick = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (!shouldInterceptKimiCodeLink()) {
      return;
    }

    event.preventDefault();
    openKimiCodeWebsite();
  }, []);

  const handleCloseMobileSidebar = useCallback(() => {
    setIsMobileSidebarOpen(false);
  }, []);

  // Sidebar state
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isWorkspacePanelCollapsed, setIsWorkspacePanelCollapsed] = useState(false);
  const [isSidebarAnimating, setIsSidebarAnimating] = useState(false);
  const handleCollapseSidebar = useCallback(() => {
    setIsSidebarAnimating(true);
    sidebarPanelRef.current?.collapse();
  }, []);
  const handleExpandSidebar = useCallback(() => {
    setIsSidebarAnimating(true);
    sidebarPanelRef.current?.expand();
  }, []);
  const handleSidebarResize = useCallback((panelSize: PanelSize) => {
    const collapsed = panelSize.inPixels <= SIDEBAR_COLLAPSED_SIZE + 1;
    setIsSidebarCollapsed((prev) => (prev === collapsed ? prev : collapsed));
  }, []);

  const handleCollapseWorkspacePanel = useCallback(() => {
    workspacePanelRef.current?.collapse();
  }, []);

  const handleExpandWorkspacePanel = useCallback(() => {
    workspacePanelRef.current?.expand();
  }, []);

  const handleWorkspacePanelResize = useCallback((panelSize: PanelSize) => {
    const collapsed = panelSize.inPixels <= WORKSPACE_PANEL_COLLAPSED_SIZE + 1;
    setIsWorkspacePanelCollapsed((prev) => (prev === collapsed ? prev : collapsed));
  }, []);

  useEffect(() => {
    if (!isSidebarAnimating) {
      return;
    }
    const timer = window.setTimeout(() => {
      setIsSidebarAnimating(false);
    }, SIDEBAR_ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [isSidebarAnimating]);

  useEffect(() => {
    const current = sidebarPanelRef.current;
    if (!current) {
      return;
    }
    setIsSidebarCollapsed(current.isCollapsed());
  }, []);

  useEffect(() => {
    const element = sidebarElementRef.current;
    if (!element) {
      return;
    }
    if (isSidebarAnimating) {
      element.style.transition = `flex-basis ${SIDEBAR_ANIMATION_MS}ms ease-in-out`;
      return;
    }
    element.style.transition = "";
  }, [isSidebarAnimating]);

  // Track layout breakpoint and close mobile sidebar when switching to desktop
  useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 1024px)");
    const handleChange = () => {
      const matches = mediaQuery.matches;
      setIsDesktop(matches);
      if (matches) setIsMobileSidebarOpen(false);
    };
    handleChange();
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  // Track if we've restored session from URL
  const hasRestoredFromUrlRef = useRef(false);

  // Eagerly restore session from URL - don't wait for session list to load
  // This allows session content to load in parallel with the session list
  useEffect(() => {
    if (hasRestoredFromUrlRef.current) {
      return;
    }

    const urlSessionId = getSessionIdFromUrl();
    if (urlSessionId) {
      console.log("[App] Eagerly restoring session from URL:", urlSessionId);
      selectSession(urlSessionId);
    }
    hasRestoredFromUrlRef.current = true;
  }, [selectSession]);

  // Validate session exists once session list loads, clear URL if not found
  useEffect(() => {
    if (sessions.length === 0 || !selectedSessionId) {
      return;
    }

    if (searchQuery.trim() || hasMoreSessions) {
      return;
    }

    const sessionExists = sessions.some(
      (s) => s.sessionId === selectedSessionId,
    );
    if (!sessionExists) {
      console.log("[App] Session from URL not found, clearing selection");
      updateUrlWithSession(null);
      selectSession("");
    }
  }, [sessions, selectedSessionId, selectSession, hasMoreSessions, searchQuery]);

  // Update URL when selected session changes
  useEffect(() => {
    // Skip the initial render before URL restoration
    if (!hasRestoredFromUrlRef.current) {
      return;
    }
    updateUrlWithSession(selectedSessionId || null);
  }, [selectedSessionId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset workbench snapshot when selected session changes
  useEffect(() => {
    setStreamSnapshot(EMPTY_WORKBENCH_STREAM_SNAPSHOT);
  }, [selectedSessionId]);

  // Show toast notifications for errors
  useEffect(() => {
    if (sessionsError) {
      toast.error("Session Error", {
        description: sessionsError,
      });
    }
  }, [sessionsError]);

  const handleStreamStatusChange = useCallback((nextStatus: ChatStatus) => {
    setStreamStatus(nextStatus);
  }, []);

  const handleStreamSnapshotChange = useCallback(
    (nextSnapshot: WorkbenchStreamSnapshot) => {
      setStreamSnapshot((previous) =>
        areWorkbenchStreamSnapshotsEqual(previous, nextSnapshot)
          ? previous
          : nextSnapshot,
      );
    },
    [],
  );

  const handleSessionStatus = useCallback(
    (status: SessionStatus) => {
      applySessionStatus(status);

      if (status.state !== "idle") {
        return;
      }

      const reason = status.reason ?? "";

      if (reason === "config_update") {
        console.log("[App] Config update detected, refreshing global config");
        window.dispatchEvent(new Event("kimi:config-update"));
      }

      if (!reason.startsWith("prompt_")) {
        return;
      }

      console.log(
        "[App] Prompt complete, refreshing session info:",
        status.sessionId,
      );
      refreshSession(status.sessionId);
    },
    [applySessionStatus, refreshSession],
  );

  const handleCreateSession = useCallback(
    async (workDir: string, createDir?: boolean) => {
      await createSession(workDir, createDir);
    },
    [createSession],
  );

  const handleCreateSessionInDir = useCallback(
    async (workDir: string) => {
      await createSession(workDir);
    },
    [createSession],
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      await deleteSession(sessionId);
    },
    [deleteSession],
  );

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      selectSession(sessionId);
      setIsMobileSidebarOpen(false);
    },
    [selectSession],
  );

  const handleRefreshSessions = useCallback(async () => {
    await refreshSessions();
  }, [refreshSessions]);

  const handleSearchQueryChange = useCallback(
    (query: string) => {
      setSearchQuery(query);
    },
    [setSearchQuery],
  );

  // Transform Session[] to SessionSummary[] for sidebar
  const sessionSummaries = useMemo(
    () =>
      sessions.map((session) => ({
        id: session.sessionId,
        title: session.title ?? "Untitled",
        updatedAt: formatRelativeTime(session.lastUpdated),
        workDir: session.workDir,
        lastUpdated: session.lastUpdated,
      })),
    [sessions],
  );

  // Transform archived Session[] to SessionSummary[] for sidebar
  const archivedSessionSummaries = useMemo(
    () =>
      archivedSessions.map((session) => ({
        id: session.sessionId,
        title: session.title ?? "Untitled",
        updatedAt: formatRelativeTime(session.lastUpdated),
        workDir: session.workDir,
        lastUpdated: session.lastUpdated,
      })),
    [archivedSessions],
  );

  const handleForkSession = useCallback(
    async (sessionId: string, turnIndex: number) => {
      await forkSession(sessionId, turnIndex);
    },
    [forkSession],
  );

  const renderChatPanel = (layoutMode: "single" | "workbench") => (
    <ChatWorkspaceContainer
      selectedSessionId={selectedSessionId}
      currentSession={currentSession}
      sessionDescription={currentSession?.title}
      onSessionStatus={handleSessionStatus}
      onStreamStatusChange={handleStreamStatusChange}
      uploadSessionFile={uploadSessionFile}
      onListSessionDirectory={listSessionDirectory}
      onGetSessionFileUrl={getSessionFileUrl}
      onGetSessionFile={getSessionFile}
      onOpenCreateDialog={handleOpenCreateDialog}
      onOpenSidebar={handleOpenMobileSidebar}
      generateTitle={generateTitle}
      onRenameSession={renameSession}
      onForkSession={handleForkSession}
      layoutMode={layoutMode}
      onStreamSnapshotChange={handleStreamSnapshotChange}
    />
  );

  return (
    <PromptInputProvider>
      <div className="box-border flex h-[100dvh] flex-col bg-background text-foreground px-[calc(0.75rem+var(--safe-left))] pr-[calc(0.75rem+var(--safe-right))] pt-[calc(0.75rem+var(--safe-top))] pb-1 lg:pb-[calc(0.75rem+var(--safe-bottom))] max-lg:h-[100svh] max-lg:overflow-hidden">
        <div className="mx-auto flex h-full min-h-0 w-full flex-1 flex-col gap-2 max-w-none">
          {isDesktop ? (
            <ResizablePanelGroup
              orientation="horizontal"
              className="min-h-0 flex-1 overflow-hidden"
            >
              {/* Sidebar */}
              <ResizablePanel
                id="sessions"
                collapsible
                collapsedSize={SIDEBAR_COLLAPSED_SIZE}
                defaultSize={SIDEBAR_DEFAULT_SIZE}
                minSize={SIDEBAR_MIN_SIZE}
                elementRef={sidebarElementRef}
                panelRef={sidebarPanelRef}
                onResize={handleSidebarResize}
                className={cn("relative min-h-0 border-r pl-0.5 pr-2 overflow-hidden")}
              >
                {/* Collapsed sidebar - vertical strip with logo and expand button */}
                <div
                  className={cn(
                    "absolute inset-0 flex h-full flex-col items-center py-3 transition-all duration-200 ease-in-out",
                    isSidebarCollapsed
                      ? "opacity-100 translate-x-0"
                      : "opacity-0 -translate-x-2 pointer-events-none select-none",
                  )}
                >
                  <a
                    href={KIMI_CODE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:opacity-80 transition-opacity"
                    onClick={handleKimiCodeClick}
                  >
                    <img
                      src="/logo.png"
                      alt="Kimi"
                      width={24}
                      height={24}
                      className="size-6"
                    />
                  </a>
                  <button
                    type="button"
                    aria-label="Open settings"
                    title="Settings"
                    className="mt-auto mb-1 inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
                    onClick={handleOpenSettings}
                  >
                    <Settings className="size-4" />
                  </button>
                  <button
                    type="button"
                    aria-label="Expand sidebar"
                    className="mb-1 inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
                    onClick={handleExpandSidebar}
                  >
                    <PanelLeftOpen className="size-4" />
                  </button>
                </div>
                {/* Expanded sidebar */}
                <div
                  className={cn(
                    "absolute inset-0 flex h-full min-h-0 flex-col gap-3 transition-all duration-200 ease-in-out",
                    isSidebarCollapsed
                      ? "opacity-0 translate-x-2 pointer-events-none select-none"
                      : "opacity-100 translate-x-0",
                  )}
                >
                  <SessionsSidebar
                    onDeleteSession={handleDeleteSession}
                    onSelectSession={handleSelectSession}
                    onRenameSession={renameSession}
                    onArchiveSession={archiveSession}
                    onUnarchiveSession={unarchiveSession}
                    onBulkArchiveSessions={bulkArchiveSessions}
                    onBulkUnarchiveSessions={bulkUnarchiveSessions}
                    onBulkDeleteSessions={bulkDeleteSessions}
                    onRefreshSessions={handleRefreshSessions}
                    onRefreshArchivedSessions={refreshArchivedSessions}
                    onLoadMoreSessions={loadMoreSessions}
                    onLoadMoreArchivedSessions={loadMoreArchivedSessions}
                    onOpenCreateDialog={handleOpenCreateDialog}
                    onCreateSessionInDir={handleCreateSessionInDir}
                    streamStatus={streamStatus}
                    selectedSessionId={selectedSessionId}
                    sessions={sessionSummaries}
                    archivedSessions={archivedSessionSummaries}
                    hasMoreSessions={hasMoreSessions}
                    hasMoreArchivedSessions={hasMoreArchivedSessions}
                    isLoadingMore={isLoadingMore}
                    isLoadingMoreArchived={isLoadingMoreArchived}
                    isLoadingArchived={isLoadingArchived}
                    searchQuery={searchQuery}
                    onSearchQueryChange={handleSearchQueryChange}
                  />
                  <div className="mt-auto flex items-center justify-between pl-2 pb-2 pr-2">
                    <div className="flex items-center gap-2">
                      <ThemeToggle />
                      <button
                        type="button"
                        aria-label="Open settings"
                        title="Settings"
                        className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
                        onClick={handleOpenSettings}
                      >
                        <Settings className="size-4" />
                      </button>
                    </div>
                    <button
                      type="button"
                      aria-label="Collapse sidebar"
                      className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
                      onClick={handleCollapseSidebar}
                    >
                      <PanelLeftClose className="size-4" />
                    </button>
                  </div>
                </div>
              </ResizablePanel>

              <ResizableHandle withHandle />

              {/* Main Chat Area */}
              <ResizablePanel id="chat" className="relative min-h-0 flex justify-center flex-1">
                {renderChatPanel("workbench")}
              </ResizablePanel>

              <ResizableHandle withHandle />

              {/* Workspace Panel */}
              <ResizablePanel
                id="workspace"
                collapsible
                collapsedSize={WORKSPACE_PANEL_COLLAPSED_SIZE}
                defaultSize={WORKSPACE_PANEL_DEFAULT_SIZE}
                minSize={WORKSPACE_PANEL_MIN_SIZE}
                panelRef={workspacePanelRef}
                onResize={handleWorkspacePanelResize}
                className="relative min-h-0 overflow-hidden"
              >
                <div
                  className={cn(
                    "absolute inset-0 flex h-full flex-col items-center border-l py-3 transition-all duration-200 ease-in-out",
                    isWorkspacePanelCollapsed
                      ? "opacity-100 translate-x-0"
                      : "opacity-0 translate-x-2 pointer-events-none select-none",
                  )}
                >
                  <button
                    type="button"
                    aria-label="Expand workspace panel"
                    className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
                    onClick={handleExpandWorkspacePanel}
                  >
                    <PanelRightOpen className="size-4" />
                  </button>
                </div>
                <div
                  className={cn(
                    "absolute inset-0 transition-all duration-200 ease-in-out",
                    isWorkspacePanelCollapsed
                      ? "opacity-0 -translate-x-2 pointer-events-none select-none"
                      : "opacity-100 translate-x-0",
                  )}
                >
                  <WorkspacePanel
                    className="w-full border-l"
                    sessionId={selectedSessionId || null}
                    currentSession={currentSession}
                    streamSnapshot={streamSnapshot}
                    onClose={handleCollapseWorkspacePanel}
                    onListSessionDirectory={listSessionDirectory}
                    onGetSessionFileUrl={getSessionFileUrl}
                    onGetSessionFile={getSessionFile}
                  />
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              {renderChatPanel("single")}
            </div>
          )}
        </div>
      </div>

      {/* Toast notifications */}
      <Toaster position="top-right" richColors />

      {/* Create Session Dialog - unified for sidebar button and keyboard shortcut */}
      <CreateSessionDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onConfirm={handleCreateSession}
        fetchWorkDirs={fetchWorkDirs}
        fetchStartupDir={fetchStartupDir}
      />

      {/* Mobile Sessions Sidebar */}
      {isMobileSidebarOpen ? (
        <div className="fixed inset-0 z-50 flex lg:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close sessions sidebar"
            onClick={handleCloseMobileSidebar}
          />
          <div className="relative flex h-full w-[min(86vw,360px)] flex-col border-r border-border bg-background pt-[var(--safe-top)] shadow-2xl">
            <div className="min-h-0 flex-1">
              <SessionsSidebar
                onDeleteSession={handleDeleteSession}
                onSelectSession={handleSelectSession}
                onRenameSession={renameSession}
                onArchiveSession={archiveSession}
                onUnarchiveSession={unarchiveSession}
                onBulkArchiveSessions={bulkArchiveSessions}
                onBulkUnarchiveSessions={bulkUnarchiveSessions}
                onBulkDeleteSessions={bulkDeleteSessions}
                onRefreshSessions={handleRefreshSessions}
                onRefreshArchivedSessions={refreshArchivedSessions}
                onLoadMoreSessions={loadMoreSessions}
                onLoadMoreArchivedSessions={loadMoreArchivedSessions}
                onOpenCreateDialog={handleOpenCreateDialog}
                onCreateSessionInDir={handleCreateSessionInDir}
                onClose={handleCloseMobileSidebar}
                streamStatus={streamStatus}
                selectedSessionId={selectedSessionId}
                sessions={sessionSummaries}
                archivedSessions={archivedSessionSummaries}
                hasMoreSessions={hasMoreSessions}
                hasMoreArchivedSessions={hasMoreArchivedSessions}
                isLoadingMore={isLoadingMore}
                isLoadingMoreArchived={isLoadingMoreArchived}
                isLoadingArchived={isLoadingArchived}
                searchQuery={searchQuery}
                onSearchQueryChange={handleSearchQueryChange}
              />
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2">
              <div className="flex items-center gap-2">
                <ThemeToggle />
                <button
                  type="button"
                  aria-label="Open settings"
                  title="Settings"
                  className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
                  onClick={handleOpenSettings}
                >
                  <Settings className="size-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      <SettingsDialog
        open={showSettingsDialog}
        onOpenChange={setShowSettingsDialog}
      />
    </PromptInputProvider>
  );
}

export default App;
