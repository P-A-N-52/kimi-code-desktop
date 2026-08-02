import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: invokeMock,
}));

import {
  getSessionInfluenceSnapshot,
  listSessions,
  updateGlobalConfig,
  wireListWorkers,
} from "./tauri-api";

describe("global config IPC", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ config: { models: [] } });
  });

  it("sends the secondary-model experiment and model recipe atomically", async () => {
    await updateGlobalConfig({
      secondaryModelExperimentEnabled: true,
      secondaryModel: "provider/cheap",
    });

    expect(invokeMock).toHaveBeenCalledWith("update_global_config", {
      defaultModel: undefined,
      defaultThinking: undefined,
      thinkingEffort: undefined,
      defaultPlanMode: undefined,
      secondaryModel: "provider/cheap",
      secondaryDefaultEffort: undefined,
      secondaryModelExperimentEnabled: true,
      restartRunningSessions: undefined,
      forceRestartBusySessions: undefined,
    });
  });
});

describe("session influence IPC", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({});
  });

  it("defaults custom Agent discovery to disabled", async () => {
    await getSessionInfluenceSnapshot();

    expect(invokeMock).toHaveBeenCalledWith("get_session_influence_snapshot", {
      workDir: null,
      includeCustomAgents: false,
    });
  });

  it("forwards explicit custom Agent discovery flags", async () => {
    await getSessionInfluenceSnapshot("  C:/workspace  ", true);
    await getSessionInfluenceSnapshot(null, false);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "get_session_influence_snapshot", {
      workDir: "C:/workspace",
      includeCustomAgents: true,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "get_session_influence_snapshot", {
      workDir: null,
      includeCustomAgents: false,
    });
  });
});

describe("wireListWorkers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes the wire_list_workers command", async () => {
    invokeMock.mockResolvedValue([]);
    await wireListWorkers();
    expect(invokeMock).toHaveBeenCalledWith("wire_list_workers");
  });

  it("normalizes snake_case worker views", async () => {
    invokeMock.mockResolvedValue([
      { session_id: "s1", state: "busy", connection_id: "lease-1", updated_at: 123 },
      { session_id: "s2", state: "idle", connection_id: null, updated_at: 456 },
    ]);
    const views = await wireListWorkers();
    expect(views).toEqual([
      { sessionId: "s1", state: "busy", connectionId: "lease-1", updatedAt: 123 },
      { sessionId: "s2", state: "idle", connectionId: null, updatedAt: 456 },
    ]);
  });

  it("keeps a stable contract for missing fields", async () => {
    invokeMock.mockResolvedValue([{ session_id: "s1" }]);
    const views = await wireListWorkers();
    expect(views[0]).toEqual({
      sessionId: "s1",
      state: "unknown",
      connectionId: null,
      updatedAt: 0,
    });
  });
});

describe("listSessions", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("normalizes ISO and epoch-ms last_updated timestamps", async () => {
    invokeMock.mockResolvedValue([
      { session_id: "iso", title: "A", last_updated: "2026-08-01T10:00:00Z" },
      { session_id: "ms", title: "B", last_updated: 1785643566672 },
      { session_id: "missing", title: "C", last_updated: null },
    ]);
    const sessions = await listSessions({});
    expect(sessions[0].lastUpdated.toISOString()).toBe("2026-08-01T10:00:00.000Z");
    expect(sessions[1].lastUpdated.getTime()).toBe(1785643566672);
    expect(Number.isNaN(sessions[2].lastUpdated.getTime())).toBe(false);
  });

  it("falls back to a valid date for unparseable timestamps", async () => {
    invokeMock.mockResolvedValue([
      { session_id: "bad", title: "D", last_updated: "not-a-date" },
    ]);
    const sessions = await listSessions({});
    expect(Number.isNaN(sessions[0].lastUpdated.getTime())).toBe(false);
  });
});
