import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    expect(snapshot.lastEventAt).toBeGreaterThan(0);
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
});
