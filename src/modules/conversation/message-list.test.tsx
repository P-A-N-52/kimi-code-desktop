import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LiveMessage } from "@/hooks/types";
import { MessageList } from "./message-list";

const renderMessages = (messages: LiveMessage[]) =>
  render(
    <MessageList messages={messages} onRespondApproval={vi.fn()} onRespondQuestion={vi.fn()} />,
  );

describe("MessageList semantic rendering", () => {
  it("shows sending feedback until the first response replaces it", () => {
    const { rerender } = render(
      <MessageList
        messages={[{ id: "user", role: "user", content: "Hello" }]}
        isAwaitingFirstResponse
        onRespondApproval={vi.fn()}
        onRespondQuestion={vi.fn()}
      />,
    );
    expect(screen.getByText("等待模型响应…")).toBeTruthy();

    rerender(
      <MessageList
        messages={[
          { id: "user", role: "user", content: "Hello" },
          { id: "assistant", role: "assistant", content: "Hi" },
        ]}
        onRespondApproval={vi.fn()}
        onRespondQuestion={vi.fn()}
      />,
    );
    expect(screen.queryByText("等待模型响应…")).toBeNull();
    expect(screen.getByText("Hi")).toBeTruthy();
  });

  it("replaces sending feedback with a persistent error report", () => {
    render(
      <MessageList
        messages={[{ id: "user", role: "user", content: "Hello" }]}
        isAwaitingFirstResponse
        errorMessage="provider returned 404"
        onRespondApproval={vi.fn()}
        onRespondQuestion={vi.fn()}
      />,
    );

    expect(screen.queryByText("等待模型响应…")).toBeNull();
    expect(screen.getByText("错误报告：provider returned 404")).toBeTruthy();
  });

  it("streams thinking content openly with a caret", () => {
    renderMessages([
      {
        id: "think",
        role: "assistant",
        variant: "thinking",
        thinking: "Let me count",
        isStreaming: true,
      },
    ]);

    expect(screen.getByText("思考中…")).toBeTruthy();
    expect(screen.getByText("Let me count")).toBeTruthy();
    expect(screen.getByTestId("streaming-caret")).toBeTruthy();
  });

  it("keeps a live thinking tail when collapsed mid-stream", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    renderMessages([
      {
        id: "think",
        role: "assistant",
        variant: "thinking",
        thinking: "abcdefghijklmnop long thinking text for the tail preview",
        isStreaming: true,
      },
    ]);

    await user.click(screen.getByRole("button", { name: /思考中/ }));
    expect(screen.getByText(/long thinking text for the tail preview/)).toBeTruthy();
    expect(screen.getByTestId("streaming-caret")).toBeTruthy();
  });

  it("renders assistant image attachments", () => {
    renderMessages([
      {
        id: "image",
        role: "assistant",
        variant: "text",
        attachments: [
          {
            type: "file",
            mediaType: "image/png",
            filename: "result.png",
            url: "https://example.com/result.png",
          },
        ],
      },
    ]);

    expect(screen.getByRole("img", { name: "result.png" })).toBeTruthy();
  });

  it("renders no-preview user attachments", () => {
    renderMessages([
      {
        id: "file",
        role: "user",
        content: "Inspect this file",
        attachments: [{ kind: "nopreview", filename: "notes.txt" }],
      },
    ]);

    expect(screen.getByText("notes.txt")).toBeTruthy();
  });

  it("labels steering input as an in-turn instruction", () => {
    renderMessages([
      {
        id: "steer",
        role: "user",
        variant: "steer",
        content: "Also add tests",
      },
    ]);

    expect(screen.getByText("补充指令")).toBeTruthy();
    expect(screen.getByText("Also add tests")).toBeTruthy();
  });

  it("uses a compact status row and hides message-id metadata", () => {
    const { container } = renderMessages([
      {
        id: "status",
        role: "assistant",
        variant: "status",
        content: "Connecting to MCP servers…",
      },
      {
        id: "message-id",
        role: "assistant",
        variant: "message-id",
        messageId: "backend-message-id",
      },
    ]);

    expect(container.querySelector("[data-slot=status-message]")?.textContent).toContain(
      "Connecting to MCP servers…",
    );
    expect(container.textContent).not.toContain("backend-message-id");
    expect(container.querySelectorAll("[data-slot=assistant-avatar]")).toHaveLength(0);
  });

  it("does not expose session fork while ACP lacks fork support", () => {
    renderMessages([{ id: "turn-2", role: "user", content: "Try another approach", turnIndex: 2 }]);
    expect(screen.queryByRole("button", { name: "从此轮分叉会话" })).toBeNull();
  });

  it("handles Enter and Escape only when exactly one approval is pending", () => {
    const onRespondApproval = vi.fn();
    const approvalMessage = {
      id: "approval",
      role: "assistant",
      variant: "tool",
      toolCall: {
        title: "Bash",
        type: "tool-Bash" as never,
        state: "approval-requested",
        approval: { id: "r1", action: "Bash", description: "npm test", sender: "kimi" },
      },
    } as LiveMessage;
    render(
      <MessageList
        messages={[approvalMessage]}
        onRespondApproval={onRespondApproval}
        onRespondQuestion={vi.fn()}
      />,
    );

    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onRespondApproval).toHaveBeenNthCalledWith(1, "r1", "approve");
    expect(onRespondApproval).toHaveBeenNthCalledWith(2, "r1", "reject");
  });

  it("renders Ask User as QuestionCard and hides the pending tool row", () => {
    const onRespondQuestion = vi.fn();
    render(
      <MessageList
        messages={[
          {
            id: "ask-pending",
            role: "assistant",
            variant: "tool",
            toolCall: {
              title: "Asking user questions",
              type: "tool-call" as never,
              state: "input-available",
              toolCallId: "1:ask",
              input: {
                questions: [
                  {
                    question: "Which approach?",
                    header: "Approach",
                    options: [{ label: "A", description: "" }],
                  },
                ],
              },
            },
          },
          {
            id: "ask-question",
            role: "assistant",
            variant: "tool",
            toolCall: {
              title: "AskUserQuestion",
              type: "tool-call" as never,
              state: "question-requested",
              question: {
                id: "7",
                toolCallId: "1:ask:question:0",
                questions: [
                  {
                    question: "Which approach?",
                    header: "Which approach?",
                    options: [
                      { label: "A", description: "" },
                      { label: "B", description: "" },
                    ],
                    multi_select: false,
                    other_label: "其他",
                  },
                ],
                submitted: false,
                resolved: false,
              },
            },
          },
        ]}
        onRespondApproval={vi.fn()}
        onRespondQuestion={onRespondQuestion}
      />,
    );

    expect(screen.getByText("Kimi 想确认几个问题")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "其他" })).toBeTruthy();
    expect(document.querySelector("[data-slot=agent-tool-card]")).toBeNull();
    expect(screen.queryByText("Asking user questions")).toBeNull();
  });

  it("keeps completed Ask User as QuestionCard with answers, not raw JSON", () => {
    renderMessages([
      {
        id: "ask-done",
        role: "assistant",
        variant: "tool",
        toolCall: {
          title: "AskUserQuestion",
          type: "tool-call" as never,
          state: "output-available",
          toolCallId: "1:ask",
          input: {},
          output: JSON.stringify({
            answers: { Approach: "Ship it" },
          }),
          question: {
            id: "7",
            toolCallId: "1:ask:question:0",
            questions: [
              {
                question: "Which approach?",
                header: "Approach",
                options: [
                  { label: "Ship it", description: "" },
                  { label: "Keep iterating", description: "" },
                ],
                multi_select: false,
              },
            ],
            submitted: true,
            resolved: true,
            answers: { Approach: "Ship it" },
          },
        },
      },
    ]);

    expect(screen.getByText("Kimi 想确认几个问题")).toBeTruthy();
    expect(screen.getByText("Ship it")).toBeTruthy();
    expect(screen.getByText("已提交")).toBeTruthy();
    expect(screen.queryByText(/User dismissed/)).toBeNull();
    expect(screen.queryByText("等待子代理步骤…")).toBeNull();
    expect(document.querySelector("[data-slot=subagent-steps]")).toBeNull();
  });

  it("shows friendly dismissed copy for skipped Ask User", () => {
    renderMessages([
      {
        id: "ask-dismissed",
        role: "assistant",
        variant: "tool",
        toolCall: {
          title: "AskUserQuestion",
          type: "tool-call" as never,
          state: "output-available",
          toolCallId: "1:ask",
          input: {},
          output: JSON.stringify({
            answers: {},
            note: "User dismissed the question without answering.",
          }),
        },
      },
    ]);

    expect(screen.getByText("Kimi 想确认几个问题")).toBeTruthy();
    expect(screen.getByText("已跳过，未作答")).toBeTruthy();
    expect(screen.queryByText(/User dismissed/)).toBeNull();
    expect(screen.queryByText("等待子代理步骤…")).toBeNull();
  });
});

describe("MessageList todo merging (issue #13)", () => {
  const todoMessage = (id: string, title: string, toolTitle = "TodoList"): LiveMessage => ({
    id,
    role: "assistant",
    variant: "tool",
    toolCall: {
      title: toolTitle,
      type: "tool-TodoList" as never,
      state: "output-available",
      toolCallId: id,
      input: { todos: [{ title, status: "in_progress" }] },
    },
  });

  it("renders only the newest SetTodoList card and leaves other tools alone", () => {
    renderMessages([
      todoMessage("t1", "旧清单项"),
      {
        id: "bash-1",
        role: "assistant",
        variant: "tool",
        toolCall: {
          title: "Bash",
          type: "tool-Bash" as never,
          state: "output-available",
          toolCallId: "bash-1",
          input: { command: "ls" },
        },
      },
      todoMessage("t2", "新清单项"),
    ]);

    // One todo card (the newest); the stale one is skipped entirely.
    expect(screen.getAllByText("Todo List")).toHaveLength(1);
    expect(screen.queryAllByText(/旧清单项/)).toHaveLength(0);
    // Non-todo tool cards are unaffected.
    expect(screen.getByText("ls")).toBeTruthy();
  });

  it("merges live ACP Todo List titles even when replay message ids collide", () => {
    renderMessages([
      todoMessage("replayed-assistant", "旧清单项", "Todo List"),
      todoMessage("replayed-assistant", "新清单项", "Todo List"),
    ]);

    expect(screen.getAllByText("Todo List")).toHaveLength(1);
    expect(screen.queryByText(/旧清单项/)).toBeNull();
    expect(screen.getAllByText(/新清单项/).length).toBeGreaterThan(0);
  });
});

describe("MessageList long-session windowing (issue #13)", () => {
  const textMessages = (count: number, prefix = "message"): LiveMessage[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index}`,
      role: "assistant",
      variant: "text",
      content: `${prefix} ${index}`,
    }));

  it("bounds the initial DOM and loads older history in pages", () => {
    renderMessages(textMessages(300));

    expect(screen.queryByText("message 179")).toBeNull();
    expect(screen.getByText("message 180")).toBeTruthy();
    expect(screen.getByRole("button", { name: "加载更早消息（剩余 180 条）" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "加载更早消息（剩余 180 条）" }));

    expect(screen.queryByText("message 79")).toBeNull();
    expect(screen.getByText("message 80")).toBeTruthy();
    expect(screen.getByRole("button", { name: "加载更早消息（剩余 80 条）" })).toBeTruthy();
  });

  it("keeps an unresolved interaction visible outside the recent window", () => {
    const messages = textMessages(300);
    messages[0] = {
      id: "approval-old",
      role: "assistant",
      variant: "tool",
      toolCall: {
        title: "Bash",
        type: "tool-Bash" as never,
        state: "approval-requested",
        toolCallId: "approval-old",
        approval: {
          id: "approval-old",
          action: "Bash",
          description: "Run old pending command",
          sender: "Kimi",
          submitted: false,
          resolved: false,
        },
      },
    };

    renderMessages(messages);

    expect(screen.getAllByText("Run old pending command").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "加载更早消息（剩余 179 条）" })).toBeTruthy();
  });

  it("resets the expanded history window when the session changes", () => {
    const props = {
      isAwaitingFirstResponse: false,
      errorMessage: undefined,
      onRespondApproval: vi.fn(),
      onRespondQuestion: vi.fn(),
    };
    const view = render(
      <MessageList sessionId="session-a" messages={textMessages(300, "a")} {...props} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "加载更早消息（剩余 180 条）" }));
    expect(screen.getByText("a 80")).toBeTruthy();

    view.rerender(
      <MessageList sessionId="session-b" messages={textMessages(300, "b")} {...props} />,
    );

    expect(screen.queryByText("b 179")).toBeNull();
    expect(screen.getByText("b 180")).toBeTruthy();
  });
});
