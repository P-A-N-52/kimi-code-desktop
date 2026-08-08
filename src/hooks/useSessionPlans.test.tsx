import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPlan } from "@/lib/git-workspace";
import { useSessionPlans } from "./useSessionPlans";

const mocks = vi.hoisted(() => ({
  getSessionPlan: vi.fn(),
  listSessionPlans: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
  getSessionPlan: mocks.getSessionPlan,
  listSessionPlans: mocks.listSessionPlans,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const metadata = (modifiedMs: number, size: number): SessionPlan => ({
  id: "plan.md",
  title: "Plan",
  modifiedMs,
  size,
});

describe("useSessionPlans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps list and content request generations independent", async () => {
    const content = deferred<SessionPlan>();
    const refreshedList = deferred<SessionPlan[]>();
    mocks.listSessionPlans
      .mockResolvedValueOnce([metadata(1, 10)])
      .mockReturnValueOnce(refreshedList.promise);
    mocks.getSessionPlan.mockReturnValue(content.promise);
    const { result } = renderHook(() => useSessionPlans("session-1"));
    await waitFor(() => expect(result.current.plans).toHaveLength(1));

    let openPromise!: Promise<SessionPlan | null>;
    act(() => {
      openPromise = result.current.open("plan.md");
      void result.current.refresh();
    });
    await act(async () => refreshedList.resolve([metadata(1, 10)]));
    expect(mocks.getSessionPlan).toHaveBeenCalledTimes(1);
    await act(async () => {
      content.resolve({ ...metadata(0, 0), content: "content-v1" });
      await openPromise;
    });
    expect(result.current.selected?.content).toBe("content-v1");
    expect(mocks.getSessionPlan).toHaveBeenCalledTimes(1);
  });

  it("invalidates modified content and reloads the open plan", async () => {
    const reloaded = deferred<SessionPlan>();
    mocks.listSessionPlans
      .mockResolvedValueOnce([metadata(1, 10)])
      .mockResolvedValueOnce([metadata(2, 20)]);
    mocks.getSessionPlan
      .mockResolvedValueOnce({ ...metadata(0, 0), content: "content-v1" })
      .mockReturnValueOnce(reloaded.promise);
    const { result } = renderHook(() => useSessionPlans("session-1"));
    await waitFor(() => expect(result.current.plans[0]?.modifiedMs).toBe(1));
    await act(async () => {
      await result.current.open("plan.md");
    });
    expect(result.current.selected?.content).toBe("content-v1");

    await act(async () => {
      await result.current.refresh();
    });
    expect(mocks.getSessionPlan).toHaveBeenCalledTimes(2);
    expect(result.current.contentLoading).toBe(true);

    await act(async () => reloaded.resolve({ ...metadata(0, 0), content: "content-v2" }));
    await waitFor(() => expect(result.current.selected?.content).toBe("content-v2"));
    expect(result.current.selected).toMatchObject({ modifiedMs: 2, size: 20 });
  });

  it("ignores late list and content responses after a session switch", async () => {
    const listOne = deferred<SessionPlan[]>();
    const listTwo = deferred<SessionPlan[]>();
    const contentOne = deferred<SessionPlan>();
    mocks.listSessionPlans.mockReturnValueOnce(listOne.promise).mockReturnValueOnce(listTwo.promise);
    mocks.getSessionPlan.mockReturnValue(contentOne.promise);
    const { result, rerender } = renderHook(
      ({ sessionId }) => useSessionPlans(sessionId),
      { initialProps: { sessionId: "session-1" } },
    );
    act(() => {
      void result.current.open("plan.md");
    });
    rerender({ sessionId: "session-2" });

    await act(async () => {
      listOne.resolve([metadata(1, 10)]);
      contentOne.resolve({ ...metadata(0, 0), content: "stale" });
    });
    expect(result.current.plans).toEqual([]);
    expect(result.current.selected).toBeNull();

    await act(async () => listTwo.resolve([{ ...metadata(3, 30), title: "Current" }]));
    await waitFor(() => expect(result.current.plans[0]?.title).toBe("Current"));
    expect(result.current.selected).toBeNull();
  });
});
