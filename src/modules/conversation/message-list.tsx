import { useEffect, useRef } from "react";
import type { LiveMessage } from "@/hooks/types";
import type { ApprovalResponseDecision } from "@/hooks/wireTypes";
import { AiMessage } from "./ai-message";
import { ApprovalCard } from "./approval-card";
import { CodeBlock } from "./code-block";
import { QuestionCard } from "./question-card";
import { StreamingCaret } from "./streaming-caret";
import { ThinkingBlock } from "./thinking-block";
import { ToolCard } from "./tool-card";
import { UserMessage } from "./user-message";

function MessageView({
	message,
	onRespondApproval,
	onRespondQuestion,
}: {
	message: LiveMessage;
	onRespondApproval: (requestId: string, decision: ApprovalResponseDecision) => void;
	onRespondQuestion: (requestId: string, answers: Record<string, string>) => void;
}) {
	if (message.role === "user") {
		return <UserMessage>{message.content}</UserMessage>;
	}

	switch (message.variant) {
		case "tool": {
			const tc = message.toolCall;
			if (!tc) return null;
			if (tc.state === "approval-requested" && tc.approval) {
				return (
					<ApprovalCard
						approval={tc.approval}
						display={tc.display}
						onRespond={onRespondApproval}
					/>
				);
			}
			if (tc.state === "question-requested" && tc.question) {
				return <QuestionCard question={tc.question} onRespond={onRespondQuestion} />;
			}
			return <ToolCard toolCall={tc} defaultOpen={tc.title.toLowerCase().includes("edit")} />;
		}
		case "thinking":
			return message.thinking ? (
				<ThinkingBlock thinking={message.thinking} duration={message.thinkingDuration} />
			) : null;
		case "code":
			return message.codeSnippet ? (
				<CodeBlock code={message.codeSnippet.code} language={message.codeSnippet.language} />
			) : null;
		default:
			return (
				<AiMessage content={message.content ?? ""}>
					{message.isStreaming && <StreamingCaret />}
				</AiMessage>
			);
	}
}

export function MessageList({
	messages,
	onRespondApproval,
	onRespondQuestion,
}: {
	messages: LiveMessage[];
	onRespondApproval: (requestId: string, decision: ApprovalResponseDecision) => void;
	onRespondQuestion: (requestId: string, answers: Record<string, string>) => void;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const followRef = useRef(true);

	useEffect(() => {
		const el = scrollRef.current;
		if (el && followRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages]);

	return (
		<div
			ref={scrollRef}
			onScroll={(e) => {
				const el = e.currentTarget;
				followRef.current =
					el.scrollHeight - el.scrollTop - el.clientHeight < 200;
			}}
			className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-2"
		>
			<div className="mx-auto max-w-[44rem]">
				{messages.map((m) => (
					<MessageView
						key={m.id}
						message={m}
						onRespondApproval={onRespondApproval}
						onRespondQuestion={onRespondQuestion}
					/>
				))}
			</div>
		</div>
	);
}
