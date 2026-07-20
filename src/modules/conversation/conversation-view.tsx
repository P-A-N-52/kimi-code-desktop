import { useCallback, useEffect, useState } from "react";
import { useGlobalConfig } from "@/hooks/useGlobalConfig";
import type { UseSessionStreamReturn } from "@/hooks/useSessionStream";
import type { UploadSessionFileResponse } from "@/lib/api/models";
import { Composer, type QueuedPrompt } from "@/modules/composer/composer";
import { shouldAutoApprove } from "@/modules/statusbar/permission-mode";
import { StatusStrip } from "@/modules/statusbar/status-strip";
import type { WorkspaceTab } from "@/modules/workspace/changes-panel";
import { MessageList } from "./message-list";

export function ConversationView({
  sessionId,
  stream,
  onOpenWorkspace,
  onUploadFile,
  onOpenSettings,
}: {
  sessionId: string;
  stream: UseSessionStreamReturn;
  onOpenWorkspace: (tab?: WorkspaceTab) => void;
  onUploadFile: (sessionId: string, file: File) => Promise<UploadSessionFileResponse>;
  onOpenSettings: () => void;
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

  const [draft, setDraft] = useState("");
  const [queue, setQueue] = useState<QueuedPrompt[]>([]);
  const { config } = useGlobalConfig();
  const busy = stream.status === "submitted" || stream.status === "streaming";

  const send = useCallback(
    (textOverride?: string) => {
      const text = (textOverride ?? draft).trim();
      if (!text) return;
      if (textOverride === undefined) setDraft("");
      if (busy) {
        setQueue((current) => [...current, { id: crypto.randomUUID(), text }]);
        return;
      }
      void stream.sendMessage(text);
    },
    [busy, draft, stream],
  );

  useEffect(() => {
    if (stream.status !== "ready" || queue.length === 0) return;
    const next = queue[0];
    setQueue((current) => current.filter((item) => item.id !== next.id));
    void stream.sendMessage(next.text);
  }, [queue, stream]);

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
          <Composer
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
            modelLabel={config?.defaultModel || "默认模型"}
            onOpenModelSettings={onOpenSettings}
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
          />
        </div>
      </div>
    </div>
  );
}
