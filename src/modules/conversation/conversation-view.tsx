import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useSessionStream } from "@/hooks/useSessionStream";
import type { LiveMessage } from "@/hooks/types";
import { getApiBaseUrl } from "@/hooks/utils";
import type { Session, SessionStatus } from "@/lib/api/models";
import { Composer } from "@/modules/composer/composer";
import { StatusStrip } from "@/modules/statusbar/status-strip";
import { shouldAutoApprove, usePermissionMode } from "@/modules/statusbar/permission-mode";
import { MessageList } from "./message-list";

export type ConversationStreamApi = Pick<
	ReturnType<typeof useSessionStream>,
	"respondToApproval"
>;

export function ConversationView({
	sessionId,
	currentSession,
	onSessionStatus,
	onMessagesChange,
	onStreamApiChange,
}: {
	sessionId: string;
	currentSession: Session | undefined;
	onSessionStatus: (status: SessionStatus) => void;
	onMessagesChange?: (messages: LiveMessage[]) => void;
	onStreamApiChange?: (api: ConversationStreamApi | null) => void;
}) {
	const handleError = useCallback((error: Error) => {
		toast.error("Stream Error", { description: error.message });
	}, []);

	const stream = useSessionStream({
		sessionId,
		baseUrl: getApiBaseUrl(),
		onError: handleError,
		onSessionStatus,
		onMessagesChange,
		autoConnect: Boolean(currentSession?.isRunning),
	});

	const { messages, respondToApproval } = stream;
	const { mode: permissionMode, setMode: setPermissionMode } =
		usePermissionMode(sessionId);

	useEffect(() => {
		onStreamApiChange?.({ respondToApproval });
	}, [respondToApproval, onStreamApiChange]);

	useEffect(() => {
		if (permissionMode === "ask") return;
		for (const m of messages) {
			const tc = m.toolCall;
			if (
				tc?.state === "approval-requested" &&
				tc.approval &&
				!tc.approval.submitted &&
				!tc.approval.resolved &&
				shouldAutoApprove(permissionMode, tc.title)
			) {
				void respondToApproval(tc.approval.id, "approve");
			}
		}
	}, [messages, permissionMode, respondToApproval]);

	const [draft, setDraft] = useState("");
	const busy = stream.status !== "ready";

	const send = useCallback(() => {
		const text = draft.trim();
		if (!text || busy) return;
		setDraft("");
		void stream.sendMessage(text);
	}, [draft, busy, stream]);

	return (
		<div className="flex min-w-0 flex-1 flex-col">
			<MessageList
				messages={messages}
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
						planMode={stream.planMode}
					/>
					<StatusStrip
						sessionId={sessionId}
						permissionMode={permissionMode}
						onPermissionModeChange={setPermissionMode}
						planMode={stream.planMode}
						swarmMode={stream.swarmMode}
						onPlanModeChange={stream.sendSetPlanMode}
						onSwarmModeChange={stream.sendSetSwarmMode}
						contextUsage={stream.contextUsage}
						tokenUsage={stream.tokenUsage}
					/>
				</div>
			</div>
		</div>
	);
}
