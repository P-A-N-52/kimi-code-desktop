import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useGlobalConfig } from "@/hooks/useGlobalConfig";
import type {
  GoalStartConfirmationResult,
  SendMessageResult,
  UseSessionStreamReturn,
} from "@/hooks/useSessionStream";
import type { SessionFileEntry } from "@/hooks/useSessions";
import { useSkillSlashCommands } from "@/hooks/useSkillSlashCommands";
import type { UploadSessionFileResponse } from "@/lib/api/models";
import { notifyGlobalConfigApplied } from "@/lib/config-update-toast";
import { parseGoalCommand } from "@/lib/goal";
import {
  findConfigModel,
  modelForcesThinking,
  modelHasThinkingCapability,
} from "@/lib/model-capabilities";
import {
  classifySlashDispatch,
  mergeSlashCommands,
  parseSlashCommandInput,
} from "@/lib/slash-command-catalog";
import {
  appendSessionGoalQueue,
  getSessionGoalQueue,
  isTauri,
  moveSessionGoalQueue,
  removeSessionGoalQueue,
  type UpcomingGoal,
  updateSessionGoalQueue,
} from "@/lib/tauri-api";
import { useToolEventsStore } from "@/lib/tool-events/store";
import {
  CommandResultPanel,
  type CommandResultPanelState,
} from "@/modules/composer/command-result-panel";
import { Composer, type QueuedPrompt } from "@/modules/composer/composer";
import { WorkDirPicker } from "@/modules/sessions/work-dir-picker";
import { type SessionModeDraft, shouldAutoApprove } from "@/modules/statusbar/permission-mode";
import { StatusStrip } from "@/modules/statusbar/status-strip";
import type { WorkspaceTab } from "@/modules/workspace/changes-panel";
import { GoalQueueManager } from "./goal-queue-manager";
import { GoalStartConfirmation } from "./goal-start-confirmation";
import { MessageList } from "./message-list";

type SessionComposerState = { draft: string; queue: QueuedPrompt[] };
type PendingGoalStart = {
  text: string;
  attachments: UploadSessionFileResponse[];
  request: GoalStartConfirmationResult;
  promotedGoal?: UpcomingGoal;
};
const composerStateBySession = new Map<string, SessionComposerState>();

export function ConversationView({
  sessionId,
  workDir,
  stream,
  onOpenWorkspace,
  onUploadFile,
  onManageConfig,
  listDirectory,
  pendingFirstMessage,
  pendingFirstAttachments,
  pendingFirstModes,
  onPendingFirstMessageSent,
  onGoalControl,
}: {
  sessionId: string;
  /** Session work directory — shown fixed above the composer (not selectable). */
  workDir?: string | null;
  stream: UseSessionStreamReturn;
  onOpenWorkspace: (tab?: WorkspaceTab) => void;
  onUploadFile: (sessionId: string, file: File) => Promise<UploadSessionFileResponse>;
  onManageConfig?: () => void;
  listDirectory?: (sessionId: string, path?: string) => Promise<SessionFileEntry[]>;
  pendingFirstMessage?: string | null;
  pendingFirstAttachments?: UploadSessionFileResponse[];
  pendingFirstModes?: SessionModeDraft | null;
  onPendingFirstMessageSent?: () => void;
  onGoalControl?: (action: "pause" | "resume" | "cancel") => Promise<unknown>;
}) {
  const { messages, respondToApproval } = stream;
  const permissionMode = stream.permissionMode;

  useEffect(() => {
    if (permissionMode === "manual") return;
    for (const m of messages) {
      const tc = m.toolCall;
      if (
        tc?.state === "approval-requested" &&
        tc.approval &&
        !tc.approval.submitted &&
        !tc.approval.resolved &&
        shouldAutoApprove(permissionMode, tc.title, tc.approval.toolKind)
      ) {
        void respondToApproval(tc.approval.id, "approve");
      }
    }
  }, [messages, permissionMode, respondToApproval]);

  const initialComposerState = composerStateBySession.get(sessionId);
  const [composerState, setComposerState] = useState<SessionComposerState>(
    initialComposerState ?? { draft: "", queue: [] },
  );
  const { draft, queue } = composerState;
  const [commandResult, setCommandResult] = useState<CommandResultPanelState | null>(null);
  const [pendingGoalStart, setPendingGoalStart] = useState<PendingGoalStart | null>(null);
  const [goalStartPending, setGoalStartPending] = useState(false);
  const [upcomingGoals, setUpcomingGoals] = useState<UpcomingGoal[]>([]);
  const [goalQueueOpen, setGoalQueueOpen] = useState(false);
  const [goalQueuePendingId, setGoalQueuePendingId] = useState<string | undefined>();
  const [goalQueuePromotionRequested, setGoalQueuePromotionRequested] = useState(false);
  const goalCompletionObservedRef = useRef({
    sessionId,
    epoch: stream.goalCompletionEpoch,
  });
  const goalQueuePromotionInFlightRef = useRef(false);
  const goalQueueMutationInFlightRef = useRef(false);
  const suppressGoalQueuePromotionRef = useRef(false);
  const { config, update, isUpdating } = useGlobalConfig();
  const busy = stream.status === "submitted" || stream.status === "streaming";
  const currentGoal = useToolEventsStore((state) => state.currentGoal);
  const skillCommands = useSkillSlashCommands();
  const slashCommands = useMemo(
    () => mergeSlashCommands(stream.slashCommands, skillCommands),
    [stream.slashCommands, skillCommands],
  );
  useEffect(() => {
    setPendingGoalStart(null);
    setGoalStartPending(false);
    setUpcomingGoals([]);
    setGoalQueueOpen(false);
    setGoalQueuePendingId(undefined);
    setGoalQueuePromotionRequested(false);
    goalCompletionObservedRef.current = {
      sessionId,
      epoch: 0,
    };
    goalQueuePromotionInFlightRef.current = false;
    suppressGoalQueuePromotionRef.current = false;

    if (!isTauri()) return;
    let cancelled = false;
    void getSessionGoalQueue(sessionId)
      .then((snapshot) => {
        if (!cancelled) setUpcomingGoals(snapshot.goals);
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error("Failed to load upcoming Goals", {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!currentGoal || currentGoal.status === "complete") return;
    suppressGoalQueuePromotionRef.current = false;
  }, [currentGoal]);

  useEffect(() => {
    const isCurrentSession = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      return detail?.sessionId === sessionId;
    };
    const handleGoalCancelPending = (event: Event) => {
      if (isCurrentSession(event)) suppressGoalQueuePromotionRef.current = true;
    };
    const handleGoalCancelled = (event: Event) => {
      if (isCurrentSession(event)) {
        suppressGoalQueuePromotionRef.current = true;
        setGoalQueuePromotionRequested(false);
      }
    };
    const handleGoalCancelDismissed = (event: Event) => {
      if (isCurrentSession(event)) suppressGoalQueuePromotionRef.current = false;
    };
    window.addEventListener("kimi:goal-cancel-pending", handleGoalCancelPending);
    window.addEventListener("kimi:goal-cancelled", handleGoalCancelled);
    window.addEventListener("kimi:goal-cancel-dismissed", handleGoalCancelDismissed);
    return () => {
      window.removeEventListener("kimi:goal-cancel-pending", handleGoalCancelPending);
      window.removeEventListener("kimi:goal-cancelled", handleGoalCancelled);
      window.removeEventListener("kimi:goal-cancel-dismissed", handleGoalCancelDismissed);
    };
  }, [sessionId]);

  const refreshGoalQueue = useCallback(async () => {
    if (!isTauri()) return [];
    try {
      const snapshot = await getSessionGoalQueue(sessionId);
      setUpcomingGoals(snapshot.goals);
      return snapshot.goals;
    } catch (error) {
      toast.error("Failed to load upcoming Goals", {
        description: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }, [sessionId]);

  useEffect(() => {
    const observed = goalCompletionObservedRef.current;
    if (observed.sessionId !== sessionId) {
      goalCompletionObservedRef.current = { sessionId, epoch: stream.goalCompletionEpoch };
      return;
    }
    if (stream.goalCompletionEpoch <= observed.epoch) return;
    observed.epoch = stream.goalCompletionEpoch;
    if (!isTauri()) return;
    void refreshGoalQueue().then((goals) => {
      if (goalCompletionObservedRef.current.sessionId !== sessionId) return;
      setGoalQueuePromotionRequested(goals.length > 0);
    });
  }, [refreshGoalQueue, sessionId, stream.goalCompletionEpoch]);

  const setDraft = useCallback(
    (value: string) => {
      setComposerState((current) => {
        const next = { ...current, draft: value };
        composerStateBySession.set(sessionId, next);
        return next;
      });
    },
    [sessionId],
  );

  const setQueue = useCallback(
    (update: QueuedPrompt[] | ((current: QueuedPrompt[]) => QueuedPrompt[])) => {
      setComposerState((current) => {
        const queue = typeof update === "function" ? update(current.queue) : update;
        const next = { ...current, queue };
        composerStateBySession.set(sessionId, next);
        return next;
      });
    },
    [sessionId],
  );

  const selectedModel = config?.defaultModel || "";
  const models = config?.models ?? [];
  const selectedConfigModel = useMemo(
    () => findConfigModel(models, selectedModel),
    [models, selectedModel],
  );

  const handleSelectModel = useCallback(
    async (name: string) => {
      if (!name || name === selectedModel) return;
      try {
        const resp = await update({ defaultModel: name });
        notifyGlobalConfigApplied(resp, `已切换到 ${name}`);
      } catch (error) {
        toast.error("切换模型失败", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [selectedModel, update],
  );

  const handleToggleThinking = useCallback(
    async (enabled: boolean) => {
      if (modelForcesThinking(selectedConfigModel)) return;
      if (!modelHasThinkingCapability(selectedConfigModel)) return;
      try {
        const resp = await update({ defaultThinking: enabled });
        notifyGlobalConfigApplied(resp, enabled ? "思考模式已开启" : "思考模式已关闭");
      } catch (error) {
        toast.error("更新思考模式失败", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [selectedConfigModel, update],
  );

  const handleSelectThinkingEffort = useCallback(
    async (effort: string) => {
      if (!selectedConfigModel?.supportEfforts?.includes(effort)) return;
      try {
        const resp = await update({ thinkingEffort: effort });
        notifyGlobalConfigApplied(resp, `思考档位已切换为 ${effort}`);
      } catch (error) {
        toast.error("更新思考档位失败", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [selectedConfigModel, update],
  );

  const showInfoPanel = useCallback(
    async (command: "usage" | "status") => {
      setCommandResult({ command, content: "", loading: true });
      try {
        const content = await stream.runLocalInfoCommand(command);
        setCommandResult({ command, content, loading: false });
      } catch (error) {
        setCommandResult({
          command,
          content: error instanceof Error ? error.message : `Failed to run /${command}`,
          loading: false,
        });
      }
    },
    [stream],
  );

  const handleSendOutcome = useCallback(
    (
      outcome: SendMessageResult,
      text: string,
      attachments: UploadSessionFileResponse[],
      promotedGoal?: UpcomingGoal,
    ) => {
      if (!outcome) return;
      if (outcome.kind === "info-panel") {
        setCommandResult({
          command: outcome.command,
          content: outcome.content,
          loading: false,
        });
        return;
      }
      setPendingGoalStart({ text, attachments, request: outcome, promotedGoal });
    },
    [],
  );

  const sendInFlightRef = useRef(false);
  const send = useCallback(
    (textOverride?: string, attachments: UploadSessionFileResponse[] = []) => {
      const text = (textOverride ?? draft).trim();
      if (!text && attachments.length === 0) return;
      if (stream.status === "error") return;

      const parsedSlash = parseSlashCommandInput(text);
      const goalWords = parsedSlash?.name === "goal" ? parsedSlash.args.trim().split(/\s+/) : [];
      const goalSubcommand = goalWords[0];
      const parsedGoalCommand =
        parsedSlash?.name === "goal" ? parseGoalCommand(parsedSlash.args) : null;
      const goalNextObjective =
        goalSubcommand === "next" && parsedGoalCommand?.kind === "create"
          ? parsedGoalCommand.objective
          : null;
      const isGoalNext = goalNextObjective !== null;
      const isGoalNextManage =
        goalSubcommand === "next" &&
        goalWords.length === 2 &&
        goalWords[1] === "manage";
      const isImmediateGoalCommand =
        parsedGoalCommand !== null &&
        (parsedGoalCommand.kind === "status" ||
          parsedGoalCommand.kind === "invalid" ||
          parsedGoalCommand.kind === "pause" ||
          parsedGoalCommand.kind === "resume" ||
          parsedGoalCommand.kind === "cancel" ||
          (parsedGoalCommand.kind === "create" && parsedGoalCommand.replace));
      const hasUnfinishedGoal = currentGoal !== null && currentGoal.status !== "complete";

      if (isGoalNextManage) {
        if (textOverride === undefined) setDraft("");
        setGoalQueueOpen(true);
        void refreshGoalQueue();
        return;
      }

      const slashDecision = classifySlashDispatch(text, slashCommands);
      if (
        slashDecision.kind === "local" &&
        (slashDecision.name === "usage" || slashDecision.name === "status")
      ) {
        if (textOverride === undefined) setDraft("");
        void showInfoPanel(slashDecision.name);
        return;
      }

      if (textOverride === undefined) setDraft("");
      if (
        isGoalNext &&
        goalNextObjective &&
        (busy || sendInFlightRef.current || hasUnfinishedGoal)
      ) {
        if (!isTauri()) {
          setCommandResult({
            command: "goal",
            content: "Upcoming Goal queues require a Kimi Code desktop session.",
            loading: false,
          });
          return;
        }
        void appendSessionGoalQueue(sessionId, goalNextObjective)
          .then((snapshot) => {
            setUpcomingGoals(snapshot.goals);
            if (!hasUnfinishedGoal) {
              suppressGoalQueuePromotionRef.current = false;
              setGoalQueuePromotionRequested(true);
            }
            toast.success("Upcoming Goal queued");
          })
          .catch((error) => {
            setDraft(text);
            toast.error("Failed to queue upcoming Goal", {
              description: error instanceof Error ? error.message : String(error),
            });
          });
        return;
      }
      if (busy && !isImmediateGoalCommand) {
        setQueue((current) => [...current, { id: crypto.randomUUID(), text, attachments }]);
        return;
      }
      // Sync guard: `busy` lags one render behind the first sendMessage call.
      if (sendInFlightRef.current && !isImmediateGoalCommand) return;
      if (!isImmediateGoalCommand) sendInFlightRef.current = true;
      const isGoalCancel = parsedGoalCommand?.kind === "cancel";
      if (isGoalCancel) {
        suppressGoalQueuePromotionRef.current = true;
        setGoalQueuePromotionRequested(false);
      }
      void stream
        .sendMessage(text, attachments)
        .then((outcome) => {
          if (isGoalCancel && outcome?.kind === "info-panel" && outcome.error) {
            suppressGoalQueuePromotionRef.current = false;
          }
          handleSendOutcome(outcome, text, attachments);
        })
        .catch((error) => {
          if (isGoalCancel) suppressGoalQueuePromotionRef.current = false;
          if (textOverride === undefined) setDraft(text);
          toast.error("Failed to send message", {
            description: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (!isImmediateGoalCommand) sendInFlightRef.current = false;
        });
    },
    [
      busy,
      currentGoal,
      draft,
      handleSendOutcome,
      refreshGoalQueue,
      sessionId,
      setDraft,
      setQueue,
      showInfoPanel,
      slashCommands,
      stream,
    ],
  );

  // Dedupe queue flushes: React StrictMode re-runs effects with the same
  // closed-over queue, which would otherwise prompt twice.
  const flushedQueueIdsRef = useRef(new Set<string>());
  useEffect(() => {
    void sessionId;
    flushedQueueIdsRef.current.clear();
  }, [sessionId]);

  useEffect(() => {
    if (
      stream.status !== "ready" ||
      queue.length === 0 ||
      pendingGoalStart !== null ||
      goalStartPending
    ) {
      return;
    }
    const next = queue.find((item) => !flushedQueueIdsRef.current.has(item.id));
    if (!next) return;

    flushedQueueIdsRef.current.add(next.id);
    setQueue((current) => current.filter((item) => item.id !== next.id));
    const attachments = next.attachments ?? [];
    void stream
      .sendMessage(next.text, attachments)
      .then((outcome) => handleSendOutcome(outcome, next.text, attachments));
  }, [
    goalStartPending,
    handleSendOutcome,
    pendingGoalStart,
    queue,
    setQueue,
    stream.sendMessage,
    stream.status,
  ]);

  useEffect(() => {
    if (
      !isTauri() ||
      !goalQueuePromotionRequested ||
      stream.status !== "ready" ||
      stream.isReplayingHistory ||
      currentGoal !== null ||
      queue.length > 0 ||
      upcomingGoals.length === 0 ||
      pendingGoalStart !== null ||
      goalStartPending ||
      sendInFlightRef.current ||
      goalQueuePromotionInFlightRef.current ||
      suppressGoalQueuePromotionRef.current
    ) {
      return;
    }

    const queuedGoal = upcomingGoals[0];
    goalQueuePromotionInFlightRef.current = true;
    setGoalQueuePromotionRequested(false);
    const command = `/goal -- ${queuedGoal.objective}`;
    void stream
      .sendMessage(command, [], { upcomingGoalId: queuedGoal.id })
      .then((outcome) => {
        if (outcome?.kind === "info-panel") {
          throw new Error(outcome.content);
        }
        handleSendOutcome(outcome, command, [], queuedGoal);
      })
      .catch((error) => {
        suppressGoalQueuePromotionRef.current = true;
        toast.error("Failed to start upcoming Goal", {
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        goalQueuePromotionInFlightRef.current = false;
      });
  }, [
    currentGoal,
    goalQueuePromotionRequested,
    goalStartPending,
    handleSendOutcome,
    pendingGoalStart,
    queue.length,
    stream.isReplayingHistory,
    stream.sendMessage,
    stream.status,
    upcomingGoals,
  ]);
  // Keyed by session+text so StrictMode's effect re-run cannot wipe a boolean
  // guard (the old sessionId effect reset sentPendingRef to false mid-cycle).
  const sentPendingKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const text = pendingFirstMessage?.trim() ?? "";
    const attachments = pendingFirstAttachments ?? [];
    if (!text && attachments.length === 0) return;
    const sendKey = `${sessionId}\0${text}\0${attachments
      .map((attachment) => attachment.filename)
      .join("\0")}`;
    if (sentPendingKeyRef.current === sendKey) return;
    sentPendingKeyRef.current = sendKey;
    // Clear parent pending immediately so a remount/re-run cannot retry.
    onPendingFirstMessageSent?.();
    void stream
      .sendMessage(
        text,
        attachments,
        pendingFirstModes ? { initialModes: pendingFirstModes } : undefined,
      )
      .then((outcome) => handleSendOutcome(outcome, text, attachments));
  }, [
    handleSendOutcome,
    onPendingFirstMessageSent,
    pendingFirstMessage,
    pendingFirstAttachments,
    pendingFirstModes,
    sessionId,
    stream.sendMessage,
  ]);

  const confirmGoalStart = useCallback(
    (mode: "manual" | "auto" | "yolo") => {
      if (!pendingGoalStart || goalStartPending) return;
      const pending = pendingGoalStart;
      const previousPermissionMode = pending.request.permissionMode;
      setGoalStartPending(true);
      void (async () => {
        // ACP has no native Goal replacement RPC. When the old Goal still owns
        // a turn, reuse its pause/cancel path first; the confirmed prompt then
        // calls Kimi's native CreateGoal with replace=true.
        if (pending.request.replace && busy) {
          const pauseOutcome = await stream.controlGoal("pause");
          if (pauseOutcome?.error) throw new Error(pauseOutcome.content);
        }
        if (mode !== stream.permissionMode) {
          stream.sendSetPermissionMode(mode);
        }
        return stream.sendMessage(pending.text, pending.attachments, {
          goalStartConfirmed: true,
          ...(pending.promotedGoal ? { upcomingGoalId: pending.promotedGoal.id } : {}),
        });
      })()
        .then((outcome) => {
          setPendingGoalStart(null);
          handleSendOutcome(outcome, pending.text, pending.attachments);
        })
        .catch(async (error) => {
          setPendingGoalStart(null);
          if (mode !== previousPermissionMode) {
            stream.sendSetPermissionMode(previousPermissionMode);
          }
          if (pending.request.goalSwitchArmed) {
            stream.sendSetGoalMode(true);
          }
          if (pending.promotedGoal) {
            suppressGoalQueuePromotionRef.current = true;
            await refreshGoalQueue();
          } else {
            setDraft(pending.text);
          }
          toast.error("Failed to start Goal", {
            description: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => setGoalStartPending(false));
    },
    [
      busy,
      goalStartPending,
      handleSendOutcome,
      pendingGoalStart,
      refreshGoalQueue,
      setDraft,
      stream,
    ],
  );
  const cancelGoalStart = useCallback(() => {
    if (!pendingGoalStart || goalStartPending) return;
    if (pendingGoalStart.request.goalSwitchArmed) {
      stream.sendSetGoalMode(false);
    }
    if (pendingGoalStart.promotedGoal) {
      suppressGoalQueuePromotionRef.current = true;
      setGoalQueuePromotionRequested(false);
    } else {
      setDraft(pendingGoalStart.text);
    }
    setPendingGoalStart(null);
  }, [goalStartPending, pendingGoalStart, setDraft, stream]);

  const mutateGoalQueue = useCallback(
    (goalId: string, mutation: () => Promise<{ goals: UpcomingGoal[] }>) => {
      if (goalQueueMutationInFlightRef.current) return;
      goalQueueMutationInFlightRef.current = true;
      setGoalQueuePendingId(goalId);
      void mutation()
        .then((snapshot) => setUpcomingGoals(snapshot.goals))
        .catch((error) => {
          toast.error("Failed to update upcoming Goals", {
            description: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          goalQueueMutationInFlightRef.current = false;
          setGoalQueuePendingId(undefined);
        });
    },
    [],
  );

  const streamDead = stream.status === "error";
  const connectingSession =
    !streamDead &&
    ((stream.isReplayingHistory && stream.status !== "ready") ||
      (!stream.isConnected && stream.status === "submitted"));

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <MessageList
        messages={messages}
        isAwaitingFirstResponse={stream.isAwaitingFirstResponse && !streamDead}
        onRespondApproval={(id, decision) => {
          void stream.respondToApproval(id, decision);
        }}
        onRespondQuestion={(id, answers) => {
          void stream.respondToQuestion(id, answers);
        }}
      />
      <div className="min-w-0 shrink-0 px-4 pb-4 sm:px-6">
        <div className="mx-auto w-full min-w-0 max-w-[44rem]">
          {connectingSession && (
            <output className="mb-2 flex items-center gap-2 rounded-r2 border border-line bg-elevated px-3 py-2 font-mono text-[11px] text-muted">
              <span className="size-3 shrink-0 animate-spin rounded-full border border-muted border-t-transparent" />
              {stream.isReplayingHistory ? "正在加载会话历史…" : "正在连接会话…"}
            </output>
          )}
          {streamDead && (
            <div
              role="alert"
              className="mb-2 flex items-center gap-3 rounded-r2 border border-danger/40 bg-danger/10 px-3 py-2"
            >
              <p className="min-w-0 flex-1 text-[12px] text-danger">
                {stream.error?.message || "连接已断开，对话已中断"}
                {(stream.error?.message || "")
                  .toLowerCase()
                  .match(/timeout|timed out|auth|credential|vpn|network/)
                  ? "（高延迟/VPN/凭据异常时请检查网络后重试）"
                  : ""}
              </p>
              <button
                type="button"
                onClick={() => stream.reconnect()}
                className="shrink-0 rounded-r1 border border-danger/40 bg-elevated px-2.5 py-1 text-[11px] font-medium text-danger transition-colors hover:bg-hover"
              >
                重新连接
              </button>
            </div>
          )}
          {commandResult && (
            <CommandResultPanel result={commandResult} onClose={() => setCommandResult(null)} />
          )}
          {workDir?.trim() ? (
            <div className="mb-2 flex justify-start">
              <WorkDirPicker workDir={workDir.trim()} readOnly />
            </div>
          ) : null}
          <GoalQueueManager
            open={goalQueueOpen}
            goals={upcomingGoals}
            pendingGoalId={goalQueuePendingId}
            onOpenChange={(open) => {
              setGoalQueueOpen(open);
              if (open) void refreshGoalQueue();
            }}
            onMove={(goalId, direction) =>
              mutateGoalQueue(goalId, () => moveSessionGoalQueue(sessionId, goalId, direction))
            }
            onDelete={(goalId) =>
              mutateGoalQueue(goalId, () => removeSessionGoalQueue(sessionId, goalId))
            }
            onEdit={(goalId, objective) =>
              mutateGoalQueue(goalId, () => updateSessionGoalQueue(sessionId, goalId, objective))
            }
          />
          {pendingGoalStart && (
            <GoalStartConfirmation
              objective={pendingGoalStart.request.objective}
              permissionMode={pendingGoalStart.request.permissionMode}
              replace={pendingGoalStart.request.replace}
              pending={goalStartPending}
              onConfirm={confirmGoalStart}
              onCancel={cancelGoalStart}
            />
          )}
          <Composer
            sessionId={sessionId}
            draft={draft}
            onDraftChange={setDraft}
            onSend={send}
            onCancel={stream.cancel}
            busy={busy}
            canCancel={stream.canCancel}
            sendDisabled={streamDead || pendingGoalStart !== null || goalStartPending}
            planMode={stream.planMode}
            slashCommands={slashCommands}
            queue={queue}
            onRemoveQueued={(id) => setQueue((current) => current.filter((item) => item.id !== id))}
            onClearQueue={() => setQueue([])}
            onUploadFile={(file) => onUploadFile(sessionId, file)}
            onOpenContext={() => onOpenWorkspace("files")}
            listDirectory={listDirectory}
            models={models}
            selectedModel={selectedModel || "默认模型"}
            thinkingEnabled={Boolean(config?.defaultThinking)}
            thinkingEffort={config?.thinkingEffort ?? ""}
            modelControlsDisabled={!config}
            modelUpdating={isUpdating}
            onSelectModel={(name) => void handleSelectModel(name)}
            onToggleThinking={(enabled) => void handleToggleThinking(enabled)}
            onSelectThinkingEffort={(effort) => void handleSelectThinkingEffort(effort)}
            onManageConfig={onManageConfig}
          />
          <StatusStrip
            permissionMode={permissionMode}
            onPermissionModeChange={stream.sendSetPermissionMode}
            planMode={stream.planMode}
            swarmMode={stream.swarmMode}
            goalMode={stream.goalMode}
            currentGoal={currentGoal}
            onPlanModeChange={stream.sendSetPlanMode}
            onSwarmModeChange={stream.sendSetSwarmMode}
            onGoalModeChange={stream.sendSetGoalMode}
            onGoalControl={async (action) => {
              if (onGoalControl) {
                await onGoalControl(action);
                return;
              }
              const outcome = await stream.controlGoal(action);
              if (outcome?.error) toast.error(outcome.content);
            }}
            modeControlsDisabled={
              stream.status !== "ready" || pendingGoalStart !== null || goalStartPending
            }
            contextUsage={stream.contextUsage}
            tokenUsage={stream.tokenUsage}
            contextTokens={stream.contextTokens}
            maxContextTokens={stream.maxContextTokens}
          />
        </div>
      </div>
    </div>
  );
}
