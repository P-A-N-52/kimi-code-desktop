import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/api/models";
import { UiLanguageProvider } from "@/lib/i18n";
import { useSessions } from "./useSessions";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  listSessions: vi.fn(),
}));

vi.mock("../lib/tauri-api", () => ({
  isTauri: mocks.isTauri,
  createSession: vi.fn(),
  deleteUploadedFile: vi.fn(),
  deleteSession: vi.fn(),
  forkSession: vi.fn(),
  getSession: vi.fn(),
  getSessionFile: vi.fn(),
  getStartupDir: vi.fn(),
  listSessionDirectory: vi.fn(),
  listSessions: mocks.listSessions,
  listWorkDirs: vi.fn(),
  updateSession: vi.fn(),
  uploadSessionFile: vi.fn(),
}));

vi.mock("../lib/apiClient", () => ({
  apiClient: {
    sessions: {
      listSessionsApiSessionsGet: vi.fn(),
    },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

function session(id: string, archived = false): Session {
  return {
    sessionId: id,
    title: id,
    lastUpdated: new Date("2026-01-01T00:00:00Z"),
    isRunning: false,
    archived,
  };
}

function I18nWrapper({ children }: { children: ReactNode }) {
  return <UiLanguageProvider>{children}</UiLanguageProvider>;
}

describe("useSessions archived preload", () => {
  let idleCallbacks: IdleRequestCallback[];

  beforeEach(() => {
    idleCallbacks = [];
    window.requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    });
    window.cancelIdleCallback = vi.fn();
    mocks.isTauri.mockReturnValue(true);
    mocks.listSessions.mockReset();
  });

  async function runIdleCallbacks() {
    const callbacks = idleCallbacks.splice(0);
    await act(async () => {
      callbacks.forEach((callback) => {
        callback({
          didTimeout: false,
          timeRemaining: () => 50,
        });
      });
    });
  }

  it("preloads the first archived page after active sessions load", async () => {
    mocks.listSessions.mockImplementation((args?: { archived?: boolean }) =>
      Promise.resolve(args?.archived ? [session("archived", true)] : [session("active")]),
    );

    const { result } = renderHook(() => useSessions(), { wrapper: I18nWrapper });

    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    expect(result.current.hasLoadedArchivedSessions).toBe(false);

    await runIdleCallbacks();

    await waitFor(() => {
      expect(result.current.hasLoadedArchivedSessions).toBe(true);
      expect(result.current.archivedSessions).toHaveLength(1);
    });
    expect(mocks.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ archived: true, limit: 500 }),
    );
  });

  it("does not retry archived preload in the background after a failed preload", async () => {
    mocks.listSessions.mockImplementation((args?: { archived?: boolean }) => {
      if (args?.archived) {
        return Promise.reject(new Error("archived unavailable"));
      }
      return Promise.resolve([session("active")]);
    });

    const { result } = renderHook(() => useSessions(), { wrapper: I18nWrapper });

    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    await runIdleCallbacks();
    await waitFor(() => expect(mocks.listSessions).toHaveBeenCalledTimes(2));

    await runIdleCallbacks();
    expect(mocks.listSessions).toHaveBeenCalledTimes(2);
  });

  it("allows archived sessions to be retried explicitly after preload fails", async () => {
    let archivedAttempts = 0;
    mocks.listSessions.mockImplementation((args?: { archived?: boolean }) => {
      if (args?.archived) {
        archivedAttempts += 1;
        if (archivedAttempts === 1) {
          return Promise.reject(new Error("archived unavailable"));
        }
        return Promise.resolve([session("archived", true)]);
      }
      return Promise.resolve([session("active")]);
    });

    const { result } = renderHook(() => useSessions(), { wrapper: I18nWrapper });

    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    await runIdleCallbacks();
    await waitFor(() => expect(archivedAttempts).toBe(1));
    expect(result.current.hasLoadedArchivedSessions).toBe(false);

    await act(async () => {
      await result.current.refreshArchivedSessions();
    });

    expect(result.current.hasLoadedArchivedSessions).toBe(true);
    expect(result.current.archivedSessions).toHaveLength(1);
  });

  it("filters search client-side without refetching on each keystroke", async () => {
    mocks.listSessions.mockResolvedValue([session("initial")]);

    const { result } = renderHook(() => useSessions(), { wrapper: I18nWrapper });
    await waitFor(() => expect(result.current.sessions[0]?.sessionId).toBe("initial"));
    const callsAfterLoad = mocks.listSessions.mock.calls.length;

    act(() => result.current.setSearchQuery("first"));
    act(() => result.current.setSearchQuery("second"));

    // Search is sidebar-local; typing must not re-hit list_sessions under high latency.
    expect(mocks.listSessions.mock.calls.length).toBe(callsAfterLoad);
    expect(result.current.searchQuery).toBe("second");
  });

  it("updates the running flag immediately from live session status", async () => {
    mocks.listSessions.mockResolvedValue([session("active")]);

    const { result } = renderHook(() => useSessions(), { wrapper: I18nWrapper });
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    act(() => {
      result.current.applySessionStatus({
        sessionId: "active",
        state: "busy",
        seq: 1,
        updatedAt: new Date("2026-08-03T00:00:00Z"),
      });
    });
    expect(result.current.sessions[0]?.isRunning).toBe(true);
    expect(result.current.sessions[0]?.status?.state).toBe("busy");

    act(() => {
      result.current.applySessionStatus({
        sessionId: "active",
        state: "stopped",
        seq: 2,
        updatedAt: new Date("2026-08-03T00:00:01Z"),
      });
    });
    expect(result.current.sessions[0]?.isRunning).toBe(false);
  });

  it("ignores stale refresh results after a newer refresh completes", async () => {
    let resolveFirst: ((value: Session[]) => void) | undefined;
    let resolveSecond: ((value: Session[]) => void) | undefined;
    let call = 0;
    mocks.listSessions.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve([session("initial")]);
      }
      if (call === 2) {
        return new Promise<Session[]>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return new Promise<Session[]>((resolve) => {
        resolveSecond = resolve;
      });
    });

    const { result } = renderHook(() => useSessions(), { wrapper: I18nWrapper });
    await waitFor(() => expect(result.current.sessions[0]?.sessionId).toBe("initial"));

    void act(() => {
      void result.current.refreshSessions();
    });
    await waitFor(() => expect(resolveFirst).toBeTypeOf("function"));
    void act(() => {
      void result.current.refreshSessions();
    });
    await waitFor(() => expect(resolveSecond).toBeTypeOf("function"));

    await act(async () => resolveSecond?.([session("second-result")]));
    await waitFor(() => expect(result.current.sessions[0]?.sessionId).toBe("second-result"));
    await act(async () => resolveFirst?.([session("stale-first-result")]));

    expect(result.current.sessions[0]?.sessionId).toBe("second-result");
  });
});
