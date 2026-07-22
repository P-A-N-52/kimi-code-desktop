import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useGlobalConfig } from "@/hooks/useGlobalConfig";
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
import { shouldAutoApprove } from "@/modules/statusbar/permission-mode";
import { StatusStrip } from "@/modules/statusbar/status-strip";
import type { WorkspaceTab } from "@/modules/workspace/changes-panel";
import { MessageList } from "./message-list";

type SessionComposerState = { draft: string; queue: QueuedPrompt[] };
const composerStateBySession = new Map<string, SessionComposerState>();

export function ConversationView({
  sessionId,
  stream,
  onOpenWorkspace,
  onUploadFile,
  onManageConfig,
}: {
  sessionId: string;
  stream: UseSessionStreamReturn;
  onOpenWorkspace: (tab?: WorkspaceTab) => void;
  onUploadFile: (sessionId: string, file: File) => Promise<UploadSessionFileResponse>;
  onManageConfig?: () => void;
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

  const send = useCallback(
    (textOverride?: string) => {
      const text = (textOverride ?? draft).trim();
      if (!text) return;

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
      void stream.sendMessage(text).then((outcome) => {
        if (outcome?.kind === "info-panel") {
          setCommandResult({
            command: outcome.command,
            content: outcome.content,
            loading: false,
          });
        }
      });
    },
    [busy, draft, setDraft, setQueue, showInfoPanel, stream],
  );

  useEffect(() => {
    if (stream.status !== "ready" || queue.length === 0) return;
    const next = queue[0];
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
  }, [queue, setQueue, stream]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <MessageList
        messages={messages}
        isAwaitingFirstResponse={stream.isAwaitingFirstResponse}
        errorMessage={stream.error?.message}
        onRespondApproval={(id, decision) => {
          void stream.respondToApproval(id, decision);
        }}
        onRespondQuestion={(id, answers) => {
          void stream.respondToQuestion(id, answers);
        }}
      />
      <div className="shrink-0 px-6 pb-4">
        <div className="mx-auto max-w-[44rem]">
          {commandResult && (
            <CommandResultPanel
              result={commandResult}
              onClose={() => setCommandResult(null)}
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
            planMode={stream.planMode}
            slashCommands={stream.slashCommands}
            queue={queue}
            onRemoveQueued={(id) => setQueue((current) => current.filter((item) => item.id !== id))}
            onClearQueue={() => setQueue([])}
            onUploadFile={(file) => onUploadFile(sessionId, file)}
            onOpenContext={() => onOpenWorkspace("files")}
            models={models}
            selectedModel={selectedModel || "默认模型"}
            thinkingEnabled={Boolean(config?.defaultThinking)}
            modelControlsDisabled={!config}
            modelUpdating={isUpdating}
            onSelectModel={(name) => void handleSelectModel(name)}
            onToggleThinking={(enabled) => void handleToggleThinking(enabled)}
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
