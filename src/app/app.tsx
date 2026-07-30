import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { useTheme } from "@/hooks/use-theme";
import { useGitDiffStats } from "@/hooks/useGitDiffStats";
import { useSessionStream } from "@/hooks/useSessionStream";
import { DirectoryNotFoundError, useSessions } from "@/hooks/useSessions";
import { getApiBaseUrl, hasPlatformModifier } from "@/hooks/utils";
import type { SessionStatus, UploadSessionFileResponse } from "@/lib/api/models";
import { useDomTranslations, useI18n } from "@/lib/i18n";
import { classifyIdleReason } from "@/lib/idle-turn";
import { openKimiCodeWebsite } from "@/lib/kimi-code-link";
import { shouldPauseForRuntimeReadiness } from "@/lib/runtime-readiness";
import {
  checkRuntimeReadiness,
  isTauri,
  listenEvent,
  type RuntimeReadiness,
  sendNotification,
  setNativeUiLanguage,
  showWindow,
} from "@/lib/tauri-api";
import { useToolEventsStore } from "@/lib/tool-events/store";
import { ConversationView } from "@/modules/conversation/conversation-view";
import { GoalCancelConfirmation } from "@/modules/conversation/goal-cancel-confirmation";
import { ReadinessOverlay } from "@/modules/readiness/readiness-overlay";
import { AppSidebar } from "@/modules/sessions/app-sidebar";
import { SettingsDialog, type SettingsTab } from "@/modules/settings/settings-dialog";
import { type SessionModeDraft, shouldAutoApprove } from "@/modules/statusbar/permission-mode";
import { Topbar } from "@/modules/topbar/topbar";
import { ChangesPanel, type WorkspaceTab } from "@/modules/workspace/changes-panel";
import {
  deriveChanges,
  derivePendingApprovals,
  mergeGitChanges,
} from "@/modules/workspace/derive-changes";
import { AppShell } from "./app-shell";
import { NewSessionView } from "./new-session-view";

type GoalCancelTarget = {
  sessionId: string;
  goalId?: string;
  objective: string;
};

/** Wait for YOLO auto-approve / quick resolve before surfacing a system toast. */
const APPROVAL_NOTIFICATION_DELAY_MS = 400;

export default function App() {
  useTheme();
  useDomTranslations();
  const { resolvedLanguage, t } = useI18n();

  useLayoutEffect(() => {
    if (isTauri()) {
      showWindow().catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void setNativeUiLanguage(resolvedLanguage).catch(() => {});
  }, [resolvedLanguage]);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("changes");
  const [newSessionWorkDir, setNewSessionWorkDir] = useState("");
  const [pendingFirstMessage, setPendingFirstMessage] = useState<string | null>(null);
  const [pendingFirstAttachments, setPendingFirstAttachments] = useState<
    UploadSessionFileResponse[]
  >([]);
  const [pendingFirstModes, setPendingFirstModes] = useState<SessionModeDraft | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>();
  const [runtimeReadiness, setRuntimeReadiness] = useState<RuntimeReadiness | null>(null);
  const [runtimeCheckError, setRuntimeCheckError] = useState<string | null>(null);
  const [isCheckingRuntime, setIsCheckingRuntime] = useState(() => isTauri());
  const [hasAcknowledgedRuntime, setHasAcknowledgedRuntime] = useState(() => !isTauri());
  const [goalCancelOpen, setGoalCancelOpen] = useState(false);
  const [goalCancelPending, setGoalCancelPending] = useState(false);
  const [goalCancelTarget, setGoalCancelTarget] = useState<GoalCancelTarget | null>(null);
  const currentGoal = useToolEventsStore((state) => state.currentGoal);

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
    isLoading,
    isLoadingArchived,
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

  useEffect(() => {
    if (shouldPauseRuntime) return;
    fetchStartupDir()
      .then((dir) => setNewSessionWorkDir((current) => current || dir))
      .catch(() => {});
  }, [fetchStartupDir, shouldPauseRuntime]);

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
      if (isTauri() && !document.hasFocus() && classified.wouldNotifySuccess) {
        const body = classified.isCancelled ? t("任务已取消") : t("任务已完成");
        const completedSession = sessions.find((session) => session.sessionId === status.sessionId);
        void sendNotification(completedSession?.title || "Kimi Code", body).catch(() => {});
      }
      refreshSession(status.sessionId);
    },
    [applySessionStatus, refreshSession, sessions, t],
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

  const handleGoalControl = useCallback(
    async (action: "pause" | "resume" | "cancel") => {
      if (action === "cancel") {
        if (!selectedSessionId || !currentGoal || currentGoal.status === "complete") return;
        const target: GoalCancelTarget = {
          sessionId: selectedSessionId,
          goalId: currentGoal.goalId,
          objective: currentGoal.objective,
        };
        setGoalCancelTarget(target);
        window.dispatchEvent(
          new CustomEvent("kimi:goal-cancel-pending", {
            detail: { sessionId: target.sessionId },
          }),
        );
        setGoalCancelOpen(true);
        return;
      }
      const outcome = await stream.controlGoal(action);
      if (outcome?.error) toast.error(outcome.content);
    },
    [currentGoal, selectedSessionId, stream.controlGoal],
  );

  const dismissGoalCancel = useCallback(() => {
    const target = goalCancelTarget;
    setGoalCancelOpen(false);
    setGoalCancelTarget(null);
    if (target) {
      window.dispatchEvent(
        new CustomEvent("kimi:goal-cancel-dismissed", {
          detail: { sessionId: target.sessionId },
        }),
      );
    }
  }, [goalCancelTarget]);

  const handleGoalCancelOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setGoalCancelOpen(true);
      } else if (!goalCancelPending) {
        dismissGoalCancel();
      }
    },
    [dismissGoalCancel, goalCancelPending],
  );

  const confirmGoalCancel = useCallback(async () => {
    const target = goalCancelTarget;
    if (!target) return;
    const liveGoal = useToolEventsStore.getState().currentGoal;
    const sameGoal = target.goalId
      ? liveGoal?.goalId === target.goalId
      : liveGoal?.objective === target.objective;
    if (selectedSessionId !== target.sessionId || !sameGoal) {
      toast.error("Goal 已变化，请重新操作");
      dismissGoalCancel();
      return;
    }

    setGoalCancelPending(true);
    try {
      const outcome = await stream.controlGoal("cancel");
      if (outcome?.error) {
        toast.error(outcome.content);
        return;
      }
      window.dispatchEvent(
        new CustomEvent("kimi:goal-cancelled", {
          detail: { sessionId: target.sessionId },
        }),
      );
      setGoalCancelOpen(false);
      setGoalCancelTarget(null);
    } catch (error) {
      toast.error("取消 Goal 失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setGoalCancelPending(false);
    }
  }, [dismissGoalCancel, goalCancelTarget, selectedSessionId, stream.controlGoal]);
  const userClosedPanelRef = useRef(false);

  useEffect(() => {
    void selectedSessionId;
    userClosedPanelRef.current = false;
    setPanelOpen(false);
    setWorkspaceTab("changes");
    setGoalCancelOpen(false);
    setGoalCancelPending(false);
    setGoalCancelTarget(null);
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
  const pendingApprovalsRef = useRef(pendingApprovals);
  pendingApprovalsRef.current = pendingApprovals;
  const permissionMode = stream.permissionMode;

  useEffect(() => {
    if (!isTauri() || document.hasFocus()) return;

    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const approval of pendingApprovals) {
      // YOLO/auto will approve these client-side — never toast "需要批准".
      if (shouldAutoApprove(permissionMode, approval.toolTitle, approval.toolKind)) {
        continue;
      }
      const notificationKey = `${selectedSessionId}:${approval.id}`;
      if (notifiedApprovalsRef.current.has(notificationKey)) continue;
      // Delay so auto-approve / cancel / resolve can clear the request first.
      timers.push(
        setTimeout(() => {
          if (notifiedApprovalsRef.current.has(notificationKey)) return;
          if (document.hasFocus()) return;
          const stillNeedsUser = pendingApprovalsRef.current.some(
            (item) =>
              item.id === approval.id &&
              !shouldAutoApprove(permissionMode, item.toolTitle, item.toolKind),
          );
          if (!stillNeedsUser) return;
          notifiedApprovalsRef.current.add(notificationKey);
          void sendNotification(t("Kimi Code 需要批准"), approval.description).catch(() => {});
        }, APPROVAL_NOTIFICATION_DELAY_MS),
      );
    }

    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [pendingApprovals, permissionMode, selectedSessionId, t]);

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
      if (hasPlatformModifier(e) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        focusSessionSearch();
      } else if (hasPlatformModifier(e) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        selectSession("");
      } else if (hasPlatformModifier(e) && e.key === ",") {
        e.preventDefault();
        openSettings();
      } else if (e.key === "Escape" && panelOpen) {
        handleClosePanel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusSessionSearch, handleClosePanel, openSettings, panelOpen, selectSession]);

  useEffect(() => {
    if (sessionsError) {
      toast.error("Session Error", { description: sessionsError });
    }
  }, [sessionsError]);

  const handleNewSession = useCallback(() => {
    selectSession("");
  }, [selectSession]);

  useEffect(() => {
    const stopNewSession = listenEvent("tauri://new-session", handleNewSession);
    const stopOpenSettings = listenEvent("tauri://open-settings", () => openSettings());
    return () => {
      stopNewSession();
      stopOpenSettings();
    };
  }, [handleNewSession, openSettings]);

  const handleSendFirstMessage = useCallback(
    async (
      workDir: string,
      text: string,
      modes: SessionModeDraft | null,
      attachments: UploadSessionFileResponse[],
    ) => {
      setPendingFirstMessage(text);
      setPendingFirstAttachments(attachments);
      setPendingFirstModes(modes);
      try {
        await createSession(workDir);
      } catch (err) {
        setPendingFirstMessage(null);
        setPendingFirstAttachments([]);
        setPendingFirstModes(null);
        if (err instanceof DirectoryNotFoundError) {
          toast.error(t("工作目录不存在"), { description: workDir });
        }
        throw err;
      }
    },
    [createSession, t],
  );

  const handlePendingFirstMessageSent = useCallback(() => {
    setPendingFirstMessage(null);
    setPendingFirstAttachments([]);
    setPendingFirstModes(null);
  }, []);

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
            onNewSession={handleNewSession}
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
            onCreateInWorkDir={(workDir) => {
              setNewSessionWorkDir(workDir);
              selectSession("");
            }}
            onLoadArchived={refreshArchivedSessions}
            onLoadMore={(mode) =>
              mode === "active" ? loadMoreSessions() : loadMoreArchivedSessions()
            }
            hasLoadedArchived={hasLoadedArchivedSessions}
            hasMoreActive={hasMoreSessions}
            hasMoreArchived={hasMoreArchivedSessions}
            isLoadingActive={isLoading}
            isLoadingArchived={isLoadingArchived}
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
            onGoalControl={handleGoalControl}
            onClose={handleClosePanel}
          />
        }
        panelOpen={panelOpen}
      >
        {selectedSessionId ? (
          <ConversationView
            key={selectedSessionId}
            sessionId={selectedSessionId}
            workDir={currentSession?.workDir}
            stream={stream}
            onOpenWorkspace={handleOpenWorkspace}
            onUploadFile={uploadSessionFile}
            listDirectory={listSessionDirectory}
            onManageConfig={() => openSettings("config")}
            pendingFirstMessage={pendingFirstMessage}
            pendingFirstAttachments={pendingFirstAttachments}
            pendingFirstModes={pendingFirstModes}
            onPendingFirstMessageSent={handlePendingFirstMessageSent}
            onGoalControl={handleGoalControl}
          />
        ) : (
          <NewSessionView
            workDir={newSessionWorkDir}
            onWorkDirChange={setNewSessionWorkDir}
            fetchWorkDirs={fetchWorkDirs}
            onSendFirstMessage={handleSendFirstMessage}
            onUploadFile={uploadSessionFile}
            onManageConfig={() => openSettings("config")}
          />
        )}
      </AppShell>
      <SettingsDialog
        open={showSettings}
        onOpenChange={handleSettingsOpenChange}
        initialTab={settingsInitialTab}
      />
      <GoalCancelConfirmation
        open={goalCancelOpen}
        objective={goalCancelTarget?.objective}
        pending={goalCancelPending}
        onOpenChange={handleGoalCancelOpenChange}
        onConfirm={() => void confirmGoalCancel()}
      />
      <Toaster position="top-right" style={{ fontFamily: "var(--font-sans)" }} />
    </>
  );
}
