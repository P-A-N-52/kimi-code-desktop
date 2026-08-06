import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/api/models";
import { UiLanguageProvider } from "@/lib/i18n";
import { useSessions } from "./useSessions";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  listSessions: vi.fn(),
  updateSession: vi.fn(),
  updateSessionsArchive: vi.fn(),
  updateWorkDirArchive: vi.fn(),
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
  updateSession: mocks.updateSession,
  updateSessionsArchive: mocks.updateSessionsArchive,
  updateWorkDirArchive: mocks.updateWorkDirArchive,
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
    mocks.updateSession.mockReset();
    mocks.updateSessionsArchive.mockReset();
    mocks.updateWorkDirArchive.mockReset();
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

	it("retries archived refresh after an archive races with the preload", async () => {
		let active = true;
		let archivedCall = 0;
		let resolvePreload: ((value: Session[]) => void) | undefined;
		mocks.listSessions.mockImplementation((args?: { archived?: boolean }) => {
			if (!args?.archived) return Promise.resolve(active ? [session("active")] : []);
      archivedCall += 1;
      if (archivedCall === 1) {
        return new Promise<Session[]>((resolve) => {
          resolvePreload = resolve;
        });
			}
			return Promise.resolve([session("active", true)]);
		});
		mocks.updateSession.mockImplementation(async () => {
			active = false;
			return session("active", true);
		});

    const { result } = renderHook(() => useSessions(), { wrapper: I18nWrapper });
    await waitFor(() => expect(result.current.sessions[0]?.sessionId).toBe("active"));
    await runIdleCallbacks();
    await waitFor(() => expect(resolvePreload).toBeTypeOf("function"));

    let archivePromise: Promise<boolean> | undefined;
    await act(async () => {
      archivePromise = result.current.archiveSession("active");
    });

    await act(async () => {
      resolvePreload?.([]);
    });
    await waitFor(() => expect(archivedCall).toBe(2));
    await waitFor(() => expect(result.current.archivedSessions[0]?.sessionId).toBe("active"));

    expect(await archivePromise).toBe(true);
    expect(result.current.sessions).toHaveLength(0);
		expect(result.current.archivedSessions[0]?.archived).toBe(true);
	});

	it("does not let a stale active refresh restore an archived session", async () => {
		let activeCalls = 0;
		let resolveStaleActive: ((value: Session[]) => void) | undefined;
		mocks.listSessions.mockImplementation((args?: { archived?: boolean }) => {
			if (args?.archived) return Promise.resolve([]);
			activeCalls += 1;
			if (activeCalls === 1) return Promise.resolve([session("active")]);
			if (activeCalls === 2) {
				return new Promise<Session[]>((resolve) => {
					resolveStaleActive = resolve;
				});
			}
			return Promise.resolve([]);
		});
		mocks.updateSession.mockResolvedValue(session("active", true));

		const { result } = renderHook(() => useSessions(), { wrapper: I18nWrapper });
		await waitFor(() => expect(result.current.sessions[0]?.sessionId).toBe("active"));

		act(() => {
			void result.current.refreshSessions();
		});
		await waitFor(() => expect(resolveStaleActive).toBeTypeOf("function"));

		let archivePromise: Promise<boolean> | undefined;
		await act(async () => {
			archivePromise = result.current.archiveSession("active");
		});
		await waitFor(() => expect(activeCalls).toBe(3));
		await act(async () => resolveStaleActive?.([session("active")]));

		expect(await archivePromise).toBe(true);
		expect(result.current.sessions).toEqual([]);
	});

	it("does not restore a session into archived after a stale refresh", async () => {
    let active = [session("other")];
    let archived = [session("restored", true)];
    let archivedCall = 0;
    let resolvePreload: ((value: Session[]) => void) | undefined;
    mocks.listSessions.mockImplementation((args?: { archived?: boolean }) => {
      if (!args?.archived) return Promise.resolve([...active]);
      archivedCall += 1;
      if (archivedCall === 1) {
        return new Promise<Session[]>((resolve) => {
          resolvePreload = resolve;
        });
      }
      return Promise.resolve([...archived]);
    });
    mocks.updateSession.mockImplementation(
      async ({ sessionId, archived: nextArchived }: { sessionId: string; archived: boolean }) => {
        const target = archived.find((item) => item.sessionId === sessionId);
        archived = archived.filter((item) => item.sessionId !== sessionId);
        if (target && !nextArchived) {
          active = [...active, { ...target, archived: false }];
        }
        return session(sessionId, nextArchived);
      },
    );

    const { result } = renderHook(() => useSessions(), { wrapper: I18nWrapper });
    await waitFor(() => expect(result.current.sessions[0]?.sessionId).toBe("other"));
    await runIdleCallbacks();
    await waitFor(() => expect(resolvePreload).toBeTypeOf("function"));

    let restorePromise: Promise<boolean> | undefined;
    await act(async () => {
      restorePromise = result.current.unarchiveSession("restored");
    });

    await act(async () => {
      resolvePreload?.([session("restored", true)]);
    });
    await waitFor(() => expect(archivedCall).toBe(2));
    await waitFor(() => expect(result.current.archivedSessions).toHaveLength(0));

    expect(await restorePromise).toBe(true);
    expect(result.current.sessions.map((item) => item.sessionId)).toEqual(["other", "restored"]);
  });

  it("keeps active and archived lists consistent for single, bulk, and restore actions", async () => {
    let active = [session("one"), session("two")];
    let archived = [session("old", true)];
    mocks.listSessions.mockImplementation((args?: { archived?: boolean }) =>
      Promise.resolve(args?.archived ? [...archived] : [...active]),
    );
    mocks.updateSession.mockImplementation(
      async ({ sessionId, archived: nextArchived }: { sessionId: string; archived: boolean }) => {
        if (nextArchived) {
          const target = active.find((item) => item.sessionId === sessionId);
          active = active.filter((item) => item.sessionId !== sessionId);
          if (target) archived = [...archived, { ...target, archived: true }];
        } else {
          const target = archived.find((item) => item.sessionId === sessionId);
          archived = archived.filter((item) => item.sessionId !== sessionId);
          if (target) active = [...active, { ...target, archived: false }];
        }
        return session(sessionId, nextArchived);
      },
    );

    const { result } = renderHook(() => useSessions(), { wrapper: I18nWrapper });
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));

    await act(async () => {
      expect(await result.current.archiveSession("one")).toBe(true);
    });
    expect(result.current.sessions.map((item) => item.sessionId)).toEqual(["two"]);
    expect(result.current.archivedSessions.map((item) => item.sessionId)).toEqual(["old", "one"]);

    await act(async () => {
      expect(await result.current.bulkArchiveSessions(["two"])).toBe(1);
    });
    expect(result.current.sessions).toHaveLength(0);
    expect(result.current.archivedSessions.map((item) => item.sessionId)).toEqual([
      "old",
      "one",
      "two",
    ]);

    await act(async () => {
      expect(await result.current.unarchiveSession("one")).toBe(true);
    });
    expect(result.current.sessions.map((item) => item.sessionId)).toEqual(["one"]);
    expect(result.current.archivedSessions.map((item) => item.sessionId)).toEqual(["old", "two"]);

    await act(async () => {
      expect(await result.current.bulkUnarchiveSessions(["two"])).toBe(1);
    });
    expect(result.current.sessions.map((item) => item.sessionId)).toEqual(["one", "two"]);
    expect(result.current.archivedSessions.map((item) => item.sessionId)).toEqual(["old"]);
  });

  it("updates a complete project group through the workDir archive API", async () => {
    let active = [session("one"), session("two")];
    let archived: Session[] = [];
    mocks.listSessions.mockImplementation((args?: { archived?: boolean }) =>
      Promise.resolve(args?.archived ? [...archived] : [...active]),
    );
    mocks.updateWorkDirArchive.mockImplementation(
      async (_workDir: string, nextArchived: boolean, sessionIds: string[]) => {
        const moved = nextArchived ? active : archived;
        if (nextArchived) {
          active = [];
          archived = [...archived, ...moved.map((item) => ({ ...item, archived: true }))];
        } else {
          archived = [];
          active = moved.map((item) => ({ ...item, archived: false }));
        }
        return [...sessionIds, ...archived.map((item) => item.sessionId)].filter(
          (id, index, all) => all.indexOf(id) === index,
        );
      },
    );

    const { result } = renderHook(() => useSessions(), { wrapper: I18nWrapper });
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));

    await act(async () => {
      expect(
        await result.current.archiveProjectSessions(["one", "two"], true, "/workspace/demo"),
      ).toBe(2);
    });

    expect(mocks.updateWorkDirArchive).toHaveBeenCalledWith("/workspace/demo", true, [
      "one",
      "two",
    ]);
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(result.current.sessions).toHaveLength(0);
    expect(result.current.archivedSessions.map((item) => item.sessionId)).toEqual(["one", "two"]);
  });

  it("archives every session on a project workDir, including sessions outside the visible list", async () => {
    const first = { ...session("one"), workDir: "/workspace/demo" };
    const second = { ...session("two"), workDir: "/workspace/demo" };
    const alreadyArchived = { ...session("old", true), workDir: "/workspace/demo" };
    let active = [first, second];
    let archived = [alreadyArchived];
    mocks.listSessions.mockImplementation((args?: { archived?: boolean }) =>
      Promise.resolve(args?.archived ? [...archived] : [...active]),
    );
    mocks.updateWorkDirArchive.mockImplementation(
      async (_workDir: string, nextArchived: boolean) => {
        if (nextArchived) {
          archived = [...archived, ...active.map((item) => ({ ...item, archived: true }))];
          active = [];
        } else {
          active = [...active, ...archived.map((item) => ({ ...item, archived: false }))];
          archived = [];
        }
        return [...active, ...archived].map((item) => item.sessionId);
      },
    );

    const { result } = renderHook(() => useSessions(), { wrapper: I18nWrapper });
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));

    await act(async () => {
      expect(
        await result.current.archiveProjectSessions(["one", "two"], true, "/workspace/demo"),
      ).toBe(3);
    });

    expect(mocks.updateWorkDirArchive).toHaveBeenCalledWith("/workspace/demo", true, [
      "one",
      "two",
    ]);
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(result.current.sessions).toHaveLength(0);
    expect(result.current.archivedSessions.map((item) => item.sessionId)).toEqual([
      "old",
      "one",
      "two",
    ]);
  });

  it("falls back to visible project IDs when a complete project refresh is unavailable", async () => {
    const first = { ...session("one"), workDir: "/workspace/demo" };
    const second = { ...session("two"), workDir: "/workspace/demo" };
    mocks.listSessions.mockImplementation((args?: { archived?: boolean }) =>
      args?.archived
        ? Promise.reject(new Error("archived list unavailable"))
        : Promise.resolve([first, second]),
    );
    mocks.updateWorkDirArchive.mockResolvedValue(["one", "two"]);

    const { result } = renderHook(() => useSessions(), { wrapper: I18nWrapper });
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));

    await act(async () => {
      expect(await result.current.archiveProjectSessions(["one", "two"], true)).toBe(2);
    });

    expect(mocks.updateWorkDirArchive).toHaveBeenCalledWith("/workspace/demo", true, [
      "one",
      "two",
    ]);
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it("restores only archived sessions from a complete project", async () => {
    const active = { ...session("active"), workDir: "/workspace/demo" };
    const archived = { ...session("archived", true), workDir: "/workspace/demo" };
    let activeSessions: Session[] = [active];
    let archivedSessions: Session[] = [archived];
    mocks.listSessions.mockImplementation((args?: { archived?: boolean }) =>
      Promise.resolve(args?.archived ? [...archivedSessions] : [...activeSessions]),
    );
    mocks.updateWorkDirArchive.mockImplementation(
      async (_workDir: string, nextArchived: boolean) => {
        if (nextArchived) {
          archivedSessions = [
            ...archivedSessions,
            ...activeSessions.map((item) => ({ ...item, archived: true })),
          ];
          activeSessions = [];
        } else {
          activeSessions = [
            ...activeSessions,
            ...archivedSessions.map((item) => ({ ...item, archived: false })),
          ];
          archivedSessions = [];
        }
        return [...activeSessions, ...archivedSessions].map((item) => item.sessionId);
      },
    );

    const { result } = renderHook(() => useSessions(), { wrapper: I18nWrapper });
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    await act(async () => {
      expect(
        await result.current.archiveProjectSessions(["archived"], false, "/workspace/demo"),
      ).toBe(2);
    });

    expect(mocks.updateWorkDirArchive).toHaveBeenCalledWith("/workspace/demo", false, ["archived"]);
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(result.current.sessions.map((item) => item.sessionId)).toEqual(["active", "archived"]);
    expect(result.current.archivedSessions).toEqual([]);
  });

  it("passes visible project IDs as the native command fallback anchor", async () => {
    const first = { ...session("one"), workDir: "/workspace/demo" };
    const second = { ...session("two"), workDir: "/workspace/demo" };
    mocks.listSessions.mockImplementation((args?: { archived?: boolean }) =>
      Promise.resolve(args?.archived ? [] : [first, second]),
    );
    mocks.updateWorkDirArchive.mockResolvedValue(["one", "two"]);

    const { result } = renderHook(() => useSessions(), { wrapper: I18nWrapper });
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));

    await act(async () => {
      expect(
        await result.current.archiveProjectSessions(["one", "two"], true, "/workspace/demo"),
      ).toBe(2);
    });

    expect(mocks.updateWorkDirArchive).toHaveBeenCalledWith("/workspace/demo", true, [
      "one",
      "two",
    ]);
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it("keeps the complete project unchanged when the native command rejects a busy session", async () => {
    const busy = {
      ...session("busy"),
      workDir: "/workspace/demo",
      status: {
        sessionId: "busy",
        state: "busy" as const,
        seq: 1,
        updatedAt: new Date(),
      },
    };
    const idle = { ...session("idle"), workDir: "/workspace/demo" };
    const active: Session[] = [busy, idle];
    const archived: Session[] = [];
    mocks.listSessions.mockImplementation((args?: { archived?: boolean }) =>
      Promise.resolve(args?.archived ? [...archived] : [...active]),
    );
    mocks.updateWorkDirArchive.mockRejectedValue(new Error("Session is busy"));

    const { result } = renderHook(() => useSessions(), { wrapper: I18nWrapper });
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));

    await act(async () => {
      expect(
        await result.current.archiveProjectSessions(["busy", "idle"], true, "/workspace/demo"),
      ).toBe(0);
    });

    await waitFor(() => {
      expect(result.current.sessions.map((item) => item.sessionId)).toEqual(["busy", "idle"]);
      expect(result.current.archivedSessions).toEqual([]);
    });
    expect(mocks.updateWorkDirArchive).toHaveBeenCalledWith("/workspace/demo", true, [
      "busy",
      "idle",
    ]);
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });
});
