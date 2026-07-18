import { beforeEach, describe, expect, it } from "vitest";
import { useAgentMonitorStore } from "./store";
import {
  clearAgentMonitorSession,
  syncAgentMonitorFromSubagentEvent,
  syncAgentMonitorFromSubagentLifecycle,
  syncAgentMonitorFromTaskCompleted,
  syncAgentMonitorFromTaskCreated,
  syncAgentMonitorFromTaskProgress,
} from "./sync";

describe("agent monitor event synchronization", () => {
  beforeEach(() => {
    useAgentMonitorStore.setState({ tasks: [], selectedTaskId: null });
  });

  it("maps task events without inventing per-agent progress", () => {
    syncAgentMonitorFromTaskCreated({
      type: "TaskCreated",
      payload: {
        session_id: "session-1",
        task: {
          id: "agent-1",
          kind: "subagent",
          description: "Review authentication",
          status: "queued",
          subagent_type: "reviewer",
          parent_tool_call_id: "swarm-1",
          swarm_index: 0,
          created_at: 100,
        },
      },
    });
    syncAgentMonitorFromTaskProgress({
      type: "TaskProgress",
      payload: {
        session_id: "session-1",
        task_id: "agent-1",
        output_chunk: "Checking token validation",
        stream: "text",
        phase: "Reviewing validation",
      },
    });

    const running = useAgentMonitorStore.getState().tasks[0];
    expect(running).toMatchObject({
      status: "running",
      text: "Checking token validation",
      currentStep: "Reviewing validation",
      parentToolCallId: "swarm-1",
      swarmIndex: 0,
    });
    expect(running).not.toHaveProperty("progress");

    syncAgentMonitorFromTaskCompleted({
      type: "TaskCompleted",
      payload: {
        session_id: "session-1",
        task_id: "agent-1",
        status: "failed",
        output_preview: "One invalid branch",
        output_bytes: 18,
        error: "Token policy failed",
      },
    });
    expect(useAgentMonitorStore.getState().tasks[0]).toMatchObject({
      status: "error",
      currentStep: "Token policy failed",
      outputPreview: "One invalid branch",
      outputBytes: 18,
    });
  });

  it("keeps matching task IDs isolated by session", () => {
    for (const sessionId of ["session-1", "session-2"]) {
      syncAgentMonitorFromTaskCreated({
        type: "TaskCreated",
        payload: {
          session_id: sessionId,
          task: {
            id: "shared-agent",
            kind: "subagent",
            description: "Review changes",
            status: "running",
          },
        },
      });
    }

    syncAgentMonitorFromTaskCompleted({
      type: "TaskCompleted",
      payload: {
        session_id: "session-1",
        task_id: "shared-agent",
        status: "completed",
      },
    });

    expect(useAgentMonitorStore.getState().tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: "session-1", status: "success" }),
        expect.objectContaining({ sessionId: "session-2", status: "running" }),
      ]),
    );
  });

  it("maps lifecycle events and preserves the legacy SubagentEvent API", () => {
    syncAgentMonitorFromSubagentLifecycle({
      type: "SubagentLifecycle",
      payload: {
        session_id: "session-1",
        agent_id: "agent-2",
        parent_tool_call_id: "swarm-2",
        subagent_type: "coder",
        description: "Implement tests",
        phase: "spawned",
      },
    });
    syncAgentMonitorFromSubagentLifecycle({
      type: "SubagentLifecycle",
      payload: {
        session_id: "session-1",
        agent_id: "agent-2",
        phase: "suspended",
        reason: "Waiting for approval",
      },
    });
    expect(useAgentMonitorStore.getState().tasks[0]).toMatchObject({
      status: "suspended",
      currentStep: "Waiting for approval",
    });

    syncAgentMonitorFromSubagentEvent(
      "legacy-parent",
      "ToolCall",
      { function: { name: "ReadFile" } },
      "legacy-agent",
      "explore",
      "session-1",
    );
    expect(useAgentMonitorStore.getState().tasks[1]).toMatchObject({
      id: "legacy-agent",
      status: "running",
      currentStep: "Running ReadFile",
      parentToolCallId: "legacy-parent",
    });

    clearAgentMonitorSession("session-1");
    expect(useAgentMonitorStore.getState().tasks).toEqual([]);
  });
});
