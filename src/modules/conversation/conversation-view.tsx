import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useGlobalConfig } from "@/hooks/useGlobalConfig";
import type { SessionFileEntry } from "@/hooks/useSessions";
import type { UseSessionStreamReturn } from "@/hooks/useSessionStream";
import type { UploadSessionFileResponse } from "@/lib/api/models";
import { notifyGlobalConfigApplied } from "@/lib/config-update-toast";
import {
  findConfigModel,
  modelForcesThinking,
  modelHasThinkingCapability,
} from "@/lib/model-capabilities";
import { classifySlashDispatch } from "@/lib/slash-command-catalog";
import {
  CommandResultPanel,
  type CommandResultPanelState,
} from "@/modules/composer/command-result-panel";
import { Composer, type QueuedPrompt } from "@/modules/composer/composer";
import { WorkDirPicker } from "@/modules/sessions/work-dir-picker";
import {
  shouldAutoApprove,
  type SessionModeDraft,
} from "@/modules/statusbar/permission-mode";
import { StatusStrip } from "@/modules/statusbar/status-strip";
import type { WorkspaceTab } from "@/modules/workspace/changes-panel";
import { MessageList } from "./message-list";

type SessionComposerState = { draft: string; queue: QueuedPrompt[] };
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
  pendingFirstModes,
  onPendingFirstMessageSent,
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
  pendingFirstModes?: SessionModeDraft | null;
  onPendingFirstMessageSent?: () => void;
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
  const { config, update, isUpdating } = useGlobalConfig();
  const busy = stream.status === "submitted" || stream.status === "streaming";

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
        notifyGlobalConfigApplied(
          resp,
          enabled ? "思考模式已开启" : "思考模式已关闭",
        );
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

  const sendInFlightRef = useRef(false);
  const send = useCallback(
    (textOverride?: string) => {
      const text = (textOverride ?? draft).trim();
      if (!text) return;
      if (stream.status === "error") return;

      const slashDecision = classifySlashDispatch(text, stream.slashCommands);
      if (
        slashDecision.kind === "local" &&
        (slashDecision.name === "usage" || slashDecision.name === "status")
      ) {
        if (textOverride === undefined) setDraft("");
        void showInfoPanel(slashDecision.name);
        return;
      }

      if (textOverride === undefined) setDraft("");
      if (busy) {
        setQueue((current) => [...current, { id: crypto.randomUUID(), text }]);
        return;
      }
      // Sync guard: `busy` lags one render behind the first sendMessage call.
      if (sendInFlightRef.current) return;
      sendInFlightRef.current = true;
      void stream
        .sendMessage(text)
        .then((outcome) => {
          if (outcome?.kind === "info-panel") {
            setCommandResult({
              command: outcome.command,
              content: outcome.content,
              loading: false,
            });
          }
        })
        .finally(() => {
          sendInFlightRef.current = false;
        });
    },
    [busy, draft, setDraft, setQueue, showInfoPanel, stream],
  );

  // Dedupe queue flushes: React StrictMode re-runs effects with the same
  // closed-over queue, which would otherwise prompt twice.
  const flushedQueueIdsRef = useRef(new Set<string>());
  useEffect(() => {
    flushedQueueIdsRef.current.clear();
  }, [sessionId]);

  useEffect(() => {
    if (stream.status !== "ready" || queue.length === 0) return;
    const next = queue.find((item) => !flushedQueueIdsRef.current.has(item.id));
    if (!next) return;
    flushedQueueIdsRef.current.add(next.id);
    setQueue((current) => current.filter((item) => item.id !== next.id));
    void stream.sendMessage(next.text).then((outcome) => {
      if (outcome?.kind === "info-panel") {
        setCommandResult({
          command: outcome.command,
          content: outcome.content,
          loading: false,
        });
      }
    });
  }, [queue, setQueue, stream.sendMessage, stream.status]);

  // Keyed by session+text so StrictMode's effect re-run cannot wipe a boolean
  // guard (the old sessionId effect reset sentPendingRef to false mid-cycle).
  const sentPendingKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const text = pendingFirstMessage?.trim();
    if (!text) return;
    const sendKey = `${sessionId}\0${text}`;
    if (sentPendingKeyRef.current === sendKey) return;
    sentPendingKeyRef.current = sendKey;
    // Apply new-session draft modes before the first prompt so ACP / prompt
    // params see the same permission / plan / swarm choices from the start strip.
    if (pendingFirstModes) {
      stream.sendSetPermissionMode(pendingFirstModes.permissionMode);
      stream.sendSetPlanMode(pendingFirstModes.planMode);
      stream.sendSetSwarmMode(pendingFirstModes.swarmMode);
    }
    // Clear parent pending immediately so a remount/re-run cannot retry.
    onPendingFirstMessageSent?.();
    void stream.sendMessage(text).then((outcome) => {
      if (outcome?.kind === "info-panel") {
        setCommandResult({
          command: outcome.command,
          content: outcome.content,
          loading: false,
        });
      }
    });
  }, [
    onPendingFirstMessageSent,
    pendingFirstMessage,
    pendingFirstModes,
    sessionId,
    stream.sendMessage,
    stream.sendSetPermissionMode,
    stream.sendSetPlanMode,
    stream.sendSetSwarmMode,
  ]);

  const streamDead = stream.status === "error";

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
      <div className="shrink-0 px-6 pb-4">
        <div className="mx-auto max-w-[44rem]">
          {streamDead && (
            <div
              role="alert"
              className="mb-2 flex items-center gap-3 rounded-r2 border border-danger/40 bg-danger/10 px-3 py-2"
            >
              <p className="min-w-0 flex-1 text-[12px] text-danger">
                {stream.error?.message || "连接已断开，对话已中断"}
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
            <CommandResultPanel
              result={commandResult}
              onClose={() => setCommandResult(null)}
            />
          )}
          {workDir?.trim() ? (
            <div className="mb-2 flex justify-start">
              <WorkDirPicker workDir={workDir.trim()} readOnly />
            </div>
          ) : null}
          <Composer
            sessionId={sessionId}
            draft={draft}
            onDraftChange={setDraft}
            onSend={send}
            onCancel={stream.cancel}
            busy={busy}
            canCancel={stream.canCancel}
            sendDisabled={streamDead}
            planMode={stream.planMode}
            slashCommands={stream.slashCommands}
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
            onPlanModeChange={stream.sendSetPlanMode}
            onSwarmModeChange={stream.sendSetSwarmMode}
            modeControlsDisabled={stream.status !== "ready"}
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
