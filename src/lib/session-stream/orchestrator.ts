/**
 * G5 multi-active-session orchestrator (design `docs/plans/2026-07-31-g5-multi-active-sessions-design.md`
 * §3.1 / §4 / §5 / §9 Phase 1).
 *
 * Owns:
 * - one SessionRuntime per session (`Map<sessionId, runtime>`)
 * - the SINGLE global `wire:message` listener (routers events by session_id)
 * - the visible-session focus switch (running/in-flight sessions are KEPT
 *   alive instead of being disconnected, per §4.2)
 * - the interim live-worker cap (`MAX_LIVE_WORKERS = 3`, §4.4 option A)
 * - the runtime pause/resume contract (§4.6)
 *
 * The orchestrator is framework-agnostic; `SessionStreamOrchestratorProvider`
 * (provider.tsx) binds it to React. `useSessionStream` (flag on) selects the
 * visible snapshot and forwards actions through this object.
 */

import { listenEvent } from "@/lib/tauri-api";
import { emptySessionConfigState } from "@/lib/session-config-state";
import type { LiveMessage } from "@/hooks/types";
import type { UploadSessionFileResponse } from "@/lib/api/models";
import {
  createSessionRuntime,
  type SessionRuntime,
  type SessionRuntimeOptions,
} from "./runtime";
import type { SessionViewState } from "./types";

/** Interim live-worker cap (G5 §4.4 option A). Full LRU lands in Phase 2. */
export const MAX_LIVE_WORKERS = 3;

/** Reference-stable snapshot used when no session is visible. */
export const EMPTY_SESSION_VIEW: SessionViewState = {
  messages: [],
  status: "ready",
  sessionStatus: null,
  isReplayingHistory: false,
  isAwaitingFirstResponse: false,
  canCancel: false,
  contextUsage: 0,
  contextTokens: null,
  maxContextTokens: null,
  tokenUsage: null,
  currentStep: 0,
  goalCompletionEpoch: 0,
  isConnected: false,
  error: null,
  planMode: false,
  permissionMode: "manual",
  swarmMode: false,
  goalMode: false,
  slashCommands: [],
  sessionConfigState: emptySessionConfigState(""),
  sessionConfigUpdating: false,
  connectionPhase: "disconnected",
  connectionId: null,
  lastEventAt: 0,
  updatedAt: 0,
};

/**
 * Action surface of one session runtime, mirroring the action fields of
 * `UseSessionStreamReturn` (without the state fields).
 */
export type SessionRuntimeActions = {
  sendMessage: (
    text: string,
    attachments?: UploadSessionFileResponse[],
    options?: Parameters<SessionRuntime["sendMessage"]>[2],
  ) => ReturnType<SessionRuntime["sendMessage"]>;
  runLocalInfoCommand: SessionRuntime["runLocalInfoCommand"];
  respondToApproval: SessionRuntime["respondToApproval"];
  respondToQuestion: SessionRuntime["respondToQuestion"];
  controlGoal: SessionRuntime["controlGoal"];
  cancel: SessionRuntime["cancel"];
  disconnect: SessionRuntime["disconnect"];
  reconnect: SessionRuntime["reconnect"];
  connect: SessionRuntime["connect"];
  setMessages: (action: LiveMessage[] | ((prev: LiveMessage[]) => LiveMessage[])) => void;
  clearMessages: SessionRuntime["clearMessages"];
  sendSetPlanMode: SessionRuntime["sendSetPlanMode"];
  sendSetPermissionMode: SessionRuntime["sendSetPermissionMode"];
  sendSetSwarmMode: SessionRuntime["sendSetSwarmMode"];
  sendSetGoalMode: SessionRuntime["sendSetGoalMode"];
  sendSetConfigOption: SessionRuntime["sendSetConfigOption"];
};

type OrchestratorEntry = {
  runtime: SessionRuntime;
  lastVisibleAt: number;
};

export type SessionStreamOrchestrator = {
  /** Subscribe to visible-snapshot changes. */
  subscribe: (listener: () => void) => () => void;
  /**
   * Reference-stable snapshot of the visible session; `EMPTY_SESSION_VIEW`
   * (same reference) when no session is visible.
   */
  getSnapshot: () => SessionViewState;
  /**
   * Ensure a runtime exists for `sessionId` (created + started exactly once),
   * then mark it visible. A visible autoConnect session that is currently
   * disconnected gets reconnected here (switch-back path).
   */
  attach: (sessionId: string | null, options: SessionRuntimeOptions) => void;
  /**
   * Actions bound to `sessionId`, lazily creating (but not starting) the
   * runtime when needed. Returns no-op actions for a null session.
   */
  actionsFor: (sessionId: string | null, options: SessionRuntimeOptions) => SessionRuntimeActions;
  /** Pause (disconnect all live workers) / resume (reconnect visible running only). */
  setPaused: (paused: boolean) => void;
  /**
   * Force-reconnect the given sessions (G5 §4.8): closes any existing
   * connection and starts a fresh connect chain, which replays history into
   * the same runtime (gap fill) — used after a config-triggered worker
   * restart. Sessions without a runtime are ignored.
   */
  reconnectSessions: (sessionIds: string[]) => void;
  /** Hard teardown for session deletion: stop runtime and drop its view state. */
  disconnectSession: (sessionId: string, reason: string) => void;
  /** Unregister the global listener and disconnect all workers (no store cleanup). */
  destroy: () => void;
  /** Live-worker observation (G5 §10.2): session ids of currently live runtimes. */
  liveWorkerSessionIds: () => string[];
};

export function createSessionStreamOrchestrator(): SessionStreamOrchestrator {
  const runtimes = new Map<string, OrchestratorEntry>();
  let visibleSessionId: string | null = null;
  let paused = false;
  let unlistenGlobal: (() => void) | null = null;

  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const isLive = (snapshot: SessionViewState): boolean =>
    snapshot.isConnected ||
    snapshot.connectionPhase === "connecting" ||
    snapshot.connectionPhase === "reconnecting";

  const getOrCreate = (sessionId: string, options: SessionRuntimeOptions) => {
    const existing = runtimes.get(sessionId);
    if (existing) {
      existing.runtime.updateOptions(options);
      return { runtime: existing.runtime, created: false };
    }
    const runtime = createSessionRuntime({
      ...options,
      registerPerSessionListener: false,
    });
    runtimes.set(sessionId, { runtime, lastVisibleAt: Date.now() });
    runtime.subscribe(() => {
      // Forward engine updates only while this session is on screen.
      if (visibleSessionId === sessionId) {
        emit();
      }
    });
    return { runtime, created: true };
  };

  // Single global wire:message listener (G5 §5.5): route by session_id, drop
  // events for sessions without a runtime. Registered exactly once at creation.
  unlistenGlobal = listenEvent("wire:message", (payload) => {
    const eventPayload = payload as { session_id?: unknown; message?: unknown } | undefined;
    if (
      !eventPayload ||
      typeof eventPayload.session_id !== "string" ||
      typeof eventPayload.message !== "string"
    ) {
      return;
    }
    const entry = runtimes.get(eventPayload.session_id);
    if (!entry) {
      return;
    }
    entry.runtime.handleWireMessage(eventPayload.message);
  });

  const collectLiveSessionIds = (): string[] => {
    const live: string[] = [];
    for (const [sessionId, entry] of runtimes) {
      if (isLive(entry.runtime.getSnapshot())) {
        live.push(sessionId);
      }
    }
    return live.sort();
  };

  const enforceLiveWorkerCap = (pendingLive: string[] = []): void => {
    // `pendingLive` covers sessions whose connect chain just started inside
    // attach(): their connectionPhase is still "disconnected" synchronously.
    const live = [...collectLiveSessionIds()];
    for (const sessionId of pendingLive) {
      if (!live.includes(sessionId)) {
        live.push(sessionId);
      }
    }
    if (live.length <= MAX_LIVE_WORKERS) {
      return;
    }
    // Evict candidates: non-visible, no in-flight prompt, oldest lastVisibleAt.
    const candidates = live
      .filter((sessionId) => sessionId !== visibleSessionId)
      .map((sessionId) => ({
        sessionId,
        entry: runtimes.get(sessionId) as OrchestratorEntry,
      }))
      .filter(({ entry }) => {
        const snapshot = entry.runtime.getSnapshot();
        const inFlight =
          snapshot.status === "streaming" ||
          snapshot.status === "submitted" ||
          snapshot.isAwaitingFirstResponse;
        return !inFlight;
      })
      .sort((a, b) => a.entry.lastVisibleAt - b.entry.lastVisibleAt);
    for (const candidate of candidates) {
      if (live.length <= MAX_LIVE_WORKERS) {
        break;
      }
      candidate.entry.runtime.disconnect();
      live.splice(live.indexOf(candidate.sessionId), 1);
    }
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot(): SessionViewState {
      if (visibleSessionId === null) {
        return EMPTY_SESSION_VIEW;
      }
      const entry = runtimes.get(visibleSessionId);
      return entry ? entry.runtime.getSnapshot() : EMPTY_SESSION_VIEW;
    },

    attach(sessionId: string | null, options: SessionRuntimeOptions): void {
      if (paused) {
        // While paused, only the visible session may (re)connect; it is
        // reconnected on resume by the provider, not here.
        visibleSessionId = sessionId;
        emit();
        return;
      }
      if (sessionId === null) {
        visibleSessionId = null;
        emit();
        return;
      }
      const { runtime, created } = getOrCreate(sessionId, options);
      const entry = runtimes.get(sessionId) as OrchestratorEntry;
      entry.lastVisibleAt = Date.now();
      visibleSessionId = sessionId;
      const wantsLive = Boolean(options.autoConnect);
      if (created) {
        // start() owns the full per-session bootstrap (replay / autoConnect);
        // it must run exactly once so it can never wipe a background state.
        runtime.start();
      } else {
        const snapshot = runtime.getSnapshot();
        // A background worker can still report an in-flight turn after its
        // frontend wire lease was lost. Reconnect it on return regardless of
        // the chat status so the visible timeline catches up instead of
        // remaining frozen and treating the next prompt as a failed queue.
        if (wantsLive && !isLive(snapshot)) {
          runtime.connect();
        }
      }
      enforceLiveWorkerCap(wantsLive && created ? [sessionId] : []);
      emit();
    },

    actionsFor(
      sessionId: string | null,
      options: SessionRuntimeOptions,
    ): SessionRuntimeActions {
      if (sessionId === null) {
        return {
          sendMessage: async () => undefined,
          runLocalInfoCommand: async () => "",
          respondToApproval: async () => undefined,
          respondToQuestion: async () => undefined,
          controlGoal: async () => undefined,
          cancel: () => undefined,
          disconnect: () => undefined,
          reconnect: () => undefined,
          connect: () => undefined,
          setMessages: () => undefined,
          clearMessages: () => undefined,
          sendSetPlanMode: () => false,
          sendSetPermissionMode: () => false,
          sendSetSwarmMode: () => false,
          sendSetGoalMode: () => false,
          sendSetConfigOption: async () => false,
        };
      }
      const { runtime } = getOrCreate(sessionId, options);
      return {
        sendMessage: runtime.sendMessage,
        runLocalInfoCommand: runtime.runLocalInfoCommand,
        respondToApproval: runtime.respondToApproval,
        respondToQuestion: runtime.respondToQuestion,
        controlGoal: runtime.controlGoal,
        cancel: runtime.cancel,
        disconnect: runtime.disconnect,
        reconnect: runtime.reconnect,
        connect: runtime.connect,
        setMessages: runtime.setMessages,
        clearMessages: runtime.clearMessages,
        sendSetPlanMode: runtime.sendSetPlanMode,
        sendSetPermissionMode: runtime.sendSetPermissionMode,
        sendSetSwarmMode: runtime.sendSetSwarmMode,
        sendSetGoalMode: runtime.sendSetGoalMode,
        sendSetConfigOption: runtime.sendSetConfigOption,
      };
    },

    setPaused(nextPaused: boolean): void {
      if (nextPaused === paused) {
        return;
      }
      paused = nextPaused;
      if (nextPaused) {
        // Pause: disconnect every live worker; view states stay cached.
        for (const entry of runtimes.values()) {
          if (isLive(entry.runtime.getSnapshot())) {
            entry.runtime.disconnect();
          }
        }
      } else {
        // Resume: only the visible autoConnect session may come back (G5 §4.6.3).
        if (visibleSessionId !== null) {
          const entry = runtimes.get(visibleSessionId);
          if (entry) {
            entry.runtime.connect();
          }
        }
      }
      emit();
    },

    reconnectSessions(sessionIds: string[]): void {
      for (const sessionId of sessionIds) {
        const entry = runtimes.get(sessionId);
        if (!entry) {
          continue;
        }
        // connect() closes any existing connection and starts a fresh chain
        // whose replay fills the gap left by the worker restart.
        entry.runtime.connect();
      }
      emit();
    },

    disconnectSession(sessionId: string, reason: string): void {
      const entry = runtimes.get(sessionId);
      if (!entry) {
        return;
      }
      runtimes.delete(sessionId);
      if (visibleSessionId === sessionId) {
        visibleSessionId = null;
      }
      // stop() performs the full per-session teardown (disconnect + store
      // cleanup). The reason is part of the G5 §10.2 observability contract.
      console.log(`[SessionStream] Disconnecting session ${sessionId} (reason: ${reason})`);
      entry.runtime.stop();
      emit();
    },

    destroy(): void {
      if (unlistenGlobal) {
        unlistenGlobal();
        unlistenGlobal = null;
      }
      for (const entry of runtimes.values()) {
        entry.runtime.disconnect();
      }
      runtimes.clear();
      visibleSessionId = null;
      listeners.clear();
    },

    liveWorkerSessionIds(): string[] {
      return collectLiveSessionIds();
    },
  };
}
