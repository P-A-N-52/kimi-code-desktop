import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: invokeMock,
}));

import { wireListWorkers } from "./tauri-api";

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
