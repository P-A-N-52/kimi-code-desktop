import { GitFork } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LiveMessage } from "@/hooks/types";
import type { ApprovalResponseDecision } from "@/hooks/wireTypes";
import type { ConnectionPhase } from "@/lib/session-stream/types";
import { getToolPresentation } from "@/lib/tool-events/tool-registry";
import { isAskUserToolCall, parseAskUserToolOutput } from "@/modules/statusbar/permission-mode";
import { AiMessage } from "./ai-message";
import { ApprovalCard } from "./approval-card";
import { CodeBlock } from "./code-block";
import { QuestionCard } from "./question-card";
import { StatusMessage } from "./status-message";
import { StreamingCaret } from "./streaming-caret";
import { ThinkingBlock } from "./thinking-block";
import { ToolCard } from "./tool-card";
import { UserMessage } from "./user-message";

const MessageView = memo(function MessageView({
  message,
  onRespondApproval,
  onRespondQuestion,
  onForkSession,
  showApprovalShortcuts,
}: {
  message: LiveMessage;
  onRespondApproval: (requestId: string, decision: ApprovalResponseDecision) => void;
  onRespondQuestion: (requestId: string, answers: Record<string, string>) => void;
  onForkSession?: (turnIndex: number) => void;
  showApprovalShortcuts: boolean;
}) {
  if (message.role === "user") {
    const forkTurn =
      message.variant !== "steer" && message.turnIndex !== undefined && onForkSession
        ? () => onForkSession(message.turnIndex as number)
        : undefined;
    return (
      <div className="group/fork relative min-w-0">
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
          <ApprovalCard
            approval={tc.approval}
            display={tc.display}
            onRespond={onRespondApproval}
            showShortcuts={showApprovalShortcuts}
          />
        );
      }
      if ((tc.state === "question-requested" || tc.state === "question-responded") && tc.question) {
        return <QuestionCard question={tc.question} onRespond={onRespondQuestion} />;
      }
      // Ask User permission uses a different toolCallId (`…:question:N`) than
      // the streamed tool card. Hide the bare pending Ask User tool row so it
      // cannot render as Agent/Generic while the QuestionCard owns the interaction.
      if (
        isAskUserToolCall(tc) &&
        (tc.state === "input-streaming" || tc.state === "input-available")
      ) {
        return null;
      }
      // After ToolResult, Ask User falls to output-available with JSON output.
      // Keep QuestionCard UX instead of a raw Generic tool dump.
      if (isAskUserToolCall(tc)) {
        const parsed = parseAskUserToolOutput(
          typeof tc.output === "string" ? tc.output : undefined,
        );
        const answers = tc.question?.answers ?? parsed.answers;
        const question = tc.question
          ? {
              ...tc.question,
              submitted: true,
              resolved: true,
              answers,
            }
          : {
              id: tc.toolCallId ?? "ask-user",
              toolCallId: tc.toolCallId ?? "",
              questions: [],
              submitted: true,
              resolved: true,
              answers,
            };
        return (
          <QuestionCard
            question={question}
            onRespond={onRespondQuestion}
            dismissed={parsed.dismissed || Object.keys(answers).length === 0}
          />
        );
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
});

function isTodoToolMessage(message: LiveMessage): boolean {
  return (
    message.variant === "tool" &&
    message.toolCall != null &&
    getToolPresentation(message.toolCall.title).canonicalName === "SetTodoList"
  );
}

function isPendingInteraction(message: LiveMessage): boolean {
  const toolCall = message.toolCall;
  if (!toolCall) return false;
  if (toolCall.state === "approval-requested") {
    return Boolean(
      toolCall.approval && !toolCall.approval.submitted && !toolCall.approval.resolved,
    );
  }
  if (toolCall.state === "question-requested") {
    return Boolean(
      toolCall.question && !toolCall.question.submitted && !toolCall.question.resolved,
    );
  }
  return false;
}

const INITIAL_VISIBLE_MESSAGES = 120;
const HISTORY_PAGE_SIZE = 100;
const SLOW_RESPONSE_THRESHOLD_MS = 45_000;

export function MessageList({
  sessionId,
  messages,
  isAwaitingFirstResponse = false,
  connectionPhase = "connected",
  errorMessage,
  onRespondApproval,
  onRespondQuestion,
  onForkSession,
}: {
  sessionId?: string;
  messages: LiveMessage[];
  isAwaitingFirstResponse?: boolean;
  connectionPhase?: ConnectionPhase;
  errorMessage?: string;
  onRespondApproval: (requestId: string, decision: ApprovalResponseDecision) => void;
  onRespondQuestion: (requestId: string, answers: Record<string, string>) => void;
  onForkSession?: (turnIndex: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const prependScrollHeightRef = useRef<number | null>(null);
  const lastRenderedContentKeyRef = useRef<string | null>(null);
  const callbacksRef = useRef({ onRespondApproval, onRespondQuestion, onForkSession });
  callbacksRef.current = { onRespondApproval, onRespondQuestion, onForkSession };
  const stableRespondApproval = useCallback(
    (requestId: string, decision: ApprovalResponseDecision) =>
      callbacksRef.current.onRespondApproval(requestId, decision),
    [],
  );
  const stableRespondQuestion = useCallback(
    (requestId: string, answers: Record<string, string>) =>
      callbacksRef.current.onRespondQuestion(requestId, answers),
    [],
  );
  const stableForkSession = useCallback(
    (turnIndex: number) => callbacksRef.current.onForkSession?.(turnIndex),
    [],
  );
  const [historyWindow, setHistoryWindow] = useState({
    sessionId,
    limit: INITIAL_VISIBLE_MESSAGES,
  });
  const responseWaitKey = sessionId ?? "";
  const [slowResponseFor, setSlowResponseFor] = useState<string | null>(null);
  useEffect(() => {
    if (!isAwaitingFirstResponse || connectionPhase !== "connected") {
      setSlowResponseFor(null);
      return;
    }

    setSlowResponseFor(null);
    const timeout = window.setTimeout(() => {
      setSlowResponseFor(responseWaitKey);
    }, SLOW_RESPONSE_THRESHOLD_MS);
    return () => window.clearTimeout(timeout);
  }, [connectionPhase, isAwaitingFirstResponse, responseWaitKey]);
  const responseIsSlow = slowResponseFor === responseWaitKey;
  const visibleLimit =
    historyWindow.sessionId === sessionId ? historyWindow.limit : INITIAL_VISIBLE_MESSAGES;
  const pendingApprovals = useMemo(
    () =>
      messages.flatMap((message) => {
        const approval = message.toolCall?.approval;
        return message.toolCall?.state === "approval-requested" &&
          approval &&
          !approval.submitted &&
          !approval.resolved
          ? [approval]
          : [];
      }),
    [messages],
  );

  // Every SetTodoList call carries the full list, so only the newest card enters
  // the render window; older snapshots otherwise spam the timeline (issue #13).
  const timelineMessages = useMemo(() => {
    let lastTodoIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (isTodoToolMessage(message)) {
        lastTodoIndex = index;
        break;
      }
    }
    return messages.filter(
      (message, index) => !isTodoToolMessage(message) || index === lastTodoIndex,
    );
  }, [messages]);

  const { hiddenMessageCount, visibleMessages } = useMemo(() => {
    const tailStart = Math.max(0, timelineMessages.length - visibleLimit);
    const pinnedInteractions = timelineMessages.slice(0, tailStart).filter(isPendingInteraction);
    return {
      hiddenMessageCount: tailStart - pinnedInteractions.length,
      visibleMessages: [...pinnedInteractions, ...timelineMessages.slice(tailStart)],
    };
  }, [timelineMessages, visibleLimit]);
  const streamingMessage = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].isStreaming) return messages[index];
    }
    return undefined;
  }, [messages]);
  const streamingMessageId = streamingMessage?.id;
  const streamingContentLength = streamingMessage?.content?.length ?? 0;
  const visibleMessageCount = visibleMessages.length;

  useEffect(() => {
    if (historyWindow.sessionId === sessionId) return;
    prependScrollHeightRef.current = null;
    lastRenderedContentKeyRef.current = null;
    followRef.current = true;
    setHistoryWindow({ sessionId, limit: INITIAL_VISIBLE_MESSAGES });
  }, [historyWindow.sessionId, sessionId]);

  useEffect(() => {
    if (pendingApprovals.length !== 1) return;
    const approval = pendingApprovals[0];
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.isContentEditable ||
        target?.matches("input, textarea, select, button, a, [role='button']")
      ) {
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        stableRespondApproval(approval.id, "approve");
      } else if (event.key === "Escape") {
        event.preventDefault();
        stableRespondApproval(approval.id, "reject");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingApprovals, stableRespondApproval]);

  useLayoutEffect(() => {
    const previousHeight = prependScrollHeightRef.current;
    const el = scrollRef.current;
    if (previousHeight === null || !el) return;
    el.scrollTop += el.scrollHeight - previousHeight;
    prependScrollHeightRef.current = null;
  });

  useEffect(() => {
    const renderedContentKey = `${streamingMessageId ?? ""}:${streamingContentLength}:${visibleMessageCount}`;
    if (lastRenderedContentKeyRef.current === renderedContentKey) return;
    lastRenderedContentKeyRef.current = renderedContentKey;
    const el = scrollRef.current;
    if (el && followRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [streamingMessageId, streamingContentLength, visibleMessageCount]);

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
      }}
      className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-6 pt-2 sm:px-6"
    >
      <div className="mx-auto w-full min-w-0 max-w-[44rem]">
        {hiddenMessageCount > 0 && (
          <div className="mb-3 flex justify-center">
            <button
              type="button"
              onClick={() => {
                const el = scrollRef.current;
                if (el) {
                  prependScrollHeightRef.current = el.scrollHeight;
                  followRef.current = false;
                }
                setHistoryWindow((current) => ({
                  sessionId,
                  limit:
                    (current.sessionId === sessionId ? current.limit : INITIAL_VISIBLE_MESSAGES) +
                    HISTORY_PAGE_SIZE,
                }));
              }}
              className="rounded-r1 border border-line bg-elevated px-3 py-1.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-foreground"
            >
              {`加载更早消息（剩余 ${hiddenMessageCount} 条）`}
            </button>
          </div>
        )}
        {visibleMessages.map((m) => (
          <div key={m.id} className="[contain-intrinsic-size:auto_96px] [content-visibility:auto]">
            <MessageView
              message={m}
              onRespondApproval={stableRespondApproval}
              onRespondQuestion={stableRespondQuestion}
              onForkSession={onForkSession ? stableForkSession : undefined}
              showApprovalShortcuts={pendingApprovals.length === 1}
            />
          </div>
        ))}
        {errorMessage ? (
          <StatusMessage tone="error">{`错误报告：${errorMessage}`}</StatusMessage>
        ) : isAwaitingFirstResponse ? (
          <>
            <StatusMessage streaming>
              {connectionPhase === "connected" ? "Runtime 已连接，等待模型响应…" : "正在连接 Runtime…"}
            </StatusMessage>
            {responseIsSlow && connectionPhase === "connected" ? (
              <StatusMessage>响应时间较长</StatusMessage>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
