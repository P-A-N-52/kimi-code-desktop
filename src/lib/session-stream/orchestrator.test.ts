import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  listenEvent: vi.fn(),
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
  listenEvent: mocks.listenEvent,
}));

vi.mock("@/lib/version", () => ({
  resolveKimiCliVersion: vi.fn(() => Promise.resolve("test-version")),
}));

import { createSessionStreamOrchestrator } from "./orchestrator";

let globalWireHandler: ((payload: unknown) => void) | null = null;

const sessionStatusMessage = (sessionId: string, state: string, seq: number): string =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "session_status",
    params: {
      session_id: sessionId,
      state,
      seq,
      worker_id: `worker-${sessionId}`,
      updated_at: "2026-01-01T00:00:00Z",
    },
  });

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const emitWire = (sessionId: string, message: string): void => {
  globalWireHandler?.({ session_id: sessionId, message });
};

/** Answer initialize + replay RPCs for one session so its connect chain finishes. */
function completeReplayFor(sessionId: string) {
  const sentMessages = mocks.wireSend.mock.calls
    .filter(([sid]) => sid === sessionId)
    .map(([, rawMessage]) => JSON.parse(rawMessage as string));
  const initialize = sentMessages.find((message) => message.method === "initialize");
  const replay = sentMessages.find((message) => message.method === "replay");
  if (initialize) {
    emitWire(
      sessionId,
      JSON.stringify({ jsonrpc: "2.0", id: initialize.id, result: { slash_commands: [] } }),
    );
  }
  if (replay) {
    emitWire(
      sessionId,
      JSON.stringify({ jsonrpc: "2.0", id: replay.id, result: { status: "finished" } }),
    );
  }
}

describe("session-stream orchestrator (G5 flag on)", () => {
  beforeEach(() => {
    mocks.isTauri.mockReturnValue(true);
    mocks.listenEvent.mockImplementation((_event: string, cb: (payload: unknown) => void) => {
      globalWireHandler = cb;
      return () => {
        globalWireHandler = null;
      };
    });
    mocks.wireConnect.mockResolvedValue(undefined);
    mocks.wireDisconnect.mockResolvedValue(undefined);
    mocks.wireSend.mockResolvedValue(undefined);
    mocks.wireStatus.mockResolvedValue(null);
    mocks.replaySessionHistory.mockResolvedValue([]);
    mocks.getSessionGoalSnapshot.mockResolvedValue(null);
    mocks.controlSessionGoal.mockResolvedValue(null);
    mocks.getSessionRuntimeModes.mockImplementation((_sessionId: string) =>
      Promise.resolve({
        planMode: false,
        permissionMode: "manual",
        swarmMode: false,
        goalMode: false,
      }),
    );
    mocks.getSessionConfigState.mockImplementation((sessionId: string) =>
      Promise.resolve({ sessionId, status: "unknown", options: [] }),
    );
    mocks.migrateSessionSwarmMode.mockResolvedValue(undefined);
    mocks.fetchManagedUsage.mockResolvedValue({ kind: "error", message: "Not signed in" });
    mocks.getGlobalConfig.mockResolvedValue({ defaultModel: "kimi" });
    mocks.getKimiCliVersion.mockResolvedValue("1.2.3");
    mocks.getSession.mockResolvedValue({ workDir: "/tmp/demo" });
  });

  afterEach(() => {
    globalWireHandler = null;
    vi.clearAllMocks();
  });

  const defaultOptions = (sessionId: string | null) => ({
    sessionId,
    baseUrl: "http://localhost:5173",
    autoConnect: false,
  });

  it("registers exactly one global wire:message listener on creation", () => {
    const orchestrator = createSessionStreamOrchestrator();
    expect(mocks.listenEvent).toHaveBeenCalledTimes(1);
    expect(mocks.listenEvent).toHaveBeenCalledWith("wire:message", expect.any(Function));
    orchestrator.destroy();
    expect(mocks.listenEvent.mock.calls[0]?.[0]).toBe("wire:message");
  });

  it("starts an idle runtime created by actionsFor and replays local history", async () => {
    mocks.replaySessionHistory.mockResolvedValue([
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: { type: "ContentPart", payload: { type: "text", text: "local history" } },
      }),
    ]);
    const orchestrator = createSessionStreamOrchestrator();
    const idleOptions = defaultOptions("session-a");

    // React resolves actions during render, before attach() runs in its layout effect.
    orchestrator.actionsFor("session-a", idleOptions);
    orchestrator.attach("session-a", idleOptions);

    await vi.waitFor(() => {
      expect(mocks.replaySessionHistory).toHaveBeenCalledWith("session-a");
      expect(orchestrator.getSnapshot().messages).toEqual([
        expect.objectContaining({ variant: "text", content: "local history" }),
      ]);
    });
    expect(mocks.wireConnect).not.toHaveBeenCalled();
    orchestrator.destroy();
  });

  it("applies live wire messages exactly once (no per-session listener beside the global one)", async () => {
    const registered: Array<{ sessionId: string; handler: (message: string) => void }> = [];
    mocks.onWireMessage.mockImplementation((sessionId: string, handler: (message: string) => void) => {
      registered.push({ sessionId, handler });
      return () => undefined;
    });

    const orchestrator = createSessionStreamOrchestrator();
    const liveOptions = { ...defaultOptions("session-a"), autoConnect: true };

    // Mirror the React adapter: actionsFor runs during render, attach later in
    // a layout effect; both refresh options on the existing runtime.
    orchestrator.actionsFor("session-a", liveOptions);
    orchestrator.attach("session-a", liveOptions);
    await vi.waitFor(() => {
      expect(mocks.wireConnect).toHaveBeenCalledWith("session-a", expect.any(String));
    });
    completeReplayFor("session-a");
    await flushPromises();

    // Further option refreshes (second render, visibility switch back) must not
    // enable a per-session listener on later connects either.
    orchestrator.actionsFor("session-a", liveOptions);
    orchestrator.attach("session-b", defaultOptions("session-b"));
    orchestrator.attach("session-a", liveOptions);
    await flushPromises();

    expect(registered).toHaveLength(0);

    // Simulate Tauri delivering one live delta to every active listener: the
    // global one plus any (buggy) per-session registration.
    const delta = JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "ContentPart", payload: { type: "text", text: "hello" } },
    });
    globalWireHandler?.({ session_id: "session-a", message: delta });
    for (const entry of registered.filter((item) => item.sessionId === "session-a")) {
      entry.handler(delta);
    }

    const textMessages = orchestrator.getSnapshot().messages.filter((m) => m.variant === "text");
    expect(textMessages).toHaveLength(1);
    expect(textMessages[0]?.content).toBe("hello");
    orchestrator.destroy();
  });

  it("shows the empty view before any session is attached", () => {
    const orchestrator = createSessionStreamOrchestrator();
    const snapshot = orchestrator.getSnapshot();
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.isConnected).toBe(false);
    expect(orchestrator.getSnapshot()).toBe(snapshot); // reference-stable
    orchestrator.destroy();
  });

  it("routes wire events to the owning session only (no cross-session leak)", async () => {
    const orchestrator = createSessionStreamOrchestrator();
    orchestrator.attach("session-a", defaultOptions("session-a"));
    await flushPromises();

    // A visible: A's events land in A's snapshot.
    emitWire("session-a", sessionStatusMessage("session-a", "busy", 2));
    expect(orchestrator.getSnapshot().sessionStatus?.state).toBe("busy");

    // Switch to B; B starts empty.
    orchestrator.attach("session-b", defaultOptions("session-b"));
    expect(orchestrator.getSnapshot().sessionStatus).toBeNull();

    // A's late events must not mutate B's visible snapshot.
    emitWire("session-a", sessionStatusMessage("session-a", "idle", 3));
    expect(orchestrator.getSnapshot().sessionStatus).toBeNull();

    // B's own events land in B.
    emitWire("session-b", sessionStatusMessage("session-b", "busy", 1));
    expect(orchestrator.getSnapshot().sessionStatus?.state).toBe("busy");

    // Unknown sessions are dropped silently.
    emitWire("session-unknown", sessionStatusMessage("session-unknown", "busy", 1));
    expect(orchestrator.getSnapshot().sessionStatus?.state).toBe("busy");
    orchestrator.destroy();
  });

  it("keeps a running background worker alive across visibility switches", async () => {
    const orchestrator = createSessionStreamOrchestrator();
    orchestrator.attach("session-a", { ...defaultOptions("session-a"), autoConnect: true });
    await vi.waitFor(() => {
      expect(mocks.wireConnect).toHaveBeenCalledWith("session-a", expect.any(String));
    });
    completeReplayFor("session-a");
    await flushPromises();

    mocks.wireDisconnect.mockClear();
    orchestrator.attach("session-b", defaultOptions("session-b"));
    await flushPromises();

    // The switch away must not kill session-a's worker.
    expect(mocks.wireDisconnect).not.toHaveBeenCalled();
    expect(orchestrator.liveWorkerSessionIds()).toContain("session-a");
    orchestrator.destroy();
  });

  it("connects a running session when switching back to it", async () => {
    const orchestrator = createSessionStreamOrchestrator();
    // A starts idle (fast history replay only).
    orchestrator.attach("session-a", defaultOptions("session-a"));
    await flushPromises();
    expect(mocks.wireConnect).not.toHaveBeenCalled();

    orchestrator.attach("session-b", defaultOptions("session-b"));
    await flushPromises();

    // Switching back to a now-running A (autoConnect) connects its worker.
    orchestrator.attach("session-a", { ...defaultOptions("session-a"), autoConnect: true });
    await flushPromises();
    expect(mocks.wireConnect).toHaveBeenCalledWith("session-a", expect.any(String));
    orchestrator.destroy();
  });

  it("reconnects a disconnected session that still reports an active turn", async () => {
    const orchestrator = createSessionStreamOrchestrator();
    const liveOptions = { ...defaultOptions("session-a"), autoConnect: true };
    orchestrator.attach("session-a", liveOptions);
    await vi.waitFor(() => {
      expect(mocks.wireConnect).toHaveBeenCalledWith("session-a", expect.any(String));
    });
    completeReplayFor("session-a");
    await flushPromises();

    // The frontend lease is gone, but the ACP worker reports that its turn is
    // still active. This is the switch-back state that previously stayed frozen.
    orchestrator.actionsFor("session-a", liveOptions).disconnect();
    emitWire("session-a", sessionStatusMessage("session-a", "busy", 2));
    expect(orchestrator.getSnapshot().status).toBe("streaming");
    expect(orchestrator.getSnapshot().isConnected).toBe(false);

    mocks.wireConnect.mockClear();
    orchestrator.attach("session-b", defaultOptions("session-b"));
    orchestrator.attach("session-a", liveOptions);
    await vi.waitFor(() => {
      expect(mocks.wireConnect).toHaveBeenCalledWith("session-a", expect.any(String));
    });
    orchestrator.destroy();
  });

  it("evicts the oldest non-visible idle worker beyond maxLiveWorkers", async () => {
    const orchestrator = createSessionStreamOrchestrator();
    for (const sessionId of ["session-a", "session-b", "session-c"]) {
      orchestrator.attach(sessionId, { ...defaultOptions(sessionId), autoConnect: true });
    }
    // Wait for all three connect chains to actually reach wireConnect, then
    // finish their replay so they settle into idle ("ready") state.
    await vi.waitFor(() => {
      expect(mocks.wireConnect).toHaveBeenCalledTimes(3);
    });
    for (const sessionId of ["session-a", "session-b", "session-c"]) {
      completeReplayFor(sessionId);
    }
    await flushPromises();
    // a/b/c connected and idle; d is the 4th live worker and a is the oldest
    // non-visible candidate.
    mocks.wireDisconnect.mockClear();
    orchestrator.attach("session-d", { ...defaultOptions("session-d"), autoConnect: true });
    await flushPromises();

    expect(mocks.wireDisconnect).toHaveBeenCalledTimes(1);
    expect(mocks.wireDisconnect.mock.calls[0]?.[0]).toBe("session-a");
    // d's connect chain finishes asynchronously; once it does, exactly three
    // workers are live and session-a stays evicted.
    await vi.waitFor(() => {
      expect(orchestrator.liveWorkerSessionIds()).toHaveLength(3);
    });
    expect(orchestrator.liveWorkerSessionIds()).not.toContain("session-a");
    orchestrator.destroy();
  });

  it("pauses all live workers and resumes only the visible session", async () => {
    const orchestrator = createSessionStreamOrchestrator();
    orchestrator.attach("session-a", { ...defaultOptions("session-a"), autoConnect: true });
    orchestrator.attach("session-b", { ...defaultOptions("session-b"), autoConnect: true });
    await vi.waitFor(() => {
      expect(mocks.wireConnect).toHaveBeenCalledTimes(2);
    });
    await flushPromises();

    mocks.wireDisconnect.mockClear();
    orchestrator.setPaused(true);
    await flushPromises();
    expect(mocks.wireDisconnect).toHaveBeenCalledTimes(2);
    expect(orchestrator.liveWorkerSessionIds()).toHaveLength(0);
    // View state survives the pause.
    expect(orchestrator.getSnapshot().messages).toEqual([]);

    mocks.wireConnect.mockClear();
    orchestrator.setPaused(false);
    await flushPromises();
    // Only the visible session (b) reconnects.
    expect(mocks.wireConnect).toHaveBeenCalledTimes(1);
    expect(mocks.wireConnect.mock.calls[0]?.[0]).toBe("session-b");
    orchestrator.destroy();
  });

  it("lazily creates runtimes for actions without starting them", async () => {
    const orchestrator = createSessionStreamOrchestrator();
    const actions = orchestrator.actionsFor("session-x", defaultOptions("session-x"));
    expect(typeof actions.sendMessage).toBe("function");
    // Not visible -> snapshot stays empty.
    expect(orchestrator.getSnapshot().messages).toEqual([]);
    expect(orchestrator.liveWorkerSessionIds()).toEqual([]);

    // No-op actions for a null session.
    const nullActions = orchestrator.actionsFor(null, defaultOptions(null));
    await expect(nullActions.sendMessage("hi")).resolves.toBeUndefined();
    orchestrator.destroy();
  });

  it("reconnectSessions gap-fills restarted workers without touching others", async () => {
    const orchestrator = createSessionStreamOrchestrator();
    orchestrator.attach("session-a", { ...defaultOptions("session-a"), autoConnect: true });
    orchestrator.attach("session-b", { ...defaultOptions("session-b"), autoConnect: true });
    await vi.waitFor(() => {
      expect(mocks.wireConnect).toHaveBeenCalledTimes(2);
    });
    completeReplayFor("session-a");
    completeReplayFor("session-b");
    await flushPromises();

    mocks.wireConnect.mockClear();
    mocks.wireDisconnect.mockClear();
    orchestrator.reconnectSessions(["session-a", "session-unknown"]);
    await flushPromises();

    // session-a gets a fresh connect (old connection closed first); the
    // unknown session is ignored; session-b is untouched.
    expect(mocks.wireDisconnect).toHaveBeenCalledTimes(1);
    expect(mocks.wireDisconnect.mock.calls[0]?.[0]).toBe("session-a");
    expect(mocks.wireConnect).toHaveBeenCalledTimes(1);
    expect(mocks.wireConnect.mock.calls[0]?.[0]).toBe("session-a");
    orchestrator.destroy();
  });

  it("tears down runtimes on disconnectSession and unregisters on destroy", () => {
    const orchestrator = createSessionStreamOrchestrator();
    orchestrator.attach("session-a", defaultOptions("session-a"));
    orchestrator.disconnectSession("session-a", "delete");
    expect(orchestrator.getSnapshot().messages).toEqual([]);

    orchestrator.attach("session-b", defaultOptions("session-b"));
    const unsubscribe = orchestrator.subscribe(() => undefined);
    unsubscribe();
    orchestrator.destroy();
    expect(globalWireHandler).toBeNull();
  });
});
