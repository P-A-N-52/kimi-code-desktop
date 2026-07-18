import { beforeEach, describe, expect, it } from "vitest";
import { type AgentTask, groupAgentTasks, useAgentMonitorStore } from "./store";

function task(patch: Partial<AgentTask>): AgentTask {
  return {
    id: "agent-1",
    sessionId: "session-1",
    kind: "subagent",
    agentType: "coder",
    description: "Implement the API",
    status: "queued",
    currentStep: "Waiting to start",
    createdAt: 100,
    ...patch,
  };
}

describe("agent monitor store", () => {
  beforeEach(() => {
    useAgentMonitorStore.setState({ tasks: [], selectedTaskId: null });
  });

  it("groups swarm members by parent tool call and derives aggregate progress", () => {
    const groups = groupAgentTasks([
      task({
        id: "agent-2",
        status: "running",
        parentToolCallId: "swarm-1",
        swarmIndex: 1,
      }),
      task({
        status: "success",
        parentToolCallId: "swarm-1",
        swarmIndex: 0,
      }),
      task({ id: "standalone", agentType: "explore", createdAt: 200 }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      parentToolCallId: "swarm-1",
      status: "running",
      settledCount: 1,
      progress: 50,
    });
    expect(groups[0]?.tasks.map((member) => member.id)).toEqual(["agent-1", "agent-2"]);
    expect(groups[1]?.tasks[0]?.id).toBe("standalone");
  });

  it("keeps cancelled distinct from failed and clears only the requested session", () => {
    const store = useAgentMonitorStore.getState();
    store.upsertTask(task({}));
    store.upsertTask(task({ id: "other", sessionId: "session-2" }));

    store.cancelTask("agent-1");
    expect(useAgentMonitorStore.getState().tasks[0]?.status).toBe("cancelled");

    store.clearSession("session-1");
    expect(useAgentMonitorStore.getState().tasks.map((entry) => entry.id)).toEqual(["other"]);
  });
});
