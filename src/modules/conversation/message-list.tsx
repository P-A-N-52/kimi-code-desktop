import { GitFork } from "lucide-react";
import { useEffect, useRef } from "react";
import type { LiveMessage } from "@/hooks/types";
import type { ApprovalResponseDecision } from "@/hooks/wireTypes";
import { AiMessage } from "./ai-message";
import { ApprovalCard } from "./approval-card";
import { CodeBlock } from "./code-block";
import { QuestionCard } from "./question-card";
import { StatusMessage } from "./status-message";
import { StreamingCaret } from "./streaming-caret";
import { ThinkingBlock } from "./thinking-block";
import { ToolCard } from "./tool-card";
import { UserMessage } from "./user-message";

function MessageView({
  message,
  onRespondApproval,
  onRespondQuestion,
  onForkSession,
}: {
  message: LiveMessage;
  onRespondApproval: (requestId: string, decision: ApprovalResponseDecision) => void;
  onRespondQuestion: (requestId: string, answers: Record<string, string>) => void;
  onForkSession?: (turnIndex: number) => void;
}) {
  if (message.role === "user") {
    const forkTurn =
      message.variant !== "steer" && message.turnIndex !== undefined && onForkSession
        ? () => onForkSession(message.turnIndex as number)
        : undefined;
    return (
      <div className="group/fork relative">
        <UserMessage
          attachments={message.attachments}
          label={message.variant === "steer" ? "补充指令" : undefined}
        >
          {message.content}
        </UserMessage>
        {forkTurn ? (
          <button
            type="button"
            aria-label="从此轮分叉会话"
            title="从此轮分叉会话"
            onClick={forkTurn}
            className="absolute right-0 top-1 flex size-6 items-center justify-center rounded-r1 text-faint opacity-0 transition-opacity hover:bg-hover hover:text-foreground focus-visible:opacity-100 group-hover/fork:opacity-100"
          >
            <GitFork size={12} strokeWidth={1.5} />
          </button>
        ) : null}
      </div>
    );
  }

  switch (message.variant) {
    case "message-id":
      return null;
    case "status":
      return message.content ? (
        <StatusMessage streaming={message.isStreaming}>{message.content}</StatusMessage>
      ) : null;
    case "tool": {
      const tc = message.toolCall;
      if (!tc) return null;
      if (tc.state === "approval-requested" && tc.approval) {
        return (
          <ApprovalCard approval={tc.approval} display={tc.display} onRespond={onRespondApproval} />
        );
      }
      if (tc.state === "question-requested" && tc.question) {
        return <QuestionCard question={tc.question} onRespond={onRespondQuestion} />;
      }
      return <ToolCard toolCall={tc} defaultOpen={tc.title.toLowerCase().includes("edit")} />;
    }
    case "thinking":
      return message.thinking ? (
        <ThinkingBlock
          thinking={message.thinking}
          duration={message.thinkingDuration}
          streaming={Boolean(message.isStreaming)}
        />
      ) : null;
    case "code":
      return message.codeSnippet ? (
        <CodeBlock code={message.codeSnippet.code} language={message.codeSnippet.language} />
      ) : null;
    default:
      return (
        <AiMessage content={message.content ?? ""} attachments={message.attachments}>
          {message.isStreaming && <StreamingCaret />}
        </AiMessage>
      );
  }
}

export function MessageList({
  messages,
  isAwaitingFirstResponse = false,
  errorMessage,
  onRespondApproval,
  onRespondQuestion,
  onForkSession,
}: {
  messages: LiveMessage[];
  isAwaitingFirstResponse?: boolean;
  errorMessage?: string;
  onRespondApproval: (requestId: string, decision: ApprovalResponseDecision) => void;
  onRespondQuestion: (requestId: string, answers: Record<string, string>) => void;
  onForkSession?: (turnIndex: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && followRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
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
            onForkSession={onForkSession}
          />
        ))}
        {errorMessage ? (
          <StatusMessage tone="error">{`错误报告：${errorMessage}`}</StatusMessage>
        ) : isAwaitingFirstResponse ? (
          <StatusMessage streaming>等待模型响应…</StatusMessage>
        ) : null}
      </div>
    </div>
  );
}
