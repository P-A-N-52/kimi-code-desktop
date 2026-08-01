import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setCustomSubagentsEnabled } from "@/lib/features";
import { useSessionInfluence } from "./useSessionInfluence";

const { getSessionInfluenceSnapshotMock, isTauriMock } = vi.hoisted(() => ({
  getSessionInfluenceSnapshotMock: vi.fn(),
  isTauriMock: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
  getSessionInfluenceSnapshot: getSessionInfluenceSnapshotMock,
  isTauri: isTauriMock,
}));

const SNAPSHOT = {
  plugins: [{ id: "demo-plugin", enabledInConfig: true }],
  skills: [{ name: "review", source: "user" }],
  agents: [
    {
      name: "reviewer",
      sourceScope: "project",
      sourceLabel: "project:.kimi-code/agents",
    },
  ],
};

describe("useSessionInfluence custom Agent discovery", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true);
    window.localStorage.clear();
    getSessionInfluenceSnapshotMock.mockReset();
    getSessionInfluenceSnapshotMock.mockResolvedValue(SNAPSHOT);
  });

  it("keeps Plugins and Skills while requesting without custom Agents by default", async () => {
    const { result } = renderHook(() =>
      useSessionInfluence({ workDir: "C:/workspace/project" }),
    );

    await waitFor(() => {
      expect(getSessionInfluenceSnapshotMock).toHaveBeenCalledWith("C:/workspace/project", false);
      expect(result.current.snapshot.plugins).toHaveLength(1);
      expect(result.current.snapshot.skills).toHaveLength(1);
      expect(result.current.snapshot.agents).toEqual([]);
      expect(result.current.customSubagentsEnabled).toBe(false);
    });
  });

  it("refetches immediately when the setting changes and only then shows Agents", async () => {
    const { result } = renderHook(() =>
      useSessionInfluence({ workDir: "C:/workspace/project" }),
    );

    await waitFor(() => {
      expect(getSessionInfluenceSnapshotMock).toHaveBeenLastCalledWith(
        "C:/workspace/project",
        false,
      );
    });

    act(() => {
      setCustomSubagentsEnabled(true);
    });

    await waitFor(() => {
      expect(getSessionInfluenceSnapshotMock).toHaveBeenLastCalledWith(
        "C:/workspace/project",
        true,
      );
      expect(result.current.customSubagentsEnabled).toBe(true);
      expect(result.current.snapshot.agents).toHaveLength(1);
    });

    expect(result.current.snapshot.plugins).toHaveLength(1);
    expect(result.current.snapshot.skills).toHaveLength(1);

    act(() => {
      setCustomSubagentsEnabled(false);
    });

    await waitFor(() => {
      expect(getSessionInfluenceSnapshotMock).toHaveBeenLastCalledWith(
        "C:/workspace/project",
        false,
      );
      expect(result.current.snapshot.agents).toEqual([]);
    });
  });
});
