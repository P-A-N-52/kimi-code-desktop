/**
 * Session-stream engine types (G5 multi-active-session plan, PR-B).
 *
 * These are the framework-agnostic contracts shared by the per-session
 * SessionRuntime engine (runtime.ts) and the React adapter
 * (useSessionStream.ts). The RetentionPolicy fields are consumed by PR-C
 * (multi-session orchestration) and are defined here so the policy surface is
 * stable from the start.
 */

import type { ChatStatus } from "ai";
import type { LiveMessage } from "@/hooks/types";
import type { PermissionMode, TokenUsage } from "@/hooks/wireTypes";
import type { SessionStatus } from "@/lib/api/models";
import type { SessionConfigState } from "@/lib/session-config-state";
import type { SlashCommandDef } from "@/lib/slash-command-catalog";

/**
 * Lifecycle phase of the underlying connection.
 * - "disconnected": no connection attempt is in flight
 * - "connecting": a connect attempt was started but not yet opened
 * - "connected": the wire is open and streaming
 * - "reconnecting": a reconnect delay is pending after a teardown
 */
export type ConnectionPhase = "disconnected" | "connecting" | "connected" | "reconnecting";

/**
 * Retention policy for live workers / cached view states (PR-C consumption).
 */
export type RetentionPolicy = {
  /** Max simultaneously live workers before eviction kicks in. */
  maxLiveWorkers: number;
  /** Max cached (disconnected) view states kept in memory. */
  maxCachedViewStates: number;
  /** Idle workers are disconnected after this many ms of inactivity. */
  idleDisconnectTtlMs: number;
  /** Running (busy) workers are never evicted by the cache policy. */
  pinRunning: boolean;
};

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  maxLiveWorkers: 3,
  maxCachedViewStates: 20,
  idleDisconnectTtlMs: 30 * 60 * 1000,
  pinRunning: true,
};

/**
 * Immutable UI snapshot of one session engine. `getSnapshot()` returns this
 * object by reference and only produces a new object when a field changed.
 */
export type SessionViewState = {
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
  /** Connection error if any */
  error: Error | null;
  /** Whether plan mode is active */
  planMode: boolean;
  /** Current approval behavior, independent from Plan mode */
  permissionMode: PermissionMode;
  /** Whether coordinated multi-agent execution is active */
  swarmMode: boolean;
  /** Whether goal-tracking mode is active */
  goalMode: boolean;
  /** Available slash commands from the server */
  slashCommands: SlashCommandDef[];
  /** Session-scoped config from ACP (model / thinking / mode) */
  sessionConfigState: SessionConfigState;
  /** Whether a session/set_config_option write is in flight */
  sessionConfigUpdating: boolean;
  /** Lifecycle phase of the underlying connection */
  connectionPhase: ConnectionPhase;
  /** Stable id of the current wire connection attempt (Tauri), if any */
  connectionId: string | null;
  /** Timestamp (ms) of the last snapshot update */
  updatedAt: number;
};
