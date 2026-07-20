import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LiveMessage } from "@/hooks/types";
import { MessageList } from "./message-list";

const renderMessages = (messages: LiveMessage[]) =>
  render(
    <MessageList
      messages={messages}
      onRespondApproval={vi.fn()}
      onRespondQuestion={vi.fn()}
    />,
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
});
