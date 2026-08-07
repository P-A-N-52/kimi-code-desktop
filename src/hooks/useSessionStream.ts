/**
 * Session stream hook - React adapter over the per-session SessionRuntime engine.
 *
 * -----------------------------------------------------------------------------
 * High-level architecture (read this before editing)
 * -----------------------------------------------------------------------------
 *
 * The live/replay wire normalization moved into `src/lib/session-stream/runtime.ts`
 * (createSessionRuntime). This module is a thin React adapter with two modes:
 *
 * - Single-stream (G5 flag off): one local SessionRuntime per mounted hook,
 *   restarted on session switches — behavior identical to the pre-G5 hook.
 * - Multi-stream (G5 flag on + Tauri): the hook selects the visible session's
 *   snapshot from the SessionStreamOrchestrator and forwards actions to the
 *   per-session runtime owned by the orchestrator. Session lifecycle
 *   (create/start/keep-alive/evict) is owned by the orchestrator; this hook
 *   only marks the session visible on switches.
 *
 * Both modes share one fixed hook skeleton (no conditional hook calls): the
 * store subscription is either the local runtime or the orchestrator, and the
 * layout effect either restarts the local runtime or calls orchestrator.attach.
 *
 * The hard constraint (no cross-session leak) lives in the runtime: session
 * switches must be atomic — stop old stream, clear per-session accumulators,
 * then (optionally) connect to the new session. Wire callbacks are async and
 * can fire after a switch, so every callback guards on connection identity
 * (`wsRef.current !== ws`) — see runtime.ts for details.
 */

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChatStatus } from "ai";
import type { SessionStatus, UploadSessionFileResponse } from "@/lib/api/models";
import { isMultiActiveSessionsEnabled } from "@/lib/features";
import type { SessionConfigState } from "@/lib/session-config-state";
import {
  EMPTY_SESSION_VIEW,
  type SessionRuntimeActions,
} from "@/lib/session-stream/orchestrator";
import { useSessionStreamOrchestrator } from "@/lib/session-stream/provider";
import {
  createSessionRuntime,
  type LocalInfoPanelResult,
  type SendMessageOptions,
  type SendMessageResult,
  type SessionRuntime,
  type SessionRuntimeOptions,
} from "@/lib/session-stream/runtime";
import type { ConnectionPhase, SessionViewState } from "@/lib/session-stream/types";
import type { SlashCommandDef } from "@/lib/slash-command-catalog";
import type { LiveMessage } from "./types";
import type { ApprovalResponseDecision, PermissionMode, TokenUsage } from "./wireTypes";

export type {
  GoalStartConfirmationResult,
  LocalInfoPanelResult,
  SendMessageOptions,
  SendMessageResult,
} from "@/lib/session-stream/runtime";
export { mergeSlashCommandsByName } from "@/lib/session-stream/runtime";
export type { SlashCommandDef } from "@/lib/slash-command-catalog";

type UseSessionStreamOptions = {
  /** Session ID to connect to */
  sessionId: string | null;
  /** Base URL for WebSocket connection (defaults to current host) */
  baseUrl?: string;
  /** Callback when messages change */
  onMessagesChange?: (messages: LiveMessage[]) => void;
  /** Callback when connection status changes */
  onConnectionChange?: (connected: boolean) => void;
  /** Callback when an error occurs */
  onError?: (error: Error) => void;
  /** Callback when session status changes */
  onSessionStatus?: (status: SessionStatus) => void;
  /** Callback when first turn is complete (for auto-renaming) */
  onFirstTurnComplete?: () => void;
  /** Start the live worker as soon as the session is selected. */
  autoConnect?: boolean;
};

export type UseSessionStreamReturn = {
  /** Current messages */
  messages: LiveMessage[];
  /** Chat status */
  status: ChatStatus;
  /** Latest runtime session status snapshot */
  sessionStatus: SessionStatus | null;
  /** Whether the stream is still replaying history */
  isReplayingHistory: boolean;
  /** Whether waiting for the first response after sending a prompt */
  isAwaitingFirstResponse: boolean;
  /** Whether there is a real prompt that can currently be cancelled */
  canCancel: boolean;
  /** Current context usage (0-1) */
  contextUsage: number;
  /** Absolute tokens currently in context, if available */
  contextTokens: number | null;
  /** Context window size in tokens, if available */
  maxContextTokens: number | null;
  /** Current token usage for the active step, if available */
  tokenUsage: TokenUsage | null;
  /** Current step number */
  currentStep: number;
  /** Increments only after a canonical native Goal reaches natural completion. */
  goalCompletionEpoch: number;
  /** Whether connected to the session stream */
  isConnected: boolean;
  /** Send a message to the session (will auto-connect if not connected) */
  sendMessage: (
    text: string,
    attachments?: UploadSessionFileResponse[],
    options?: SendMessageOptions,
  ) => Promise<SendMessageResult>;
  /** Resolve /usage or /status text without writing chat messages */
  runLocalInfoCommand: (command: "usage" | "status") => Promise<string>;
  /** Respond to an approval request */
  respondToApproval: (
    requestId: string,
    response: ApprovalResponseDecision,
    reason?: string,
  ) => Promise<void>;
  /** Respond to a question request */
  respondToQuestion: (requestId: string, answers: Record<string, string>) => Promise<void>;
  /** Control the native Goal lifecycle even while a turn is running. */
  controlGoal: (action: "pause" | "resume" | "cancel") => Promise<LocalInfoPanelResult | undefined>;
  /** Send a cancel request for the current turn */
  cancel: () => void;
  /** Disconnect from the stream */
  disconnect: () => void;
  /** Reconnect to the session */
  reconnect: () => void;
  /** Connect to the session stream */
  connect: () => void;
  /** Set messages directly */
  setMessages: React.Dispatch<React.SetStateAction<LiveMessage[]>>;
  /** Clear all messages */
  clearMessages: () => void;
  /** Connection error if any */
  error: Error | null;
  /** Whether plan mode is active */
  planMode: boolean;
  /** Set plan mode via silent RPC (no context message) */
  sendSetPlanMode: (enabled: boolean) => boolean;
  /** Current approval behavior, independent from Plan mode */
  permissionMode: PermissionMode;
  /** Set the ACP permission mode while preserving Plan mode */
  sendSetPermissionMode: (mode: PermissionMode) => boolean;
  /** Whether coordinated multi-agent execution is active */
  swarmMode: boolean;
  /** Set Swarm mode via silent RPC */
  sendSetSwarmMode: (enabled: boolean) => boolean;
  /** Whether goal-tracking mode is active */
  goalMode: boolean;
  /** Set Goal mode via silent RPC */
  sendSetGoalMode: (enabled: boolean) => boolean;
  /** Available slash commands from the server */
  slashCommands: SlashCommandDef[];
  /** Session-scoped config from ACP (model / thinking / mode) */
  sessionConfigState: SessionConfigState;
  /** Whether a session/set_config_option write is in flight */
  sessionConfigUpdating: boolean;
  /** Change a declared session config option via the wire worker */
  sendSetConfigOption: (configId: string, value: unknown) => Promise<boolean>;
  /** Lifecycle phase of the underlying connection */
  connectionPhase?: ConnectionPhase;
  /** Stable id of the current wire connection attempt (Tauri), if any */
  connectionId?: string | null;
  /** Timestamp (ms) of the last snapshot update */
  updatedAt?: number;
};

function buildStreamReturn(
  snapshot: SessionViewState,
  actions: SessionRuntimeActions,
): UseSessionStreamReturn {
  return {
    messages: snapshot.messages,
    status: snapshot.status,
    sessionStatus: snapshot.sessionStatus,
    isAwaitingFirstResponse: snapshot.isAwaitingFirstResponse,
    canCancel: snapshot.canCancel,
    contextUsage: snapshot.contextUsage,
    contextTokens: snapshot.contextTokens,
    maxContextTokens: snapshot.maxContextTokens,
    tokenUsage: snapshot.tokenUsage,
    currentStep: snapshot.currentStep,
    goalCompletionEpoch: snapshot.goalCompletionEpoch,
    isConnected: snapshot.isConnected,
    isReplayingHistory: snapshot.isReplayingHistory,
    sendMessage: actions.sendMessage,
    controlGoal: actions.controlGoal,
    runLocalInfoCommand: actions.runLocalInfoCommand,
    respondToApproval: actions.respondToApproval,
    respondToQuestion: actions.respondToQuestion,
    cancel: actions.cancel,
    disconnect: actions.disconnect,
    reconnect: actions.reconnect,
    connect: actions.connect,
    setMessages: actions.setMessages,
    clearMessages: actions.clearMessages,
    error: snapshot.error,
    planMode: snapshot.planMode,
    sendSetPlanMode: actions.sendSetPlanMode,
    permissionMode: snapshot.permissionMode,
    sendSetPermissionMode: actions.sendSetPermissionMode,
    swarmMode: snapshot.swarmMode,
    sendSetSwarmMode: actions.sendSetSwarmMode,
    goalMode: snapshot.goalMode,
    sendSetGoalMode: actions.sendSetGoalMode,
    slashCommands: snapshot.slashCommands,
    sessionConfigState: snapshot.sessionConfigState,
    sessionConfigUpdating: snapshot.sessionConfigUpdating,
    sendSetConfigOption: actions.sendSetConfigOption,
    connectionPhase: snapshot.connectionPhase,
    connectionId: snapshot.connectionId,
    updatedAt: snapshot.updatedAt,
  };
}

const NOOP_SUBSCRIBE = (): (() => void) => () => undefined;
const NOOP_GET_SNAPSHOT = (): SessionViewState => EMPTY_SESSION_VIEW;

/**
 * Hook for connecting to a session's WebSocket stream.
 *
 * The multi-active-session mode (G5 flag on + Tauri) is captured once per
 * mounted hook — the flag only changes on a full reload, so the selected mode
 * (and therefore the hook call shape) stays stable across renders.
 */
export function useSessionStream(options: UseSessionStreamOptions): UseSessionStreamReturn {
  const orchestrator = useSessionStreamOrchestrator();
  const [useMulti] = useState(
    () => orchestrator !== null && isMultiActiveSessionsEnabled(),
  );
  const multiOrchestrator = useMulti ? orchestrator : null;

  const {
    sessionId,
    baseUrl,
    onMessagesChange,
    onConnectionChange,
    onError,
    onSessionStatus,
    onFirstTurnComplete,
    autoConnect = false,
  } = options;
  const runtimeOptions: SessionRuntimeOptions = {
    sessionId,
    baseUrl,
    onMessagesChange,
    onConnectionChange,
    onError,
    onSessionStatus,
    onFirstTurnComplete,
    autoConnect,
  };

  // Single-stream mode owns one local runtime per mounted hook; multi-stream
  // mode never creates one here (the orchestrator owns the runtimes).
  const runtimeRef = useRef<SessionRuntime | null>(null);
  if (multiOrchestrator === null && runtimeRef.current === null) {
    runtimeRef.current = createSessionRuntime(runtimeOptions);
  }
  const runtime = multiOrchestrator === null ? runtimeRef.current : null;
  if (runtime) {
    // Forward the latest options every render so callbacks never go stale
    // (mirrors the former per-render useCallback closures).
    runtime.updateOptions(runtimeOptions);
  }

  // The layout effect reads the latest options through a ref so it can depend
  // on [sessionId, onError] only, exactly like the single-stream adapter's
  // former useLayoutEffect([sessionId, onError, ...]) dependency set.
  const runtimeOptionsRef = useRef(runtimeOptions);
  runtimeOptionsRef.current = runtimeOptions;

  // Store subscription: the orchestrator (multi) or the local runtime (single).
  const subscribe = multiOrchestrator
    ? multiOrchestrator.subscribe
    : runtime?.subscribe ?? NOOP_SUBSCRIBE;
  const getSnapshot = multiOrchestrator
    ? multiOrchestrator.getSnapshot
    : runtime?.getSnapshot ?? NOOP_GET_SNAPSHOT;
  const snapshot: SessionViewState = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  const { messages, isConnected } = snapshot;

  // Actions: orchestrator-bound (multi) or the local runtime's methods (single).
  const actions: SessionRuntimeActions = multiOrchestrator
    ? multiOrchestrator.actionsFor(sessionId, runtimeOptions)
    : (runtime as SessionRuntime);

  // Notify parent of changes
  useEffect(() => {
    onMessagesChange?.(messages);
  }, [messages, onMessagesChange]);

  // Notify parent of connection changes
  useEffect(() => {
    onConnectionChange?.(isConnected);
  }, [isConnected, onConnectionChange]);

  // sessionId/onError are intentional restart triggers, mirroring the former
  // useLayoutEffect([sessionId, onError, ...]) dependency set.
  // biome-ignore lint/correctness/useExhaustiveDependencies: restart triggers, mirror the former effect's dependency set.
  useLayoutEffect(() => {
    if (multiOrchestrator) {
      // Multi-stream: mark the session visible; background runtimes must
      // survive visibility switches, so there is no teardown here.
      multiOrchestrator.attach(sessionId, runtimeOptionsRef.current);
      return;
    }
    // Single-stream: session switches are atomic — stop the old stream, clear
    // per-session accumulators, then start the new session. We use
    // `useLayoutEffect` so teardown happens before paint, minimizing the chance
    // that the next screen renders while the previous connection still pushes
    // messages.
    const localRuntime = runtimeRef.current;
    if (!localRuntime) {
      return;
    }
    localRuntime.stop();
    localRuntime.start();
    return () => {
      // Unmount teardown mirrors the former dedicated unmount effect: close the
      // wire and timers only, without clearing global tool-events stores. The
      // full per-session cleanup (stores, notifications, messages) is owned by
      // `stop()` in the effect body on session switches, not by this cleanup.
      localRuntime.disconnect();
    };
    // sessionId/onError are intentional restart triggers, mirroring the former
    // useLayoutEffect([sessionId, onError, ...]) dependency set.
  }, [multiOrchestrator, sessionId, onError]);

  return buildStreamReturn(snapshot, actions);
}
