import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAgentMonitorStore } from "@/lib/agent-monitor/store";
import { SwarmToolCard } from "./swarm-tool-card";

describe("SwarmToolCard", () => {
  beforeEach(() => {
    useAgentMonitorStore.setState({ tasks: [], selectedTaskId: null });
  });

  it("renders live members and segmented progress while running", () => {
    useAgentMonitorStore.getState().upsertTask({
      id: "m1",
      sessionId: "s1",
      kind: "subagent",
      agentType: "coder",
      description: "Auth review",
      status: "running",
      currentStep: "Checking",
      text: "latest activity",
      createdAt: 1,
      parentToolCallId: "swarm-1",
      swarmIndex: 0,
    });
    useAgentMonitorStore.getState().upsertTask({
      id: "m2",
      sessionId: "s1",
      kind: "subagent",
      agentType: "coder",
      description: "Docs",
      status: "queued",
      currentStep: "",
      createdAt: 2,
      parentToolCallId: "swarm-1",
      swarmIndex: 1,
    });

    render(
      <SwarmToolCard
        toolCall={{
          title: "AgentSwarm",
          type: "tool-AgentSwarm" as never,
          state: "input-available",
          toolCallId: "swarm-1",
          input: { description: "Ship auth + docs", items: [{}, {}] },
        }}
      />,
    );

    expect(document.querySelector("[data-slot=swarm-tool-card]")).not.toBeNull();
    expect(screen.getByText("Swarm")).toBeTruthy();
    expect(screen.getByText("Ship auth + docs")).toBeTruthy();
    expect(screen.getByText("Auth review")).toBeTruthy();
    expect(screen.getByText("Docs")).toBeTruthy();
    expect(screen.getByText(/个进行中/)).toBeTruthy();
    expect(document.querySelector("[data-slot=swarm-body]")?.getAttribute("data-open")).toBe(
      "true",
    );
    const liveRow = document.querySelector('[data-slot=swarm-member-row][data-phase=working]');
    expect(liveRow).not.toBeNull();
    expect(liveRow?.getAttribute("data-phase")).toBe("working");
    // Working members with activity expand by default so progress is visible.
    expect(screen.getAllByText("latest activity").length).toBeGreaterThan(0);
  });

  it("defaults collapsed for completed historical swarms and shows result rows", () => {
    const output = `
<agent_swarm_result>
<summary>completed: 1, failed: 0, aborted: 1</summary>
<subagent outcome="completed" item="Auth" agent_id="a1">ok</subagent>
<subagent outcome="aborted" item="Docs" state="not_started">Never started</subagent>
</agent_swarm_result>
`.trim();

    render(
      <SwarmToolCard
        toolCall={{
          title: "AgentSwarm",
          type: "tool-AgentSwarm" as never,
          state: "output-available",
          toolCallId: "swarm-hist",
          input: { description: "Historical" },
          output,
        }}
      />,
    );

    expect(document.querySelector("[data-slot=swarm-body]")?.getAttribute("data-open")).toBe(
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: /Swarm/ }));
    expect(document.querySelector("[data-slot=swarm-body]")?.getAttribute("data-open")).toBe(
      "true",
    );
    expect(screen.getByText("Auth")).toBeTruthy();
    expect(screen.getByText("Docs")).toBeTruthy();
    expect(screen.getByText(/完成 1，失败 1/)).toBeTruthy();
  });

  it("shows denial instead of waiting when approval was rejected", () => {
    render(
      <SwarmToolCard
        toolCall={{
          title: "AgentSwarm",
          type: "tool-AgentSwarm" as never,
          state: "output-denied",
          toolCallId: "swarm-denied",
          input: { description: "Explore", items: [{}, {}] },
          errorText:
            'Tool "AgentSwarm" was not run because the user rejected the approval request.',
          isError: true,
        }}
      />,
    );

    expect(screen.getByText("已拒绝 / 未执行")).toBeTruthy();
    expect(screen.getByText(/rejected the approval request/)).toBeTruthy();
    expect(screen.queryByText("等待子代理启动…")).toBeNull();
  });

  it("does not flash a checkmark when tool finished before members appear", () => {
    render(
      <SwarmToolCard
        toolCall={{
          title: "AgentSwarm",
          type: "tool-AgentSwarm" as never,
          state: "output-available",
          toolCallId: "swarm-spawn-race",
          input: { description: "Parallel explore", items: [{}, {}] },
        }}
      />,
    );

    expect(document.querySelector('[data-status="running"]')).not.toBeNull();
    expect(screen.getByText("2 个排队中")).toBeTruthy();
    expect(screen.queryByText("已完成")).toBeNull();
  });

  it("shows the planned total and queued rows as soon as the swarm is created", () => {
    render(
      <SwarmToolCard
        toolCall={{
          title: "AgentSwarm",
          type: "tool-AgentSwarm" as never,
          state: "input-available",
          toolCallId: "swarm-planned",
          input: {
            description: "Parallel review",
            items: ["Auth", "Docs", "Tests", "Release", "UX"],
          },
        }}
      />,
    );

    expect(screen.getAllByText("0 / 5")).toHaveLength(2);
    expect(screen.getByText("5 个排队中")).toBeTruthy();
    expect(document.querySelectorAll('[data-slot="swarm-member-row"][data-phase="queued"]')).toHaveLength(
      5,
    );
    expect(screen.getByText("Auth")).toBeTruthy();
    expect(screen.getByText("UX")).toBeTruthy();
  });

  it("shows nested subagents while keeping progress totals top-level", () => {
    for (const task of [
      {
        id: "root-a",
        description: "A",
        swarmIndex: 0,
        swarmDepth: 0,
      },
      {
        id: "nested-a1",
        description: "A.1",
        parentAgentId: "root-a",
        swarmIndex: 0,
        swarmDepth: 1,
      },
    ]) {
      useAgentMonitorStore.getState().upsertTask({
        ...task,
        sessionId: "s1",
        kind: "subagent",
        agentType: "explore",
        status: "running",
        currentStep: "正在分析",
        createdAt: 1,
        parentToolCallId: "swarm-nested",
      });
    }

    render(
      <SwarmToolCard
        toolCall={{
          title: "AgentSwarm",
          type: "tool-AgentSwarm" as never,
          state: "input-available",
          toolCallId: "swarm-nested",
          input: { items: ["A", "B"] },
        }}
      />,
    );

    expect(screen.getAllByText("0 / 2")).toHaveLength(2);
    expect(screen.getByText("+1 派生")).toBeTruthy();
    expect(screen.getByText("A.1")).toBeTruthy();
    expect(screen.getByText("↳")).toBeTruthy();
  });
});
