import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAgentMonitorStore } from "@/lib/agent-monitor/store";
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
  beforeEach(() => {
    useAgentMonitorStore.setState({ tasks: [], selectedTaskId: null });
  });

  it("renders a dedicated agent card with structured fields", () => {
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

    const card = document.querySelector("[data-slot=agent-tool-card]");
    expect(card).not.toBeNull();
    expect(card?.getAttribute("data-agent-status")).toBe("completed");
    expect(document.querySelector("[data-slot=agent-badge]")?.textContent).toBe("AGENT");
    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getAllByText("测试子代理功能").length).toBeGreaterThan(0);
    expect(document.querySelector("[data-slot=agent-type-chip]")?.textContent).toBe("explore");
    expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
    expect(screen.getByText("agent-0")).toBeTruthy();
    expect(screen.getByText("统计目录数量")).toBeTruthy();
    expect(document.querySelector("[data-slot=agent-summary]")?.textContent).toContain(
      "测试完成，结果如下",
    );
    expect(document.querySelector("[data-slot=agent-subagent-progress]")).not.toBeNull();
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

    expect(document.querySelector("[data-slot=agent-tool-card]")?.getAttribute("data-agent-status")).toBe(
      "running",
    );
    expect(document.querySelector("[data-slot=agent-body]")?.getAttribute("data-open")).toBe(
      "true",
    );
    expect(document.querySelector('[data-status="running"]')).not.toBeNull();
    expect(screen.getAllByText("运行中").length).toBeGreaterThan(0);
    expect(document.querySelector("[data-slot=agent-subagent-progress]")).not.toBeNull();
  });

  it("does not show a checkmark for ACP in_progress ToolResult ticks", () => {
    render(
      <AgentToolCard
        toolCall={{
          title: "Agent",
          type: "tool-Agent" as never,
          state: "output-available",
          toolCallId: "agent-tick",
          input: { description: "刚派发", subagent_type: "explore", prompt: "go" },
          output: "agent_id: agent-9\nactual_subagent_type: explore\nstatus: running",
          extras: { in_progress: true },
        }}
      />,
    );

    expect(document.querySelector("[data-slot=agent-tool-card]")?.getAttribute("data-agent-status")).toBe(
      "running",
    );
    expect(document.querySelector("[data-slot=agent-status-icon] [data-status=running]")).not.toBeNull();
    expect(screen.getAllByText("运行中").length).toBeGreaterThan(0);
  });

  it("stays running when monitor task is still active after spawn ack", () => {
    useAgentMonitorStore.setState({
      tasks: [
        {
          id: "agent-spawn",
          sessionId: "s1",
          kind: "subagent",
          agentType: "explore",
          description: "刚派发",
          status: "running",
          currentStep: "Reading files",
          createdAt: Date.now(),
          parentToolCallId: "agent-parent",
        },
      ],
    });

    const { unmount } = render(
      <AgentToolCard
        toolCall={{
          title: "Agent",
          type: "tool-Agent" as never,
          state: "output-available",
          toolCallId: "agent-parent",
          input: { description: "刚派发", subagent_type: "explore", prompt: "go" },
          output: "agent_id: agent-spawn\nactual_subagent_type: explore\nstatus: completed",
          subagentAgentId: "agent-spawn",
        }}
      />,
    );

    expect(
      document.querySelector("[data-slot=agent-tool-card]")?.getAttribute("data-agent-status"),
    ).toBe("running");
    expect(document.querySelector("[data-slot=agent-subagent-progress]")).not.toBeNull();
    expect(screen.getAllByText("Reading files").length).toBeGreaterThan(0);
    expect(
      document.querySelector("[data-slot=agent-status-icon] [data-status=running]"),
    ).not.toBeNull();

    unmount();
    useAgentMonitorStore.setState({ tasks: [] });
  });

  it("shows live SubagentSteps under the progress row", () => {
    render(
      <AgentToolCard
        defaultOpen
        toolCall={{
          title: "Agent",
          type: "tool-Agent" as never,
          state: "output-available",
          toolCallId: "agent-steps",
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

    expect(document.querySelector("[data-slot=agent-subagent-progress]")).not.toBeNull();
    expect(screen.getByText(/步骤/)).toBeTruthy();
    // Steps expand by default when present.
    expect(screen.getByText("Inspecting files")).toBeTruthy();
    expect(screen.getByText("ReadFile")).toBeTruthy();
  });

  it("lists multiple monitor children with status and count", () => {
    useAgentMonitorStore.setState({
      tasks: [
        {
          id: "c1",
          sessionId: "s1",
          kind: "subagent",
          agentType: "explore",
          description: "查认证",
          status: "running",
          currentStep: "Reading auth.ts",
          createdAt: 1,
          parentToolCallId: "agent-multi",
          swarmIndex: 0,
        },
        {
          id: "c2",
          sessionId: "s1",
          kind: "subagent",
          agentType: "coder",
          description: "写测试",
          status: "queued",
          currentStep: "",
          createdAt: 2,
          parentToolCallId: "agent-multi",
          swarmIndex: 1,
        },
      ],
    });

    render(
      <AgentToolCard
        defaultOpen
        toolCall={{
          title: "Agent",
          type: "tool-Agent" as never,
          state: "input-available",
          toolCallId: "agent-multi",
          input: { description: "并行子任务", subagent_type: "explore", prompt: "go" },
          subagentRunning: true,
        }}
      />,
    );

    expect(document.querySelector("[data-slot=agent-progress-count]")?.textContent).toBe("0/2");
    expect(screen.getByText("查认证")).toBeTruthy();
    expect(screen.getByText("写测试")).toBeTruthy();
    expect(screen.getAllByText("Reading auth.ts").length).toBeGreaterThan(0);
    expect(screen.getByText("排队中")).toBeTruthy();
    expect(
      document.querySelector("[data-slot=agent-tool-card]")?.getAttribute("data-agent-status"),
    ).toBe("running");
    expect(document.querySelectorAll("[data-slot=agent-subagent-row]").length).toBe(2);
  });
});
