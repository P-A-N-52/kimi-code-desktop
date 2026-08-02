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
    const body = () => document.querySelector("[data-slot=tool-body]");
    expect(body()?.getAttribute("data-open")).toBe("false");
    fireEvent.click(screen.getByRole("button"));
    expect(body()?.getAttribute("data-open")).toBe("true");
    expect(screen.getByText(/all passed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(body()?.getAttribute("data-open")).toBe("false");
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

  it("routes Agent tools to AgentToolCard with structured output", () => {
    render(
      <ToolCard
        defaultOpen
        toolCall={{
          title: "Agent",
          type: "tool-Agent" as never,
          state: "output-available",
          input: {
            description: "测试子代理功能",
            subagent_type: "explore",
            prompt: "List dirs",
          },
          output: [
            "agent_id: agent-0",
            "actual_subagent_type: explore",
            "status: completed",
            "[summary]",
            "ok",
          ].join("\n"),
          mediaParts: [{ type: "image_url", url: "https://example.com/agent.png" }],
          subagentType: "explore",
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

    expect(document.querySelector("[data-slot=agent-tool-card]")).not.toBeNull();
    expect(document.querySelector("[data-slot=agent-badge]")?.textContent).toBe("AGENT");
    expect(document.querySelector("[data-slot=agent-type-chip]")?.textContent).toBe("explore");
    expect(screen.queryByText(/agent_id: agent-0/)).toBeNull();
    expect(screen.getByRole("img", { name: "agent.png" })).toBeTruthy();
    expect(document.querySelector("[data-slot=agent-subagent-progress]")).not.toBeNull();
    expect(screen.getByText("Inspecting files")).toBeTruthy();
    expect(screen.getByText("ReadFile")).toBeTruthy();
  });

  it("routes agent-shaped inputs even when the title is a description", () => {
    render(
      <ToolCard
        toolCall={{
          title: "测试子代理功能",
          type: "tool-call" as never,
          state: "output-available",
          input: {
            description: "测试子代理功能",
            subagent_type: "explore",
            prompt: "go",
          },
          output: "agent_id: agent-0\nstatus: completed\n[summary]\ndone",
        }}
      />,
    );

    expect(document.querySelector("[data-slot=agent-tool-card]")).not.toBeNull();
    expect(document.querySelector("[data-slot=swarm-tool-card]")).toBeNull();
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

  it("routes TaskOutput tools to the read-only background task card", () => {
    render(
      <ToolCard
        defaultOpen
        toolCall={{
          title: "TaskOutput",
          type: "tool-call" as never,
          state: "input-available",
          toolCallId: "task-output-1",
          input: { task_id: "bg-1" },
          output: "status: running",
          extras: { in_progress: true },
        }}
      />,
    );

    expect(document.querySelector("[data-slot=background-task-tool-card]")).not.toBeNull();
    expect(screen.getByText(/只读观察/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /停止|Stop|Delete/i })).toBeNull();
  });

  it("routes AgentSwarm tool calls to the swarm card", () => {
    render(
      <ToolCard
        toolCall={{
          title: "AgentSwarm",
          type: "tool-AgentSwarm" as never,
          state: "input-available",
          toolCallId: "swarm-1",
          input: {
            description: "Parallel review",
            prompt_template: "Review {{item}}",
            items: ["a", "b"],
          },
        }}
      />,
    );

    expect(document.querySelector("[data-slot=swarm-tool-card]")).not.toBeNull();
    expect(screen.getByText("Swarm")).toBeTruthy();
  });

  it("routes swarm-shaped inputs even when the title is a description", () => {
    render(
      <ToolCard
        toolCall={{
          title: "Review the ACP bridge in parallel",
          type: "tool-call" as never,
          state: "output-available",
          toolCallId: "swarm-desc",
          input: {
            description: "Parallel review",
            prompt_template: "Review {{item}}",
            items: ["mode", "events"],
          },
          output: "<agent_swarm_result>\ncompleted: 2\nfailed: 0\naborted: 0\n</agent_swarm_result>",
        }}
      />,
    );

    expect(document.querySelector("[data-slot=swarm-tool-card]")).not.toBeNull();
  });

  it("does not route Ask User tools to AgentToolCard", () => {
    render(
      <ToolCard
        toolCall={{
          title: "Asking user questions",
          type: "tool-call" as never,
          state: "input-available",
          toolCallId: "1:ask",
          input: {
            questions: [
              {
                question: "Which approach?",
                header: "Approach",
                options: [
                  { label: "A", description: "" },
                  { label: "B", description: "" },
                ],
                multi_select: false,
              },
            ],
          },
        }}
      />,
    );

    expect(document.querySelector("[data-slot=agent-tool-card]")).toBeNull();
    expect(document.querySelector("[data-slot=swarm-tool-card]")).toBeNull();
  });

  it("does not show subagent progress UI on ordinary Bash tools", () => {
    render(
      <ToolCard
        defaultOpen
        toolCall={{
          ...baseToolCall,
          state: "input-available",
          // Stale/incorrect flags that used to leak SubagentSteps into GenericToolCard.
          subagentRunning: true,
          extras: { in_progress: true },
        }}
      />,
    );

    expect(document.querySelector("[data-slot=subagent-steps]")).toBeNull();
    expect(screen.queryByText("等待子代理步骤…")).toBeNull();
    expect(screen.queryByText(/子代理/)).toBeNull();
  });
});
