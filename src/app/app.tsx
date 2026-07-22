import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { useTheme } from "@/hooks/use-theme";
import { useGitDiffStats } from "@/hooks/useGitDiffStats";
import { useSessionStream } from "@/hooks/useSessionStream";
import { useSessions } from "@/hooks/useSessions";
import { getApiBaseUrl } from "@/hooks/utils";
import type { SessionStatus } from "@/lib/api/models";
import { classifyIdleReason } from "@/lib/idle-turn";
import { openKimiCodeWebsite } from "@/lib/kimi-code-link";
import { shouldPauseForRuntimeReadiness } from "@/lib/runtime-readiness";
import {
  checkRuntimeReadiness,
  isTauri,
  type RuntimeReadiness,
  sendNotification,
  showWindow,
} from "@/lib/tauri-api";
import { ConversationView } from "@/modules/conversation/conversation-view";
import { ReadinessOverlay } from "@/modules/readiness/readiness-overlay";
import { AppSidebar } from "@/modules/sessions/app-sidebar";
import { CreateSessionDialog } from "@/modules/sessions/create-session-dialog";
import { SettingsDialog, type SettingsTab } from "@/modules/settings/settings-dialog";
import { Topbar } from "@/modules/topbar/topbar";
import { ChangesPanel, type WorkspaceTab } from "@/modules/workspace/changes-panel";
import {
  deriveChanges,
  derivePendingApprovals,
  mergeGitChanges,
} from "@/modules/workspace/derive-changes";
import { AppShell } from "./app-shell";
import { EmptyState } from "./empty-state";

export default function App() {
  useTheme();

  useLayoutEffect(() => {
    if (isTauri()) {
      showWindow().catch(() => {});
    }
  }, []);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("changes");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>();
  const [runtimeReadiness, setRuntimeReadiness] = useState<RuntimeReadiness | null>(null);
  const [runtimeCheckError, setRuntimeCheckError] = useState<string | null>(null);
  const [isCheckingRuntime, setIsCheckingRuntime] = useState(() => isTauri());
  const [hasAcknowledgedRuntime, setHasAcknowledgedRuntime] = useState(() => !isTauri());

  const runRuntimeReadinessCheck = useCallback(async () => {
    if (!isTauri()) {
      setRuntimeReadiness(null);
      setRuntimeCheckError(null);
      setIsCheckingRuntime(false);
      setHasAcknowledgedRuntime(true);
      return;
    }
    setIsCheckingRuntime(true);
    setRuntimeCheckError(null);
    setHasAcknowledgedRuntime(false);
    try {
      const readiness = await checkRuntimeReadiness();
      setRuntimeReadiness(readiness);
      setHasAcknowledgedRuntime(!shouldPauseForRuntimeReadiness(readiness, false));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to run startup readiness checks.";
      setRuntimeReadiness(null);
      setRuntimeCheckError(message);
    } finally {
      setIsCheckingRuntime(false);
    }
  }, []);

  useEffect(() => {
    runRuntimeReadinessCheck();
  }, [runRuntimeReadinessCheck]);

  const shouldPauseRuntime =
    isTauri() &&
    (isCheckingRuntime ||
      Boolean(runtimeCheckError) ||
      shouldPauseForRuntimeReadiness(runtimeReadiness, hasAcknowledgedRuntime));

  const {
    sessions,
    archivedSessions,
    selectedSessionId,
    createSession,
    deleteSession,
    selectSession,
    renameSession,
    archiveSession,
    unarchiveSession,
    bulkArchiveSessions,
    bulkUnarchiveSessions,
    bulkDeleteSessions,
    archiveSessionsOlderThan,
    refreshArchivedSessions,
    hasLoadedArchivedSessions,
    loadMoreSessions,
    loadMoreArchivedSessions,
    hasMoreSessions,
    hasMoreArchivedSessions,
    isLoadingMore,
    isLoadingMoreArchived,
    searchQuery,
    setSearchQuery,
    fetchWorkDirs,
    fetchStartupDir,
    applySessionStatus,
    refreshSession,
    listSessionDirectory,
    getSessionFile,
    uploadSessionFile,
    error: sessionsError,
  } = useSessions({ enabled: !shouldPauseRuntime });

  const currentSession = useMemo(
    () => sessions.find((s) => s.sessionId === selectedSessionId),
    [sessions, selectedSessionId],
  );

  const anyRunning = useMemo(() => sessions.some((s) => s.isRunning), [sessions]);

  const handleSessionStatus = useCallback(
    (status: SessionStatus) => {
      applySessionStatus(status);
      if (status.state !== "idle") return;
      const reason = status.reason ?? "";
      if (reason === "config_update") {
        window.dispatchEvent(new Event("kimi:config-update"));
      }
      const classified = classifyIdleReason(reason);
      if (!classified.isTurnComplete) return;
      if (
        isTauri() &&
        !document.hasFocus() &&
        classified.wouldNotifySuccess
      ) {
        const body = classified.isCancelled ? "任务已取消" : "任务已完成";
        const completedSession = sessions.find(
          (session) => session.sessionId === status.sessionId,
        );
        void sendNotification(completedSession?.title || "Kimi Code", body).catch(() => {});
      }
      refreshSession(status.sessionId);
    },
    [applySessionStatus, refreshSession, sessions],
  );

  const handleStreamError = useCallback((error: Error) => {
    toast.error("Stream Error", { description: error.message });
  }, []);

  const stream = useSessionStream({
    sessionId: shouldPauseRuntime || !selectedSessionId ? null : selectedSessionId,
    baseUrl: getApiBaseUrl(),
    onError: handleStreamError,
    onSessionStatus: handleSessionStatus,
    autoConnect: !shouldPauseRuntime && Boolean(currentSession?.isRunning),
  });
  const gitDiff = useGitDiffStats(selectedSessionId || null);

  const userClosedPanelRef = useRef(false);

  useEffect(() => {
    void selectedSessionId;
    userClosedPanelRef.current = false;
    setPanelOpen(false);
    setWorkspaceTab("changes");
  }, [selectedSessionId]);

  const semanticChanges = useMemo(() => deriveChanges(stream.messages), [stream.messages]);
  const changes = useMemo(
    () => mergeGitChanges(semanticChanges, gitDiff.stats),
    [gitDiff.stats, semanticChanges],
  );
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(stream.messages),
    [stream.messages],
  );
  const notifiedApprovalsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!isTauri() || document.hasFocus()) return;
    for (const approval of pendingApprovals) {
      const notificationKey = `${selectedSessionId}:${approval.id}`;
      if (notifiedApprovalsRef.current.has(notificationKey)) continue;
      notifiedApprovalsRef.current.add(notificationKey);
      void sendNotification("Kimi Code 需要批准", approval.description).catch(() => {});
    }
  }, [pendingApprovals, selectedSessionId]);

  useEffect(() => {
    if (changes.length > 0 && !userClosedPanelRef.current) {
      setWorkspaceTab("changes");
      setPanelOpen(true);
    }
  }, [changes.length]);

  const handleApproveAll = useCallback(() => {
    for (const approval of pendingApprovals) {
      void stream.respondToApproval(approval.id, "approve");
    }
  }, [stream, pendingApprovals]);

  const handleRejectAll = useCallback(() => {
    for (const approval of pendingApprovals) {
      void stream.respondToApproval(approval.id, "reject");
    }
  }, [stream, pendingApprovals]);

  const handleClosePanel = useCallback(() => {
    userClosedPanelRef.current = true;
    setPanelOpen(false);
  }, []);

  const handleOpenWorkspace = useCallback((tab: WorkspaceTab = "files") => {
    userClosedPanelRef.current = false;
    setWorkspaceTab(tab);
    setPanelOpen(true);
  }, []);

  const openSettings = useCallback((tab?: SettingsTab) => {
    setSettingsInitialTab(tab);
    setShowSettings(true);
  }, []);

  const handleSettingsOpenChange = useCallback((next: boolean) => {
    setShowSettings(next);
    if (!next) setSettingsInitialTab(undefined);
  }, []);

  const focusSessionSearch = useCallback(() => {
    setSidebarOpen(true);
    requestAnimationFrame(() => {
      document.getElementById("sessions-search-input")?.focus();
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        focusSessionSearch();
      } else if (e.key === "Escape" && panelOpen) {
        handleClosePanel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusSessionSearch, handleClosePanel, panelOpen]);

  useEffect(() => {
    if (sessionsError) {
      toast.error("Session Error", { description: sessionsError });
    }
  }, [sessionsError]);

  const handleCreateSession = useCallback(
    async (workDir: string) => {
      await createSession(workDir);
    },
    [createSession],
  );

  if (shouldPauseRuntime) {
    return (
      <ReadinessOverlay
        checking={isCheckingRuntime}
        readiness={runtimeReadiness}
        error={runtimeCheckError}
        onRetry={runRuntimeReadinessCheck}
        onContinue={() => {
          setRuntimeCheckError(null);
          setHasAcknowledgedRuntime(true);
        }}
        onOpenDownload={() => void openKimiCodeWebsite()}
      />
    );
  }

  return (
    <>
      <AppShell
        sidebar={
          <AppSidebar
            collapsed={!sidebarOpen}
            running={anyRunning}
            onToggleCollapsed={() => setSidebarOpen((v) => !v)}
            onNewSession={() => setShowCreateDialog(true)}
            onOpenSettings={() => openSettings()}
            sessions={sessions}
            archivedSessions={archivedSessions}
            selectedId={selectedSessionId}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onSelect={selectSession}
            onDelete={(id) => void deleteSession(id)}
            onRename={(id, title) => void renameSession(id, title)}
            onArchive={(id) => void archiveSession(id)}
            onUnarchive={(id) => void unarchiveSession(id)}
            onBulkArchive={async (ids) => {
              await bulkArchiveSessions(ids);
            }}
            onBulkUnarchive={async (ids) => {
              await bulkUnarchiveSessions(ids);
            }}
            onBulkDelete={async (ids) => {
              await bulkDeleteSessions(ids);
            }}
            onArchiveOlderThan={async (days) => {
              await archiveSessionsOlderThan(days);
            }}
            onLoadArchived={refreshArchivedSessions}
            onLoadMore={(mode) =>
              mode === "active" ? loadMoreSessions() : loadMoreArchivedSessions()
            }
            hasLoadedArchived={hasLoadedArchivedSessions}
            hasMoreActive={hasMoreSessions}
            hasMoreArchived={hasMoreArchivedSessions}
            isLoadingMoreActive={isLoadingMore}
            isLoadingMoreArchived={isLoadingMoreArchived}
          />
        }
        sidebarOpen={sidebarOpen}
        topbar={
          <Topbar
            title={currentSession?.title ?? "Kimi Code"}
            shortId={selectedSessionId ? selectedSessionId.slice(0, 6) : undefined}
            sessionId={selectedSessionId || undefined}
            workDir={currentSession?.workDir}
            panelOpen={panelOpen}
            onTogglePanel={() => setPanelOpen((v) => !v)}
            onOpenSettings={() => openSettings()}
          />
        }
        panel={
          <ChangesPanel
            sessionId={selectedSessionId}
            activeTab={workspaceTab}
            onTabChange={setWorkspaceTab}
            changes={changes}
            pendingApprovals={pendingApprovals}
            changesLoading={gitDiff.isLoading}
            changesError={gitDiff.error}
            onRefreshChanges={() => void gitDiff.refresh()}
            listDirectory={listSessionDirectory}
            getFile={getSessionFile}
            onApproveAll={handleApproveAll}
            onRejectAll={handleRejectAll}
            onClose={handleClosePanel}
          />
        }
        panelOpen={panelOpen}
      >
        {selectedSessionId ? (
          <ConversationView
            key={selectedSessionId}
            sessionId={selectedSessionId}
            stream={stream}
            onOpenWorkspace={handleOpenWorkspace}
            onUploadFile={uploadSessionFile}
            onManageConfig={() => openSettings("config")}
          />
        ) : (
          <EmptyState onNewSession={() => setShowCreateDialog(true)} />
        )}
      </AppShell>
      <CreateSessionDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onConfirm={handleCreateSession}
        fetchWorkDirs={fetchWorkDirs}
        fetchStartupDir={fetchStartupDir}
      />
      <SettingsDialog
        open={showSettings}
        onOpenChange={handleSettingsOpenChange}
        initialTab={settingsInitialTab}
      />
      <Toaster position="top-right" />
    </>
  );
}
