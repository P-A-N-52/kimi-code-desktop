import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentStep } from "@/hooks/types";
import { useAgentMonitorStore } from "@/lib/agent-monitor/store";
import { createSessionRuntime } from "./runtime";

let wireMessageHandler: ((message: string) => void) | null = null;

const mocks = vi.hoisted(() => ({
  controlSessionGoal: vi.fn(),
  getSessionGoalSnapshot: vi.fn(),
  getSessionRuntimeModes: vi.fn(),
  getSessionConfigState: vi.fn(),
  isTauri: vi.fn(),
  migrateSessionSwarmMode: vi.fn(),
  onWireMessage: vi.fn(),
  replaySessionHistory: vi.fn(),
  wireConnect: vi.fn(),
  wireDisconnect: vi.fn(),
  wireSend: vi.fn(),
  wireStatus: vi.fn(),
  fetchManagedUsage: vi.fn(),
  getGlobalConfig: vi.fn(),
  getKimiCliVersion: vi.fn(),
  getSession: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
  controlSessionGoal: mocks.controlSessionGoal,
  getSessionGoalSnapshot: mocks.getSessionGoalSnapshot,
  getSessionRuntimeModes: mocks.getSessionRuntimeModes,
  getSessionConfigState: mocks.getSessionConfigState,
  isTauri: mocks.isTauri,
  migrateSessionSwarmMode: mocks.migrateSessionSwarmMode,
  onWireMessage: mocks.onWireMessage,
  replaySessionHistory: mocks.replaySessionHistory,
  wireConnect: mocks.wireConnect,
  wireDisconnect: mocks.wireDisconnect,
  wireSend: mocks.wireSend,
  wireStatus: mocks.wireStatus,
  fetchManagedUsage: mocks.fetchManagedUsage,
  getGlobalConfig: mocks.getGlobalConfig,
  getKimiCliVersion: mocks.getKimiCliVersion,
  getSession: mocks.getSession,
  sendNotification: mocks.sendNotification,
}));

vi.mock("@/lib/version", () => ({
  resolveKimiCliVersion: vi.fn(() => Promise.resolve("test-version")),
}));

async function flushPromises() {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

function contentPartWire(text: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "event",
    params: {
      type: "ContentPart",
      payload: { type: "text", text },
    },
  });
}

describe("createSessionRuntime", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.isTauri.mockReturnValue(true);
    mocks.onWireMessage.mockImplementation(
      (_sessionId: string, handler: (message: string) => void) => {
        wireMessageHandler = handler;
        return () => undefined;
      },
    );
    mocks.replaySessionHistory.mockResolvedValue([]);
    mocks.getSessionGoalSnapshot.mockResolvedValue(null);
    mocks.controlSessionGoal.mockResolvedValue(null);
    mocks.getSessionRuntimeModes.mockResolvedValue({
      planMode: false,
      permissionMode: "manual",
      swarmMode: false,
      goalMode: false,
    });
    mocks.getSessionConfigState.mockResolvedValue({
      sessionId: "session-1",
      status: "unknown",
      options: [],
    });
    mocks.migrateSessionSwarmMode.mockResolvedValue(undefined);
    mocks.wireConnect.mockResolvedValue(undefined);
    mocks.wireDisconnect.mockResolvedValue(undefined);
    mocks.wireSend.mockResolvedValue(undefined);
    mocks.wireStatus.mockResolvedValue(null);
    mocks.fetchManagedUsage.mockResolvedValue({
      kind: "error",
      message: "Not signed in",
    });
    mocks.getGlobalConfig.mockResolvedValue({ defaultModel: "kimi" });
    mocks.getKimiCliVersion.mockResolvedValue("1.2.3");
    mocks.getSession.mockResolvedValue({ workDir: "/tmp/demo" });
  });

  afterEach(() => {
    wireMessageHandler = null;
    vi.clearAllMocks();
  });

  it("creates a runtime with an initial empty snapshot", () => {
    const runtime = createSessionRuntime({ sessionId: "session-1" });

    expect(runtime.sessionId).toBe("session-1");
    const snapshot = runtime.getSnapshot();
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.isConnected).toBe(false);
    expect(snapshot.isReplayingHistory).toBe(true);
    expect(snapshot.isAwaitingFirstResponse).toBe(false);
    expect(snapshot.canCancel).toBe(false);
    expect(snapshot.sessionStatus).toBeNull();
    expect(snapshot.error).toBeNull();
    expect(snapshot.connectionPhase).toBe("disconnected");
    expect(snapshot.connectionId).toBeNull();
    expect(snapshot.sessionConfigState.sessionId).toBe("session-1");
  });

  it("processes injected wire events, notifies subscribers, and keeps snapshots reference-stable", () => {
    const runtime = createSessionRuntime({ sessionId: "session-1" });
    const notified: string[] = [];
    const unsubscribe = runtime.subscribe(() => {
      notified.push(`messages=${runtime.getSnapshot().messages.length}`);
    });

    // No activity -> snapshot reference stays identical.
    const initial = runtime.getSnapshot();
    expect(runtime.getSnapshot()).toBe(initial);

    // ReplayComplete ends the replay gate; the next event is treated as live.
    runtime.handleWireMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: { type: "ReplayComplete" },
      }),
    );
    runtime.handleWireMessage(contentPartWire("hello"));

    const snapshot = runtime.getSnapshot();
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0].content).toBe("hello");
    expect(snapshot.messages[0].isStreaming).toBe(true);
    expect(snapshot.isReplayingHistory).toBe(false);
    expect(snapshot.status).toBe("streaming");
    expect(notified.length).toBeGreaterThan(0);
    expect(notified).toContain("messages=1");

    // No-op updates keep the same snapshot object and do not notify.
    const stable = runtime.getSnapshot();
    const notifiedBefore = notified.length;
    runtime.setMessages((prev) => prev);
    expect(runtime.getSnapshot()).toBe(stable);
    expect(notified.length).toBe(notifiedBefore);

    // Unsubscribing stops notifications while the snapshot still updates.
    unsubscribe();
    const notifiedAfterUnsubscribe = notified.length;
    runtime.setMessages((prev) => [...prev, { id: "m2", role: "assistant", content: "x" }]);
    expect(runtime.getSnapshot().messages).toHaveLength(2);
    expect(notified.length).toBe(notifiedAfterUnsubscribe);
  });

  it("batches scalar StatusUpdate fields into one snapshot notification", () => {
    const runtime = createSessionRuntime({ sessionId: "session-1" });
    let notifications = 0;
    runtime.subscribe(() => {
      notifications += 1;
    });

    runtime.handleWireMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: {
          type: "StatusUpdate",
          payload: {
            context_usage: 0.5,
            context_tokens: 10,
            max_context_tokens: 100,
            plan_mode: true,
            permission_mode: "auto",
            swarm_mode: true,
            goal_mode: true,
          },
        },
      }),
    );

    expect(notifications).toBe(1);
    expect(runtime.getSnapshot()).toMatchObject({
      contextUsage: 0.5,
      contextTokens: 10,
      maxContextTokens: 100,
      planMode: true,
      permissionMode: "auto",
      swarmMode: true,
      goalMode: true,
    });
  });

  it("throttles long streaming content flushes while preserving final content", () => {
    vi.useFakeTimers();
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;
    const pendingFrames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      pendingFrames.set(id, callback);
      return id;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((id: number) => {
      pendingFrames.delete(id);
    }) as typeof window.cancelAnimationFrame;

    const runFrame = () => {
      const first = pendingFrames.entries().next().value as
        | [number, FrameRequestCallback]
        | undefined;
      if (!first) {
        return;
      }
      pendingFrames.delete(first[0]);
      first[1](0);
    };

    try {
      const runtime = createSessionRuntime({ sessionId: "session-1" });
      runtime.handleWireMessage(contentPartWire("a"));
      runtime.handleWireMessage(contentPartWire("b"));
      runFrame();
      expect(runtime.getSnapshot().messages[0].content).toBe("ab");

      const mediumDelta = "m".repeat(2100);
      runtime.handleWireMessage(contentPartWire(mediumDelta));
      runFrame();
      expect(runtime.getSnapshot().messages[0].content).toBe("ab");
      vi.advanceTimersByTime(59);
      runFrame();
      expect(runtime.getSnapshot().messages[0].content).toBe("ab");
      vi.advanceTimersByTime(1);
      runFrame();
      expect(runtime.getSnapshot().messages[0].content).toBe(`ab${mediumDelta}`);

      const longDelta = "l".repeat(6000);
      runtime.handleWireMessage(contentPartWire(longDelta));
      runFrame();
      expect(runtime.getSnapshot().messages[0].content).toBe(`ab${mediumDelta}`);
      vi.advanceTimersByTime(119);
      runFrame();
      expect(runtime.getSnapshot().messages[0].content).toBe(`ab${mediumDelta}`);
      vi.advanceTimersByTime(1);
      runFrame();
      expect(runtime.getSnapshot().messages[0].content).toBe(`ab${mediumDelta}${longDelta}`);
    } finally {
      window.requestAnimationFrame = originalRequestAnimationFrame;
      window.cancelAnimationFrame = originalCancelAnimationFrame;
      vi.useRealTimers();
    }
  });

  it("applies functional setMessages updates against the latest messages", () => {
    const runtime = createSessionRuntime({ sessionId: "session-1" });

    runtime.setMessages([{ id: "m1", role: "user", content: "first" }]);
    runtime.setMessages((prev) => [...prev, { id: "m2", role: "assistant", content: "second" }]);
    runtime.setMessages((prev) => prev.map((message) => ({ ...message, isStreaming: true })));

    const snapshot = runtime.getSnapshot();
    expect(snapshot.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(snapshot.messages.every((message) => message.isStreaming)).toBe(true);
  });

  it("treats injected events as replay until replay completes, then live", () => {
    const runtime = createSessionRuntime({ sessionId: "session-1" });

    // Initial replay gate: events render as non-streaming and do not promote status.
    runtime.handleWireMessage(contentPartWire("replayed text"));
    let snapshot = runtime.getSnapshot();
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0].isStreaming).toBe(false);
    expect(snapshot.status).toBe("ready");

    runtime.handleWireMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: { type: "ReplayComplete" },
      }),
    );
    expect(runtime.getSnapshot().isReplayingHistory).toBe(false);

    // Live turn: TurnBegin opens a user bubble, ContentPart opens a streaming
    // assistant block and promotes status.
    runtime.handleWireMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: { type: "TurnBegin", payload: { user_input: "live prompt" } },
      }),
    );
    runtime.handleWireMessage(contentPartWire("live text"));
    snapshot = runtime.getSnapshot();
    expect(snapshot.messages).toHaveLength(3);
    expect(snapshot.messages[1].role).toBe("user");
    expect(snapshot.messages[2].content).toBe("live text");
    expect(snapshot.messages[2].isStreaming).toBe(true);
    expect(snapshot.status).toBe("streaming");
  });

  it("replays persisted Kimi wire events into the visible timeline", async () => {
    mocks.replaySessionHistory.mockResolvedValue([
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: { type: "TurnBegin", payload: { user_input: "hello" } },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: { type: "StepBegin", payload: { n: 1 } },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: {
          type: "ContentPart",
          payload: { type: "think", think: "checking" },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: {
          type: "ContentPart",
          payload: { type: "text", text: "reply" },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: {
          type: "ToolCall",
          payload: {
            type: "function",
            id: "tool-1",
            function: { name: "ReadFile", arguments: '{"path":"README.md"}' },
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: {
          type: "ToolResult",
          payload: {
            tool_call_id: "tool-1",
            return_value: {
              is_error: false,
              output: "file body",
              message: "file body",
              display: [],
            },
          },
        },
      }),
    ]);

    const runtime = createSessionRuntime({ sessionId: "session-1" });
    runtime.start();
    await flushPromises();

    const snapshot = runtime.getSnapshot();
    expect(mocks.replaySessionHistory).toHaveBeenCalledWith("session-1");
    expect(snapshot.isReplayingHistory).toBe(false);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.messages.filter((message) => message.role === "user")).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: "hello" })]),
    );
    expect(snapshot.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variant: "thinking", thinking: "checking" }),
        expect.objectContaining({ variant: "text", content: "reply" }),
        expect.objectContaining({
          variant: "tool",
          toolCall: expect.objectContaining({
            toolCallId: "tool-1",
            state: "output-available",
            output: "file body",
          }),
        }),
      ]),
    );
  });

  it("start() connects the wire and stop() disconnects and ignores late messages", async () => {
    const runtime = createSessionRuntime({ sessionId: "session-1", autoConnect: true });

    runtime.start();
    await flushPromises();
    await flushPromises();

    expect(mocks.wireConnect).toHaveBeenCalledWith("session-1", expect.any(String));
    expect(mocks.onWireMessage).toHaveBeenCalledWith("session-1", expect.any(Function));

    // Settle the worker: answer the replay request.
    const sentMessages = mocks.wireSend.mock.calls.map(([, rawMessage]) => JSON.parse(rawMessage));
    const replay = sentMessages.find((message) => message.method === "replay");
    expect(replay).toBeDefined();
    wireMessageHandler?.(
      JSON.stringify({
        jsonrpc: "2.0",
        id: replay?.id,
        result: { status: "finished" },
      }),
    );
    await flushPromises();
    expect(runtime.getSnapshot().isConnected).toBe(true);

    runtime.stop();
    await flushPromises();

    expect(mocks.wireDisconnect).toHaveBeenCalledWith("session-1", expect.any(String));

    // Late wire messages from the closed connection are ignored.
    const before = runtime.getSnapshot();
    wireMessageHandler?.(contentPartWire("late"));
    expect(runtime.getSnapshot().messages).toEqual([]);
    expect(runtime.getSnapshot()).toBe(before);
  });

  it("retries the initial wire connect once before surfacing the error", async () => {
    vi.useFakeTimers();
    try {
      mocks.wireConnect
        .mockRejectedValueOnce(new Error("acp still initializing"))
        .mockResolvedValueOnce(undefined);
      const runtime = createSessionRuntime({ sessionId: "session-1", autoConnect: true });

      runtime.start();
      await flushPromises();
      expect(mocks.wireConnect).toHaveBeenCalledTimes(1);

      // The first failure must not surface as an error; it schedules a retry.
      expect(runtime.getSnapshot().error).toBeNull();

      vi.advanceTimersByTime(1500);
      await flushPromises();
      await flushPromises();
      expect(mocks.wireConnect).toHaveBeenCalledTimes(2);

      // Settle the retried connection: answer the replay request.
      const sentMessages = mocks.wireSend.mock.calls.map(([, rawMessage]) =>
        JSON.parse(rawMessage),
      );
      const replay = sentMessages.find((message) => message.method === "replay");
      expect(replay).toBeDefined();
      wireMessageHandler?.(
        JSON.stringify({
          jsonrpc: "2.0",
          id: replay?.id,
          result: { status: "finished" },
        }),
      );
      await flushPromises();

      const snapshot = runtime.getSnapshot();
      expect(snapshot.isConnected).toBe(true);
      expect(snapshot.connectionPhase).toBe("connected");
      expect(snapshot.error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accumulates nested subagent events into a nested step group", async () => {
    const runtime = createSessionRuntime({ sessionId: "session-1" });

    // Parent Agent tool call message in the stream.
    runtime.handleWireMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: {
          type: "ToolCall",
          payload: { id: "tool-1", function: { name: "Agent", arguments: "{}" } },
        },
      }),
    );

    // Outer subagent emits its own text.
    runtime.handleWireMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: {
          type: "SubagentEvent",
          payload: {
            parent_tool_call_id: "tool-1",
            agent_id: "agent-a1",
            subagent_type: "code",
            event: { type: "ContentPart", payload: { type: "text", text: "outer text" } },
          },
        },
      }),
    );

    // Nested subagent (spawned by the subagent) emits its own text.
    runtime.handleWireMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: {
          type: "SubagentEvent",
          payload: {
            parent_tool_call_id: "tool-1",
            agent_id: "agent-a1",
            subagent_type: "code",
            event: {
              type: "SubagentEvent",
              payload: {
                parent_tool_call_id: "tool-1",
                agent_id: "agent-a2",
                subagent_type: "architect",
                event: { type: "ContentPart", payload: { type: "text", text: "nested text" } },
              },
            },
          },
        },
      }),
    );

    const messages = runtime.getSnapshot().messages;
    const toolMsg = messages.find((msg) => msg.toolCall?.toolCallId === "tool-1");
    expect(toolMsg).toBeDefined();
    const steps = toolMsg?.toolCall?.subagentSteps ?? [];
    expect(steps.some((step) => step.kind === "text" && step.text === "outer text")).toBe(true);
    const nested = steps.find(
      (step) => step.kind === "subagent",
    ) as Extract<SubagentStep, { kind: "subagent" }> | undefined;
    expect(nested).toBeDefined();
    expect(nested?.agentId).toBe("agent-a2");
    expect(nested?.steps.some((step) => step.kind === "text" && step.text === "nested text")).toBe(
      true,
    );

    // The nested subagent is also tracked in the agent-monitor store.
    const tracked = useAgentMonitorStore.getState().tasks;
    expect(tracked.some((task) => task.id === "agent-a2")).toBe(true);
  });

  it("surfaces the connect error when the retry also fails", async () => {
    vi.useFakeTimers();
    try {
      mocks.wireConnect.mockRejectedValue(new Error("acp unavailable"));
      const runtime = createSessionRuntime({ sessionId: "session-1", autoConnect: true });

      runtime.start();
      await flushPromises();
      expect(mocks.wireConnect).toHaveBeenCalledTimes(1);
      expect(runtime.getSnapshot().error).toBeNull();

      vi.advanceTimersByTime(1500);
      await flushPromises();
      await flushPromises();
      expect(mocks.wireConnect).toHaveBeenCalledTimes(2);

      const snapshot = runtime.getSnapshot();
      expect(snapshot.error).not.toBeNull();
      expect(snapshot.connectionPhase).toBe("disconnected");
      expect(snapshot.isConnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect or keep waiting after a connected prompt dispatch fails", async () => {
    vi.useFakeTimers();
    try {
      const promptError = new Error(
        "ACP session/prompt failed: code=-32001 message=ACP session shutting down",
      );
      mocks.wireSend.mockImplementation((_sessionId: string, rawMessage: string) => {
        const message = JSON.parse(rawMessage) as { method?: string };
        return message.method === "prompt" ? Promise.reject(promptError) : Promise.resolve();
      });
      const runtime = createSessionRuntime({ sessionId: "session-1", autoConnect: false });

      runtime.start();
      await flushPromises();
      expect(runtime.getSnapshot().status).toBe("ready");

      await runtime.sendMessage("Run the concurrent test");
      await flushPromises();

      await vi.waitFor(() => {
        expect(runtime.getSnapshot().status).toBe("error");
      });
      const failed = runtime.getSnapshot();
      expect(failed.isAwaitingFirstResponse).toBe(false);
      expect(failed.error?.message).toContain("ACP session shutting down");
      expect(mocks.wireConnect).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1500);
      await flushPromises();
      expect(mocks.wireConnect).toHaveBeenCalledTimes(1);
      expect(runtime.getSnapshot().status).toBe("error");
      expect(runtime.getSnapshot().isAwaitingFirstResponse).toBe(false);
      runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
