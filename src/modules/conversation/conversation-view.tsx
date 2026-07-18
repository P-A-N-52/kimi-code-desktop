import { ArrowUp, Square } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useSessionStream } from "@/hooks/useSessionStream";
import type { LiveMessage } from "@/hooks/types";
import { getApiBaseUrl } from "@/hooks/utils";
import type { Session, SessionStatus } from "@/lib/api/models";
import { cn } from "@/lib/utils";
import { MessageList } from "./message-list";

export function ConversationView({
	sessionId,
	currentSession,
	onSessionStatus,
	onMessagesChange,
}: {
	sessionId: string;
	currentSession: Session | undefined;
	onSessionStatus: (status: SessionStatus) => void;
	onMessagesChange?: (messages: LiveMessage[]) => void;
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
				messages={stream.messages}
				onRespondApproval={(id, decision) => {
					void stream.respondToApproval(id, decision);
				}}
				onRespondQuestion={(id, answers) => {
					void stream.respondToQuestion(id, answers);
				}}
			/>
			<div className="shrink-0 px-6 pb-4">
				<div className="mx-auto max-w-[44rem]">
					<div className="rounded-r3 border border-line-strong bg-elevated px-3 pb-2 pt-3 shadow-pop transition-colors focus-within:border-line-strong">
						<textarea
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									send();
								}
							}}
							rows={2}
							placeholder="给 Kimi 布置任务… (@ 引用文件 · / 命令)"
							className="max-h-40 w-full resize-none bg-transparent px-1 text-[14px] leading-[1.55] text-foreground outline-none placeholder:text-faint"
						/>
						<div className="mt-1.5 flex items-center justify-end gap-2">
							<span className="mr-auto font-mono text-[10.5px] text-faint">
								Enter 发送 · Shift+Enter 换行
							</span>
							<button
								type="button"
								aria-label={busy ? "停止" : "发送"}
								onClick={busy ? stream.cancel : send}
								className={cn(
									"flex size-7 items-center justify-center rounded-full transition-colors",
									busy
										? "border border-line-strong text-muted hover:text-foreground"
										: "bg-bright text-background hover:opacity-85",
								)}
							>
								{busy ? (
									<Square size={11} strokeWidth={1.5} />
								) : (
									<ArrowUp size={13} strokeWidth={2} />
								)}
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
