import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentToolCard } from "./agent-tool-card";

const screenshotOutput = [
  "agent_id: agent-0",
  "actual_subagent_type: explore",
  "status: completed",
  "[summary]",
  "测试完成，结果如下：",
  "- 项目根目录下共有 34 个目录",
].join("\n");

describe("AgentToolCard", () => {
  it("renders structured fields instead of a raw key:value dump", () => {
    render(
      <AgentToolCard
        defaultOpen
        toolCall={{
          title: "Agent",
          type: "tool-Agent" as never,
          state: "output-available",
          toolCallId: "agent-call-1",
          input: {
            description: "测试子代理功能",
            subagent_type: "explore",
            prompt: "统计目录数量",
          },
          output: screenshotOutput,
        }}
      />,
    );

    expect(document.querySelector("[data-slot=agent-tool-card]")).not.toBeNull();
    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByText("测试子代理功能")).toBeTruthy();
    expect(document.querySelector("[data-slot=agent-type-chip]")?.textContent).toBe("explore");
    expect(screen.getByText("已完成")).toBeTruthy();
    expect(screen.getByText("agent-0")).toBeTruthy();
    expect(screen.getByText("统计目录数量")).toBeTruthy();
    expect(document.querySelector("[data-slot=agent-summary]")?.textContent).toContain(
      "测试完成，结果如下",
    );
    // Must not present the metadata wall as the primary body
    expect(screen.queryByText(/agent_id: agent-0/)).toBeNull();
    expect(screen.queryByText(/actual_subagent_type: explore/)).toBeNull();
  });

  it("pulses StatusDot while running and expands by default", () => {
    render(
      <AgentToolCard
        toolCall={{
          title: "Agent",
          type: "tool-Agent" as never,
          state: "input-available",
          toolCallId: "agent-run",
          input: { description: "Explore", subagent_type: "explore", prompt: "go" },
          subagentRunning: true,
        }}
      />,
    );

    expect(document.querySelector("[data-slot=agent-body]")?.getAttribute("data-open")).toBe(
      "true",
    );
    expect(document.querySelector('[data-status="running"]')).not.toBeNull();
  });

  it("keeps SubagentSteps when live steps exist", () => {
    render(
      <AgentToolCard
        defaultOpen
        toolCall={{
          title: "Agent",
          type: "tool-Agent" as never,
          state: "output-available",
          input: { description: "x", subagent_type: "coder", prompt: "y" },
          output: "agent_id: a1\nactual_subagent_type: coder\nstatus: completed\n[summary]\nok",
          subagentType: "coder",
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

    expect(screen.getByText(/Coder agent completed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Coder agent completed/ }));
    expect(screen.getByText("Inspecting files")).toBeTruthy();
  });
});
