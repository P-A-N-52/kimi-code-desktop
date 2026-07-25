import { describe, expect, it } from "vitest";
import type { AgentTask } from "@/lib/agent-monitor/store";
import { parseSwarmResult } from "./parseSwarmResult";
import {
  agentTaskToSwarmMember,
  buildSwarmCardRows,
  phaseForAgentTask,
  resolveSwarmMembers,
} from "./swarmCardRows";

function task(partial: Partial<AgentTask> & Pick<AgentTask, "id">): AgentTask {
  return {
    sessionId: "s1",
    kind: "subagent",
    agentType: "coder",
    description: partial.description ?? partial.id,
    status: "running",
    currentStep: "",
    createdAt: 1,
    ...partial,
  };
}

describe("swarm card rows", () => {
  it("maps terminal agent statuses over stale phases", () => {
    expect(
      phaseForAgentTask(task({ id: "1", status: "cancelled", subagentPhase: "working" })),
    ).toBe("failed");
    expect(phaseForAgentTask(task({ id: "2", status: "success", subagentPhase: "working" }))).toBe(
      "completed",
    );
    expect(phaseForAgentTask(task({ id: "3", status: "queued" }))).toBe("queued");
  });

  it("resolves swarm members by parentToolCallId and swarmIndex", () => {
    const members = resolveSwarmMembers(
      [
        task({ id: "b", parentToolCallId: "swarm-1", swarmIndex: 1, description: "Second" }),
        task({ id: "a", parentToolCallId: "swarm-1", swarmIndex: 0, description: "First" }),
        task({ id: "x", parentToolCallId: "other", swarmIndex: 0 }),
      ],
      "swarm-1",
    );
    expect(members.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("prefers live members and appends aborted result-only rows", () => {
    const members = [
      agentTaskToSwarmMember(
        task({
          id: "a1",
          description: "Auth review",
          status: "running",
          text: "Checking tokens\nLatest line",
        }),
      ),
    ];
    const result = parseSwarmResult(`
<agent_swarm_result>
<summary>completed: 0, failed: 0, aborted: 1</summary>
<subagent outcome="aborted" item="Docs" state="not_started">Never started</subagent>
<subagent outcome="aborted" item="Auth review" agent_id="a1">covered</subagent>
</agent_swarm_result>
`);
    const rows = buildSwarmCardRows(members, result);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: "a1",
      phase: "working",
      activity: "Latest line",
    });
    expect(rows[1]).toMatchObject({
      name: "Docs",
      phase: "failed",
      activity: "Never started",
    });
  });

  it("falls back to result-only rows when no live members remain", () => {
    const result = parseSwarmResult(`
<agent_swarm_result>
<summary>completed: 1, failed: 0</summary>
<subagent outcome="completed" item="Done" agent_id="z">All good</subagent>
</agent_swarm_result>
`);
    const rows = buildSwarmCardRows([], result);
    expect(rows).toEqual([
      {
        id: "z",
        name: "Done",
        activity: "All good",
        phase: "completed",
        body: "All good",
      },
    ]);
  });
});
