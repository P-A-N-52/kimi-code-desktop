import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LiveMessage } from "@/hooks/types";
import { ToolCard } from "./tool-card";

const baseToolCall: NonNullable<LiveMessage["toolCall"]> = {
  title: "Bash",
  type: "tool-Bash" as never,
  state: "output-available",
  input: { command: "npm test" },
  output: "✓ all passed",
};

describe("ToolCard", () => {
  it("默认折叠，点击展开显示输出，再点收起", () => {
    render(<ToolCard toolCall={baseToolCall} />);
    expect(document.querySelector("[data-slot=tool-body]")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(document.querySelector("[data-slot=tool-body]")).not.toBeNull();
    expect(screen.getByText(/all passed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(document.querySelector("[data-slot=tool-body]")).toBeNull();
  });
  it("显示参数摘要", () => {
    render(<ToolCard toolCall={baseToolCall} />);
    expect(screen.getByText("npm test")).toBeTruthy();
  });

  it("normalizes legacy tool names and renders semantic display blocks", () => {
    render(
      <ToolCard
        defaultOpen
        toolCall={{
          ...baseToolCall,
          title: "TodoList",
          display: [
            {
              type: "todo",
              data: { items: [{ title: "Wire the workspace", status: "in_progress" }] },
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Todo List")).toBeTruthy();
    expect(screen.getByText("Wire the workspace")).toBeTruthy();
  });

  it("renders tool media and subagent activity", () => {
    render(
      <ToolCard
        defaultOpen
        toolCall={{
          title: "Agent",
          type: "tool-Agent" as never,
          state: "output-available",
          mediaParts: [{ type: "image_url", url: "https://example.com/agent.png" }],
          subagentType: "coder",
          subagentRunning: false,
          subagentSteps: [
            { kind: "thinking", text: "Inspecting files" },
            {
              kind: "tool-call",
              toolCallId: "sub-1",
              toolName: "ReadFile",
              status: "success",
              output: "done",
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole("img", { name: "agent.png" })).toBeTruthy();
    expect(screen.getByText(/Coder agent completed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Coder agent completed/ }));
    expect(screen.getByText("Inspecting files")).toBeTruthy();
    expect(screen.getByText("ReadFile")).toBeTruthy();
  });

  it("keeps a JSON fallback for unknown display blocks", () => {
    render(
      <ToolCard
        defaultOpen
        toolCall={{
          ...baseToolCall,
          display: [{ type: "custom_result", data: { answer: 42 } }],
        }}
      />,
    );

    expect(screen.getByText("custom_result")).toBeTruthy();
    expect(screen.getByText(/"answer": 42/)).toBeTruthy();
  });
});
