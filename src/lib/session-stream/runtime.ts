/**
 * Session stream engine - per-session transport + reducer, no React dependency.
 *
 * -----------------------------------------------------------------------------
 * High-level architecture (read this before editing)
 * -----------------------------------------------------------------------------
 *
 * This module is the "transport + reducer" for one live chat stream:
 * - Transport: maintain exactly one active wire connection for the bound `sessionId`
 * - Reducer: transform the server's JSON-RPC event stream into `LiveMessage[]` for the UI
 *
 * The UI contract is intentionally simple:
 * - `messages`: append-only timeline (with in-place updates while streaming)
 * - `status`: "ready" | "submitted" | "streaming" | "error"
 * - `contextUsage/currentStep`: lightweight progress info
 *
 * -------------------------
 * Data flow / event pipeline
 * -------------------------
 *
 *   Server (JSON-RPC) ─┐
 *                      │ wire `.onmessage` (string) -> handleWireMessage()
 *                      ▼
 *                `handleMessage(data)`
 *                      │ JSON.parse → `WireMessage`
 *                      │ extractEvent → `WireEvent`
 *                      ▼
 *                `processEvent(event)`
 *                      │
 *                      ├─ updates small scalar states (status/contextUsage/step)
 *                      ├─ updates "current streaming buffers" (refs)
 *                      └─ updates `messages` via `setMessages(...)`
 *
 * The "streaming buffers" are refs (not snapshot state) because they are just
 * accumulators used to build the next message content (think/text/tool args)
 * without fighting React's async render model.
 *
 * ---------------------------------------
 * The hard constraint: no cross-session leak
 * ---------------------------------------
 *
 * Session switches (including "enter draft mode" which sets `sessionId = null`)
 * must be atomic from the UI's perspective:
 * - stop old stream
 * - clear per-session accumulators
 * - (optionally) connect to the new session
 *
 * Why this is tricky:
 * - Wire callbacks are async and can fire after we "switch pages".
 * - Calling `close()` does NOT guarantee that previously scheduled callbacks
 *   won't run afterwards.
 *
 * Our solution is two layers:
 * 1) `start()`/`stop()` on the runtime (driven by the adapter's layout effect)
 *    so teardown happens before paint (reduces visual flicker).
 * 2) Connection identity guards in every callback:
 *      `if (wsRef.current !== ws) return;`
 *    This makes late events harmless: only the currently active connection is
 *    allowed to mutate snapshot state.
 *
 * ---------------------------------------------
 * Multi-stream note (G5)
 * ---------------------------------------------
 *
 * This engine intentionally enforces "one active stream → one message
 * timeline" to stay easy to reason about. PR-C introduces a Map of
 * SessionRuntime instances (one per session); events are routed to the engine
 * that owns the connection that produced them, via `handleWireMessage`.
 */

import type { ChatStatus, ToolUIPart } from "ai";
import { v4 as uuidV4 } from "uuid";
import type { LiveMessage, MessageAttachmentPart, SubagentStep } from "@/hooks/types";
import { createMessageId, getApiBaseUrl } from "@/hooks/utils";
import {
  type ApprovalRequestEvent,
  type ApprovalRequestResolvedEvent,
  type ApprovalResponseDecision,
  type BackgroundTaskObservedEvent,
  type ConfigOptionUpdateEvent,
  type ContentPart,
  extractEvent,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type PermissionMode,
  type PlanDisplayEvent,
  type QuestionRequestEvent,
  type SessionStatusPayload,
  type SlashCommandsUpdateEvent,
  type StepRetryEvent,
  type SubagentEventWire,
  type SubagentLifecycleEvent,
  type TaskCompletedEvent,
  type TaskCreatedEvent,
  type TaskProgressEvent,
  type TokenUsage,
  type ToolCallState,
  type WireEvent,
  type WireMessage,
} from "@/hooks/wireTypes";
import {
  completeAgentMonitorTask,
  completeRunningAgentMonitorTasks,
  syncAgentMonitorFromSubagentEvent,
  syncAgentMonitorFromSubagentLifecycle,
  syncAgentMonitorFromTaskCompleted,
  syncAgentMonitorFromTaskCreated,
  syncAgentMonitorFromTaskProgress,
} from "@/lib/agent-monitor/sync";
import type { SessionStatus, UploadSessionFileResponse } from "@/lib/api/models";
import { getAuthToken } from "@/lib/auth";
import {
  type BackgroundTaskSyncResult,
  resetBackgroundTaskNotifications,
  syncBackgroundTaskFromToolResult,
  syncBackgroundTaskFromWire,
} from "@/lib/background-tasks/sync";
import {
  formatGoalStatus,
  type GoalPromptAction,
  goalPromptForCommand,
  parseGoalCommand,
} from "@/lib/goal";
import {
  formatStatusReport,
  formatUsageReport,
  parseManagedUsageFetchResult,
  type SessionUsageContext,
} from "@/lib/managed-usage";
import {
  applyConfigOptionWirePayload,
  emptySessionConfigState,
  isValidSessionConfigValue,
  runtimeModesFromSessionModeValue,
  type SessionConfigState,
} from "@/lib/session-config-state";
import {
  classifySlashDispatch,
  filterDesktopSlashCommands,
  formatDesktopHelpReport,
  parseSlashCommandInput,
  type SlashCommandDef,
} from "@/lib/slash-command-catalog";
import {
  controlSessionGoal,
  fetchManagedUsage,
  getGlobalConfig,
  getKimiCliVersion,
  getSession,
  getSessionConfigState,
  getSessionGoalSnapshot,
  getSessionRuntimeModes,
  isTauri,
  migrateSessionSwarmMode,
  onWireMessage,
  replaySessionHistory,
  sendNotification,
  wireConnect,
  wireDisconnect,
  wireSend,
  wireStatus,
} from "@/lib/tauri-api";
import { handleToolResult, type TodoItem, useToolEventsStore } from "@/lib/tool-events/store";
import { isBackgroundOrCronObservationTool } from "@/lib/tool-events/tool-registry";
import { resolveKimiCliVersion } from "@/lib/version";
import { formatMentionToken } from "@/modules/composer/file-mentions";
import { resolveAskUserParentToolCallId } from "@/modules/statusbar/permission-mode";
import type { ConnectionPhase, SessionViewState } from "./types";

/**
 * Inline uploaded attachments into the prompt text as CLI-style `@path`
 * mention tokens (absolute pending-upload paths, forward-slashed) instead of
 * wire-level attachment_ids, so the runtime receives them in text form.
 */
function attachmentMentionTokens(attachments: UploadSessionFileResponse[]): string[] {
  return attachments.map((attachment) => formatMentionToken(attachment.path.replace(/\\/g, "/")));
}

function joinPromptText(text: string, attachments: UploadSessionFileResponse[]): string {
  return [text, ...attachmentMentionTokens(attachments)]
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

const DATA_URL_MEDIA_TYPE_REGEX = /^data:([^;,]+)[;,]/;
const NUMBERED_LIST_ITEM_REGEX = /^\d+\.\s+(.+)$/;
const IMAGE_TAG_REGEX = /<image\s+path="([^"]+)"\s+content_type="([^"]+)">/i;
const VIDEO_TAG_REGEX = /<video\s+path="([^"]+)"\s+content_type="([^"]+)">/i;
const DOCUMENT_TAG_REGEX = /<document\s+path="([^"]+)"\s+content_type="([^"]+)">/i;
const LEGACY_UPLOADS_REGEX = /`uploads\/([^`]+)`/;
const TRAILING_DECIMAL_ZERO_REGEX = /\.0$/;

function maybeNotifyBackgroundTaskComplete(
  result: BackgroundTaskSyncResult,
  isReplay: boolean,
): void {
  if (isReplay || !result.terminalBackgroundTask || !isTauri()) return;
  if (document.hasFocus()) return;
  const { title, terminalState } = result.terminalBackgroundTask;
  const body =
    terminalState === "failed"
      ? "后台任务失败"
      : terminalState === "stopped"
        ? "后台任务已停止"
        : "后台任务已完成";
  void sendNotification(title, body).catch(() => {});
}

const HTTP_TO_WS_REGEX = /^http/;
const NEWLINE_REGEX = /\r?\n/;
// Match <image path="..."> or <video path="..."> tags (path attribute only, no content_type required)
const MEDIA_TAG_PATH_REGEX =
  /<(?:image|video)\s+[^>]*path="([^"]*\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/uploads\/([^"]+))"/g;
const BROWSER_URL_PROTOCOLS = new Set(["http:", "https:", "data:", "blob:"]);
const WIRE_PROTOCOL_VERSION = "1.10";
const THINK_OPEN_TAG = "<think>";
const THINK_CLOSE_TAG = "</think>";
const LEGACY_SWARM_MODE_STORAGE_KEY = "kimi-code-desktop.swarm-mode-by-session.v1";

function readLegacySwarmModes(): Record<string, boolean> {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const value = window.localStorage.getItem(LEGACY_SWARM_MODE_STORAGE_KEY);
    if (!value) {
      return {};
    }
    const stored = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(stored).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
      ),
    );
  } catch {
    return {};
  }
}

function writeLegacySwarmModes(stored: Record<string, boolean>): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (Object.keys(stored).length === 0) {
      window.localStorage.removeItem(LEGACY_SWARM_MODE_STORAGE_KEY);
    } else {
      window.localStorage.setItem(LEGACY_SWARM_MODE_STORAGE_KEY, JSON.stringify(stored));
    }
  } catch {
    // Legacy cleanup is best-effort; it is never used as the live source of truth.
  }
}

async function migrateLegacySwarmModes(): Promise<Map<string, boolean>> {
  const remaining = readLegacySwarmModes();
  const entries = Object.entries(remaining);
  if (entries.length === 0) {
    return new Map();
  }

  const results = await Promise.all(
    entries.map(async ([sessionId, enabled]) => {
      try {
        await migrateSessionSwarmMode(sessionId, enabled);
        return { sessionId, enabled, ok: true as const };
      } catch (error) {
        console.warn(
          `[SessionStream] Failed to migrate legacy Swarm mode for ${sessionId}:`,
          error,
        );
        return { sessionId, enabled, ok: false as const };
      }
    }),
  );

  const migrated = new Map<string, boolean>();
  for (const result of results) {
    if (!result.ok) continue;
    migrated.set(result.sessionId, result.enabled);
    delete remaining[result.sessionId];
  }
  writeLegacySwarmModes(remaining);
  return migrated;
}

type PersistedSessionModes = {
  planMode: boolean;
  permissionMode: PermissionMode;
  swarmMode: boolean;
  goalMode: boolean;
};

async function loadSessionRuntimeModes(sessionId: string): Promise<PersistedSessionModes> {
  const migrated = await migrateLegacySwarmModes();
  const modes = await getSessionRuntimeModes(sessionId);
  if (migrated.has(sessionId)) {
    return {
      planMode: modes.planMode,
      permissionMode: modes.permissionMode,
      swarmMode: migrated.get(sessionId) ?? false,
      goalMode: modes.goalMode,
    };
  }
  return {
    planMode: modes.planMode,
    permissionMode: modes.permissionMode,
    swarmMode: modes.swarmMode,
    goalMode: modes.goalMode,
  };
}

type InlineThinkParseState = {
  inThink: boolean;
  buffer: string;
};

type InlineThinkSegment = {
  kind: "text" | "think";
  value: string;
};

const indexOfTag = (value: string, tag: string): number => value.toLowerCase().indexOf(tag);

const longestSuffixThatCanStartTag = (value: string, tag: string): string => {
  const lowerValue = value.toLowerCase();
  const maxLength = Math.min(lowerValue.length, tag.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = lowerValue.slice(-length);
    if (tag.startsWith(suffix)) {
      return value.slice(-length);
    }
  }
  return "";
};

const consumeInlineThinkText = (
  state: InlineThinkParseState,
  chunk: string,
): InlineThinkSegment[] => {
  state.buffer += chunk;
  const segments: InlineThinkSegment[] = [];

  while (state.buffer.length > 0) {
    if (state.inThink) {
      const closeIndex = indexOfTag(state.buffer, THINK_CLOSE_TAG);
      if (closeIndex === -1) {
        const keep = longestSuffixThatCanStartTag(state.buffer, THINK_CLOSE_TAG);
        const emitLength = state.buffer.length - keep.length;
        if (emitLength > 0) {
          segments.push({
            kind: "think",
            value: state.buffer.slice(0, emitLength),
          });
          state.buffer = keep;
        }
        break;
      }

      if (closeIndex > 0) {
        segments.push({
          kind: "think",
          value: state.buffer.slice(0, closeIndex),
        });
      }
      state.buffer = state.buffer.slice(closeIndex + THINK_CLOSE_TAG.length);
      state.inThink = false;
      continue;
    }

    const openIndex = indexOfTag(state.buffer, THINK_OPEN_TAG);
    if (openIndex === -1) {
      const keep = longestSuffixThatCanStartTag(state.buffer, THINK_OPEN_TAG);
      const emitLength = state.buffer.length - keep.length;
      if (emitLength > 0) {
        segments.push({
          kind: "text",
          value: state.buffer.slice(0, emitLength),
        });
        state.buffer = keep;
      }
      break;
    }

    if (openIndex > 0) {
      segments.push({
        kind: "text",
        value: state.buffer.slice(0, openIndex),
      });
    }
    state.buffer = state.buffer.slice(openIndex + THINK_OPEN_TAG.length);
    state.inThink = true;
  }

  return segments;
};

const flushInlineThinkText = (state: InlineThinkParseState): InlineThinkSegment[] => {
  if (!state.buffer) {
    state.inThink = false;
    return [];
  }

  const segment: InlineThinkSegment = {
    kind: state.inThink ? "think" : "text",
    value: state.buffer,
  };
  state.buffer = "";
  state.inThink = false;
  return [segment];
};

type StepRetryPayload = StepRetryEvent["payload"];

const formatStepRetryReason = (retry: StepRetryPayload): string => {
  if (retry.status_code === 429) {
    return "rate limit";
  }
  if (retry.status_code !== null && retry.status_code !== undefined && retry.status_code >= 500) {
    return "server error";
  }
  switch (retry.error_type) {
    case "APITimeoutError":
      return "timeout";
    case "APIConnectionError":
      return "connection issue";
    case "APIEmptyResponseError":
      return "empty response";
    default:
      return retry.error_type;
  }
};

const formatRetryWait = (waitS: number): string => {
  if (!Number.isFinite(waitS)) {
    return "soon";
  }
  const seconds = Math.max(0, waitS);
  if (seconds < 10) {
    return `${seconds.toFixed(1).replace(TRAILING_DECIMAL_ZERO_REGEX, "")}s`;
  }
  return `${Math.round(seconds)}s`;
};

const formatStepRetryStatus = (retry: StepRetryPayload): string =>
  `Retrying after ${formatStepRetryReason(retry)} · attempt ${retry.next_attempt}/${retry.max_attempts} · ${formatRetryWait(retry.wait_s)}`;

const discardSubagentRetryAttempt = (steps: SubagentStep[]): SubagentStep[] => {
  const next = steps.filter((step) => !(step.kind === "tool-call" && step.status === "running"));
  while (next.length > 0) {
    const last = next[next.length - 1];
    if (last.kind !== "thinking" && last.kind !== "text") {
      break;
    }
    next.pop();
  }
  return next;
};

/** Extract the URL from a media output part (image_url or video_url) */
const extractMediaUrl = (part: Record<string, unknown>): string => {
  const imgUrl = (part.image_url as { url?: string })?.url;
  const vidUrl = (part.video_url as { url?: string })?.url;
  return imgUrl ?? vidUrl ?? "";
};

/** Check if a URL can be rendered in the browser (http/https/data/blob) */
const isBrowserUrl = (url: string): boolean => {
  try {
    return BROWSER_URL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
};

export type { SlashCommandDef };

function normalizeIncomingSlashCommands(
  commands: Array<{
    name: string;
    description?: string;
    aliases?: string[];
    input_hint?: string | null;
    inputHint?: string | null;
    source?: string | null;
  }>,
): SlashCommandDef[] {
  return filterDesktopSlashCommands(
    commands.map((command) => ({
      name: command.name,
      description: command.description ?? "",
      aliases: command.aliases ?? [],
      inputHint: command.inputHint ?? command.input_hint ?? null,
      source: command.source ?? null,
    })),
  );
}

/** Merge ACP slash-command waves by name; later waves fill / override earlier ones. */
export function mergeSlashCommandsByName(
  existing: SlashCommandDef[],
  incoming: SlashCommandDef[],
): SlashCommandDef[] {
  const byKey = new Map<string, SlashCommandDef>();
  for (const command of existing) {
    const key = command.name.trim().toLowerCase();
    if (key) byKey.set(key, command);
  }
  for (const command of incoming) {
    const key = command.name.trim().toLowerCase();
    if (key) byKey.set(key, command);
  }
  return Array.from(byKey.values());
}

const HISTORY_REPLAY_CHUNK_SIZE = 40;

async function replayHistoryMessagesInBatches(
  messages: string[],
  handleMessage: (message: string) => void,
  isCancelled: () => boolean,
): Promise<void> {
  for (let index = 0; index < messages.length; index += HISTORY_REPLAY_CHUNK_SIZE) {
    if (isCancelled()) {
      return;
    }
    const chunk = messages.slice(index, index + HISTORY_REPLAY_CHUNK_SIZE);
    for (const message of chunk) {
      handleMessage(message);
    }
    if (index + HISTORY_REPLAY_CHUNK_SIZE < messages.length) {
      await new Promise<void>((resolve) => {
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => resolve());
        } else {
          setTimeout(resolve, 0);
        }
      });
    }
  }
}

/** UI effect for local info slash commands that stay out of chat history. */
export type LocalInfoPanelResult = {
  kind: "info-panel";
  command: "usage" | "status" | "goal";
  content: string;
  error?: boolean;
};

/** Local preflight shown before a Goal is started in Manual or YOLO mode. */
export type GoalStartConfirmationResult = {
  kind: "goal-start-confirmation";
  objective: string;
  replace: boolean;
  permissionMode: Exclude<PermissionMode, "auto">;
  goalSwitchArmed: boolean;
};

export type SendMessageOptions = {
  goalStartConfirmed?: boolean;
  /** Queue item consumed by the backend only after native goal.create is observed. */
  upcomingGoalId?: string;
  /** Atomically seed a newly-created session before Goal preflight and mode flush. */
  initialModes?: {
    permissionMode: PermissionMode;
    planMode: boolean;
    swarmMode: boolean;
    goalMode: boolean;
  };
};
export type SendMessageResult = LocalInfoPanelResult | GoalStartConfirmationResult | undefined;

type PendingPrompt = {
  text: string;
  attachments: UploadSessionFileResponse[];
  goalAction?: GoalPromptAction;
  upcomingGoalId?: string;
  goalSwitchWasArmed?: boolean;
};

type StreamConnection = {
  readyState: number;
  send: (data: string) => void | Promise<void>;
  close: () => void;
};

type TauriWireConnection = StreamConnection & {
  connectionId: string;
  replaceUnlisten: (unlisten: () => void) => void;
  markOpen: () => void;
  markClosed: () => void;
};

const STREAM_CONNECTING = 0;
const STREAM_OPEN = 1;
const STREAM_CLOSED = 3;
let nextTauriConnectionId = 0;

function sessionStatusToPayload(status: SessionStatus): SessionStatusPayload {
  return {
    session_id: status.sessionId,
    state: status.state as SessionStatusPayload["state"],
    seq: status.seq,
    worker_id: status.workerId,
    reason: status.reason,
    detail: status.detail,
    updated_at: status.updatedAt.toISOString(),
  };
}

type PendingApprovalEntry = {
  requestId: string;
  toolCallId: string;
  messageId?: string;
  rpcId?: string | number;
  submitted?: boolean;
};

type PendingQuestionEntry = {
  requestId: string;
  toolCallId: string;
  messageId?: string;
  rpcId?: string | number;
  submitted?: boolean;
};

type OptimisticUserMessage = {
  id: string;
  turnIndex: number;
};

type PromptTiming = {
  startedAt: number;
  workerReadyAt?: number;
  promptSubmittedAt?: number;
  firstEventAt?: number;
};
export type SessionRuntimeOptions = {
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
  /**
   * Whether connect() registers its own per-session `wire:message` listener.
   * Default true (single-stream adapter). The G5 orchestrator sets false and
   * routes all events through one global listener + handleWireMessage.
   */
  registerPerSessionListener?: boolean;
};

/**
 * Per-session stream engine: transport + reducer with no React dependency.
 * Actions mirror the UseSessionStreamReturn action fields one-to-one.
 */
export type SessionRuntime = {
  /** Session this engine is currently bound to (may be null in draft mode). */
  sessionId: string | null;
  /** Latest immutable UI snapshot; reference-stable until something changes. */
  getSnapshot: () => SessionViewState;
  /** Subscribe to snapshot changes; returns an unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
  /** Refresh forwarded options (sessionId/baseUrl/callbacks). Call on every render. */
  updateOptions: (options: SessionRuntimeOptions) => void;
  /** Entry point for every incoming wire message (PR-C global-listener reuse). */
  handleWireMessage: (message: string) => void;
  /** Send a message to the session (will auto-connect if not connected). */
  sendMessage: (
    text: string,
    attachments?: UploadSessionFileResponse[],
    options?: SendMessageOptions,
  ) => Promise<SendMessageResult>;
  /** Resolve /usage or /status text without writing chat messages. */
  runLocalInfoCommand: (command: "usage" | "status") => Promise<string>;
  /** Respond to an approval request. */
  respondToApproval: (
    requestId: string,
    response: ApprovalResponseDecision,
    reason?: string,
  ) => Promise<void>;
  /** Respond to a question request. */
  respondToQuestion: (requestId: string, answers: Record<string, string>) => Promise<void>;
  /** Control the native Goal lifecycle even while a turn is running. */
  controlGoal: (action: "pause" | "resume" | "cancel") => Promise<LocalInfoPanelResult | undefined>;
  /** Send a cancel request for the current turn. */
  cancel: () => void;
  /** Disconnect from the stream. */
  disconnect: () => void;
  /** Reconnect to the session. */
  reconnect: () => void;
  /** Connect to the session stream. */
  connect: () => void;
  /** Set messages directly (functional updates supported). */
  setMessages: (action: LiveMessage[] | ((prev: LiveMessage[]) => LiveMessage[])) => void;
  /** Clear all messages. */
  clearMessages: () => void;
  /** Set plan mode via silent RPC (no context message). */
  sendSetPlanMode: (enabled: boolean) => boolean;
  /** Set the ACP permission mode while preserving Plan mode. */
  sendSetPermissionMode: (mode: PermissionMode) => boolean;
  /** Set Swarm mode via silent RPC. */
  sendSetSwarmMode: (enabled: boolean) => boolean;
  /** Set Goal mode via silent RPC. */
  sendSetGoalMode: (enabled: boolean) => boolean;
  /** Change a declared session config option via the wire worker. */
  sendSetConfigOption: (configId: string, value: unknown) => Promise<boolean>;
  /** Start the per-session lifecycle (former useLayoutEffect([sessionId]) body). */
  start: () => void;
  /** Stop the runtime: cancel start chains, disconnect, reset per-session state. */
  stop: () => void;
};

/**
 * Create a per-session stream engine. One instance per session; the React
 * adapter calls updateOptions() on every render so callbacks never go stale,
 * and stop()/start() on session switches. All async callbacks guard on
 * connection identity / generation counters, so late events from a previous
 * session can never mutate this engine's snapshot.
 */
export function createSessionRuntime(initialOptions: SessionRuntimeOptions): SessionRuntime {
  // Mutable option forwarding (former per-render closure values). The adapter
  // refreshes these on every render via updateOptions(). onMessagesChange and
  // onConnectionChange are consumed by the adapter's effects, not here.
  let sessionId = initialOptions.sessionId;
  let baseUrl = initialOptions.baseUrl;
  let autoConnect = initialOptions.autoConnect ?? false;
  let onError = initialOptions.onError;
  let onSessionStatus = initialOptions.onSessionStatus;
  let onFirstTurnComplete = initialOptions.onFirstTurnComplete;
  let registerPerSessionListener = initialOptions.registerPerSessionListener ?? true;

  // ── Snapshot state (was useState) ──
  let messages: LiveMessage[] = [];
  let status: ChatStatus = "ready";
  let sessionStatus: SessionStatus | null = null;
  let contextUsage = 0;
  let contextTokens: number | null = null;
  let maxContextTokens: number | null = null;
  let tokenUsage: TokenUsage | null = null;
  let planMode = false;
  let permissionMode: PermissionMode = "manual";
  let swarmMode = false;
  let goalMode = false;
  let goalCompletionEpoch = 0;
  let currentStep = 0;
  let isConnected = false;
  let error: Error | null = null;
  let isAwaitingFirstResponse = false;
  let isReplayingHistory = true;
  let slashCommands: SlashCommandDef[] = [];
  let sessionConfigState: SessionConfigState = sessionId
    ? emptySessionConfigState(sessionId)
    : emptySessionConfigState("");
  let sessionConfigUpdating = false;
  let connectionPhase: ConnectionPhase = "disconnected";
  let connectionId: string | null = null;
  let lastEventAt = 0;

  // ── Refs (was useRef; kept as mutable box objects so access reads verbatim) ──
  const sessionConfigStateRef: { current: SessionConfigState } = {
    current: sessionConfigState,
  };
  const slashCommandsRef: { current: SlashCommandDef[] } = { current: [] };
  const contextUsageRef: { current: number } = { current: 0 };
  const contextTokensRef: { current: number | null } = { current: null };
  const maxContextTokensRef: { current: number | null } = { current: null };
  const tokenUsageRef: { current: TokenUsage | null } = { current: null };

  // Refs
  /**
   * The single source of truth for "which connection is allowed to mutate state".
   *
   * Important nuance: this ref represents the *current connection attempt*, not only
   * "the currently open connection".
   *
   * Why this exists:
   * - Wire callbacks (onmessage/onclose/onerror/onopen) are async and can fire
   *   after the UI has already switched to another session (or draft mode).
   * - Simply calling `close()` or setting `wsRef.current = null` does NOT prevent
   *   already-scheduled callbacks from running.
   *
   * Our invariant:
   * - Only callbacks belonging to `wsRef.current` may update snapshot state.
   * - Every callback starts with `if (wsRef.current !== ws) return;` to ignore late events.
   */
  const wsRef: { current: StreamConnection | null } = { current: null };
  const activeSessionIdRef: { current: string | null } = { current: sessionId };
  const goalSnapshotRequestSeqRef: { current: number } = { current: 0 };
  const goalHistoryResyncGenerationRef: { current: number } = { current: 0 };
  const goalHistoryResyncActiveRef: { current: boolean } = { current: false };
  const goalHistoryReplayBufferRef: { current: { messages: LiveMessage[] } | null } = {
    current: null,
  };
  const latestSessionStatusRef: { current: SessionStatus | null } = { current: null };
  const reconnectTimeoutRef: { current: number | null } = { current: null };
  const connectRef: { current: () => void } = { current: () => undefined };
  const disconnectRef: { current: () => void } = { current: () => undefined };
  const reconnectRef: { current: () => void } = { current: () => undefined };
  const resetStateRef: {
    current: (preserveSlashCommands?: boolean, preserveSessionState?: boolean) => void;
  } = { current: () => undefined };
  const handleMessageRef: { current: (data: string) => void } = { current: () => undefined };
  const historyCompleteTimeoutRef: { current: number | null } = { current: null };
  const isReplayingRef: { current: boolean } = { current: true }; // Track if we're still replaying history
  const pendingMessageRef: { current: PendingPrompt | null } = { current: null }; // Prompt to send after connection
  const pendingModeUpdatesRef: {
    current: {
      planMode?: boolean;
      permissionMode?: PermissionMode;
      swarmMode?: boolean;
      goalMode?: boolean;
    };
  } = { current: {} };
  /** Serialize mode flushes so permission/plan/swarm/goal setters cannot race. */
  const modeFlushChainRef: { current: Promise<void> } = { current: Promise.resolve() };
  const planModeRef: { current: boolean } = { current: false };
  const permissionModeRef: { current: PermissionMode } = { current: "manual" };
  const swarmModeRef: { current: boolean } = { current: false };
  const goalModeRef: { current: boolean } = { current: false };
  const awaitingIdleRef: { current: boolean } = { current: false }; // Track pending idle after cancel
  const awaitingFirstResponseRef: { current: boolean } = { current: false }; // Track if waiting for first event of a turn
  const errorRef: { current: Error | null } = { current: null }; // Synchronous guard against later idle snapshots
  const promptTimingRef: { current: PromptTiming | null } = { current: null };
  const preserveMessagesOnConnectRef: { current: boolean } = { current: false };
  const skipReplayOnConnectRef: { current: boolean } = { current: false };
  const hasMessagesRef: { current: boolean } = { current: false };
  const autoConnectRef: { current: boolean } = { current: autoConnect };
  const lastStatusSeqRef: { current: number | null } = { current: null };
  const lastWsMessageTimeRef: { current: number } = { current: 0 }; // Last time a stream message was received
  const watchdogIntervalRef: { current: number | null } = { current: null }; // Stale connection watchdog
  const statusRef: { current: ChatStatus } = { current: "ready" }; // Synced copy of status for watchdog

  // First turn tracking for auto-rename (simplified: backend reads from wire.jsonl)
  const hasTurnStartedRef: { current: boolean } = { current: false }; // Whether at least one turn has started
  const firstTurnCompleteCalledRef: { current: boolean } = { current: false }; // Whether onFirstTurnComplete was called

  // Initialize message tracking
  const initializeIdRef: { current: string | null } = { current: null };
  const replayIdRef: { current: string | null } = { current: null };
  const initializeRetryCountRef: { current: number } = { current: 0 }; // Track retry attempts for initialize
  const MAX_INITIALIZE_RETRIES = 5; // Maximum retry attempts
  const connectRetryCountRef: { current: number } = { current: 0 }; // Retry attempts for the initial Tauri wire connect
  const MAX_TAURI_CONNECT_RETRIES = 1; // One automatic retry; kimi acp may still be initializing
  const TAURI_CONNECT_RETRY_DELAY_MS = 1500; // Delay before the retry
  const usingCachedCommandsRef: { current: boolean } = { current: false }; // Track if using cached slash commands
  const slashCommandsLenRef: { current: number } = { current: 0 }; // Track slashCommands length without state dependency

  // Current state accumulators
  const currentThinkingRef: { current: string } = { current: "" };
  const currentTextRef: { current: string } = { current: "" };
  const inlineThinkParserRef: { current: InlineThinkParseState } = {
    current: { inThink: false, buffer: "" },
  };
  const streamUpdateFrameRef: { current: number | null } = { current: null };
  const thinkingCompletedRef: { current: boolean } = { current: false };
  const flushBufferedStreamUpdateRef: { current: () => void } = { current: () => undefined };
  const flushInlineThinkBufferRef: { current: (isReplay: boolean) => void } = {
    current: () => undefined,
  };
  const currentToolCallsRef: { current: Map<string, ToolCallState> } = { current: new Map() };
  const currentToolCallIdRef: { current: string | null } = { current: null };
  const thinkingMessageIdRef: { current: string | null } = { current: null };
  const textMessageIdRef: { current: string | null } = { current: null };
  // IDs of every thinking/text block created since the last step reset. Live
  // ACP seals blocks at tool-call boundaries, so the "current" refs alone no
  // longer cover all blocks a retry must discard.
  const turnStreamBlockIdsRef: { current: string[] } = { current: [] };
  const pendingApprovalRequestsRef: { current: Map<string, PendingApprovalEntry> } = {
    current: new Map(),
  };
  const pendingQuestionRequestsRef: { current: Map<string, PendingQuestionEntry> } = {
    current: new Map(),
  };
  const optimisticUserMessagesRef: { current: OptimisticUserMessage[] } = { current: [] };
  const promptRequestIdsRef: { current: Set<string> } = { current: new Set() };
  const cancelRequestIdsRef: { current: Set<string> } = { current: new Set() };
  const configOptionRequestIdsRef: {
    current: Map<string, { resolve: (ok: boolean) => void; configId: string }>;
  } = { current: new Map() };

  // Track if current turn is a /clear command (needs UI clear on turn end)
  const pendingClearRef: { current: boolean } = { current: false };
  // /compact is an ACP slash command (not a chat turn). Suppress model stream
  // UI and clear history when the prompt RPC finishes — ACP currently drops
  // CompactionBegin/End session updates.
  const pendingCompactRef: { current: boolean } = { current: false };

  // Turn counter for fork feature
  const turnCounterRef: { current: number } = { current: 0 };

  // Track compaction indicator message so we can remove it on CompactionEnd
  const compactionMessageIdRef: { current: string | null } = { current: null };

  // Track MCP loading indicator message so we can remove it on MCPLoadingEnd
  const mcpLoadingMessageIdRef: { current: string | null } = { current: null };

  // Track the temporary StepRetry status so the next attempt can replace it.
  const stepRetryStatusMessageIdRef: { current: string | null } = { current: null };

  // ── Snapshot plumbing ──
  // Keep refs aligned with the current state, but never clobber an in-flight
  // local mode write (pendingModeUpdatesRef) — StatusUpdate / applyPersistedModes
  // races were overwriting optimistic auto with manual before the first prompt.
  const syncRefsFromState = (): void => {
    activeSessionIdRef.current = sessionId;
    autoConnectRef.current = autoConnect;
    if (typeof pendingModeUpdatesRef.current.planMode !== "boolean") {
      planModeRef.current = planMode;
    }
    if (!pendingModeUpdatesRef.current.permissionMode) {
      permissionModeRef.current = permissionMode;
    }
    if (typeof pendingModeUpdatesRef.current.swarmMode !== "boolean") {
      swarmModeRef.current = swarmMode;
    }
    if (typeof pendingModeUpdatesRef.current.goalMode !== "boolean") {
      goalModeRef.current = goalMode;
    }
    statusRef.current = status;
    slashCommandsRef.current = slashCommands;
    contextUsageRef.current = contextUsage;
    contextTokensRef.current = contextTokens;
    maxContextTokensRef.current = maxContextTokens;
    tokenUsageRef.current = tokenUsage;
    sessionConfigStateRef.current = sessionConfigState;
    hasMessagesRef.current = messages.length > 0;
  };

  // Snapshot object handed to subscribers; only rebuilt when something changed.
  let state: SessionViewState;
  const rebuildSnapshot = (): void => {
    state = {
      messages,
      status,
      sessionStatus,
      isReplayingHistory,
      isAwaitingFirstResponse,
      canCancel: !isReplayingHistory && (isAwaitingFirstResponse || status === "streaming"),
      contextUsage,
      contextTokens,
      maxContextTokens,
      tokenUsage,
      currentStep,
      goalCompletionEpoch,
      isConnected,
      error,
      planMode,
      permissionMode,
      swarmMode,
      goalMode,
      slashCommands,
      sessionConfigState,
      sessionConfigUpdating,
      connectionPhase,
      connectionId,
      lastEventAt,
      updatedAt: Date.now(),
    };
  };
  rebuildSnapshot();

  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const applyField = <K extends keyof SessionViewState>(
    key: K,
    next: SessionViewState[K],
  ): void => {
    switch (key) {
      case "messages":
        messages = next as LiveMessage[];
        break;
      case "status":
        status = next as ChatStatus;
        break;
      case "sessionStatus":
        sessionStatus = next as SessionStatus | null;
        break;
      case "isReplayingHistory":
        isReplayingHistory = next as boolean;
        break;
      case "isAwaitingFirstResponse":
        isAwaitingFirstResponse = next as boolean;
        break;
      case "contextUsage":
        contextUsage = next as number;
        break;
      case "contextTokens":
        contextTokens = next as number | null;
        break;
      case "maxContextTokens":
        maxContextTokens = next as number | null;
        break;
      case "tokenUsage":
        tokenUsage = next as TokenUsage | null;
        break;
      case "currentStep":
        currentStep = next as number;
        break;
      case "goalCompletionEpoch":
        goalCompletionEpoch = next as number;
        break;
      case "isConnected":
        isConnected = next as boolean;
        break;
      case "error":
        error = next as Error | null;
        break;
      case "planMode":
        planMode = next as boolean;
        break;
      case "permissionMode":
        permissionMode = next as PermissionMode;
        break;
      case "swarmMode":
        swarmMode = next as boolean;
        break;
      case "goalMode":
        goalMode = next as boolean;
        break;
      case "slashCommands":
        slashCommands = next as SlashCommandDef[];
        break;
      case "sessionConfigState":
        sessionConfigState = next as SessionConfigState;
        break;
      case "sessionConfigUpdating":
        sessionConfigUpdating = next as boolean;
        break;
      case "connectionPhase":
        connectionPhase = next as ConnectionPhase;
        break;
      case "connectionId":
        connectionId = next as string | null;
        break;
      case "lastEventAt":
        lastEventAt = next as number;
        break;
      default:
        break;
    }
  };

  /**
   * Apply one snapshot field update with React setState semantics: functional
   * updaters see the latest value, Object.is bail-out keeps the snapshot
   * reference stable, and one emit happens per applied change.
   */
  const setField = <K extends keyof SessionViewState>(
    key: K,
    action: SessionViewState[K] | ((prev: SessionViewState[K]) => SessionViewState[K]),
  ): void => {
    const current = state[key];
    const next =
      typeof action === "function"
        ? (action as (prev: SessionViewState[K]) => SessionViewState[K])(current)
        : action;
    if (Object.is(current, next)) {
      return;
    }
    applyField(key, next);
    rebuildSnapshot();
    // NOTE: the ref mirrors (statusRef/slashCommandsRef/mode refs/...) are NOT
    // synced here — the original hook synced them during React renders, and
    // timer-driven updates (e.g. inside act()) can legitimately observe the
    // pre-render values. The adapter re-syncs them on every render via
    // updateOptions().
    // Former useEffect([flushPendingModeUpdates, status]): flush deferred mode
    // updates as soon as the worker is open and the session turns ready.
    if (key === "status" && status === "ready") {
      const hasPendingModeUpdates =
        typeof pendingModeUpdatesRef.current.planMode === "boolean" ||
        Boolean(pendingModeUpdatesRef.current.permissionMode) ||
        typeof pendingModeUpdatesRef.current.swarmMode === "boolean" ||
        typeof pendingModeUpdatesRef.current.goalMode === "boolean";
      const connection = wsRef.current;
      if (
        hasPendingModeUpdates &&
        connection?.readyState === STREAM_OPEN &&
        initializeIdRef.current === null &&
        replayIdRef.current === null
      ) {
        void flushPendingModeUpdates(connection).catch((error) => {
          console.warn("[SessionStream] Failed to apply deferred mode update:", error);
        });
      }
    }
    emit();
  };

  // Setters (was useState setters; SetStateAction semantics preserved)
  const setMessagesInternal = (
    action: LiveMessage[] | ((prev: LiveMessage[]) => LiveMessage[]),
  ): void => setField("messages", action);
  const setStatus = (action: ChatStatus | ((prev: ChatStatus) => ChatStatus)): void =>
    setField("status", action);
  const setSessionStatus = (value: SessionStatus | null): void => setField("sessionStatus", value);
  const setContextUsage = (value: number): void => setField("contextUsage", value);
  const setContextTokens = (value: number | null): void => setField("contextTokens", value);
  const setMaxContextTokens = (value: number | null): void => setField("maxContextTokens", value);
  const setTokenUsage = (value: TokenUsage | null): void => setField("tokenUsage", value);
  const setPlanMode = (value: boolean): void => setField("planMode", value);
  const setPermissionMode = (value: PermissionMode): void => setField("permissionMode", value);
  const setSwarmMode = (value: boolean): void => setField("swarmMode", value);
  const setGoalMode = (value: boolean): void => setField("goalMode", value);
  const setGoalCompletionEpoch = (action: number | ((prev: number) => number)): void =>
    setField("goalCompletionEpoch", action);
  const setCurrentStep = (value: number): void => setField("currentStep", value);
  const setIsConnected = (value: boolean): void => setField("isConnected", value);
  const setErrorState = (value: Error | null): void => setField("error", value);
  const setIsReplayingHistory = (value: boolean): void => setField("isReplayingHistory", value);
  const setSlashCommands = (
    action: SlashCommandDef[] | ((prev: SlashCommandDef[]) => SlashCommandDef[]),
  ): void => setField("slashCommands", action);
  const setSessionConfigState = (
    action: SessionConfigState | ((prev: SessionConfigState) => SessionConfigState),
  ): void => setField("sessionConfigState", action);
  const setSessionConfigUpdating = (value: boolean): void =>
    setField("sessionConfigUpdating", value);
  const setConnectionPhase = (value: ConnectionPhase): void => setField("connectionPhase", value);
  const setConnectionId = (value: string | null): void => setField("connectionId", value);

  const rearmFailedGoalStart = (): void => {
    pendingModeUpdatesRef.current.goalMode = true;
    goalModeRef.current = true;
    setGoalMode(true);
  };
  // Wrapped setMessages. Goal continuation history is rebuilt offscreen and
  // committed once, so replay never duplicates the already-rendered first turn.
  const setMessages: typeof setMessagesInternal = (action) => {
    const replayBuffer = goalHistoryReplayBufferRef.current;
    if (replayBuffer) {
      replayBuffer.messages = typeof action === "function" ? action(replayBuffer.messages) : action;
      return;
    }
    setMessagesInternal(action);
  };

  const setError = (nextError: Error | null) => {
    errorRef.current = nextError;
    setErrorState(nextError);
  };

  const setAwaitingFirstResponse = (value: boolean) => {
    awaitingFirstResponseRef.current = value;
    if (!value) {
      promptTimingRef.current = null;
    }
    setField("isAwaitingFirstResponse", value);
  };
  const clearAwaitingFirstResponse = () => {
    if (!awaitingFirstResponseRef.current) {
      return;
    }
    const timing = promptTimingRef.current;
    if (timing) {
      const firstVisibleResponseAt = performance.now();
      const rounded = (value: number | undefined) =>
        value === undefined ? null : Math.round(value);
      console.info("[SessionStream][TTFR]", {
        sessionId,
        workerReadyMs: rounded(
          timing.workerReadyAt === undefined ? undefined : timing.workerReadyAt - timing.startedAt,
        ),
        promptSubmittedMs: rounded(
          timing.promptSubmittedAt === undefined
            ? undefined
            : timing.promptSubmittedAt - timing.startedAt,
        ),
        firstEventMs: rounded(
          timing.firstEventAt === undefined ? undefined : timing.firstEventAt - timing.startedAt,
        ),
        firstVisibleResponseMs: rounded(firstVisibleResponseAt - timing.startedAt),
        modelWaitMs: rounded(
          timing.promptSubmittedAt === undefined
            ? undefined
            : firstVisibleResponseAt - timing.promptSubmittedAt,
        ),
      });
    }
    setAwaitingFirstResponse(false);
  };

  const normalizeSessionStatus = (payload: SessionStatusPayload): SessionStatus => ({
    sessionId: payload.session_id,
    state: payload.state,
    seq: payload.seq,
    workerId: payload.worker_id ?? undefined,
    reason: payload.reason ?? undefined,
    detail: payload.detail ?? undefined,
    updatedAt: new Date(payload.updated_at),
  });

  const completeStreamingMessages = () => {
    flushInlineThinkBufferRef.current(isReplayingRef.current);
    flushBufferedStreamUpdateRef.current();
    setMessages((prev) =>
      prev.map((msg) => {
        let updated = msg;
        if (msg.isStreaming) {
          updated = { ...updated, isStreaming: false };
        }
        if (msg.toolCall?.subagentRunning) {
          updated = {
            ...updated,
            // biome-ignore lint/style/noNonNullAssertion: TS narrowing cannot follow the spread (moved verbatim from useSessionStream.ts).
            toolCall: { ...updated.toolCall!, subagentRunning: false },
          };
        }
        return updated;
      }),
    );
  };

  // A worker emits an initial `idle` status as soon as its ACP connection is
  // ready. That is not a completed turn: on the first send it can arrive
  // before the pending prompt has even been forwarded to ACP. Only the
  // matching prompt response is authoritative for auto-renaming.
  const triggerFirstTurnComplete = () => {
    if (!hasTurnStartedRef.current || firstTurnCompleteCalledRef.current) {
      return;
    }

    firstTurnCompleteCalledRef.current = true;
    void onFirstTurnComplete?.();
  };

  // Mark all non-terminal tool calls as interrupted and dismiss stale
  // approval/question dialogs.  Called only when the backend confirms no
  // active turn (idle / stopped / error), so it won't dismiss legitimate
  // pending approvals on a busy session (e.g. after a tab switch).
  const interruptStaleToolCalls = () => {
    pendingApprovalRequestsRef.current.clear();
    pendingQuestionRequestsRef.current.clear();
    optimisticUserMessagesRef.current = [];
    promptRequestIdsRef.current.clear();
    cancelRequestIdsRef.current.clear();
    setMessages((prev) =>
      prev.map((msg) => {
        if (msg.variant !== "tool" || !msg.toolCall) return msg;
        const state = msg.toolCall.state;
        if (
          state === "approval-requested" ||
          state === "question-requested" ||
          state === "input-streaming" ||
          state === "input-available"
        ) {
          return {
            ...msg,
            isStreaming: false,
            toolCall: {
              ...msg.toolCall,
              state: "output-denied",
              ...(state === "approval-requested" && msg.toolCall.approval
                ? {
                    approval: {
                      ...msg.toolCall.approval,
                      submitted: true,
                      resolved: true,
                      approved: false,
                      response: "reject",
                    },
                  }
                : {}),
              ...(state === "question-requested" && msg.toolCall.question
                ? {
                    question: {
                      ...msg.toolCall.question,
                      submitted: true,
                      resolved: true,
                    },
                  }
                : {}),
            },
          };
        }
        return msg;
      }),
    );
  };

  const applySessionStatus = (payload: SessionStatusPayload) => {
    const normalized = normalizeSessionStatus(payload);
    const lastSeq = lastStatusSeqRef.current;
    if (lastSeq !== null && normalized.seq <= lastSeq) {
      return;
    }
    lastStatusSeqRef.current = normalized.seq;
    latestSessionStatusRef.current = normalized;
    setSessionStatus(normalized);
    onSessionStatus?.(normalized);

    const explicitReplayInProgress =
      replayIdRef.current !== null || goalHistoryResyncActiveRef.current;

    switch (normalized.state) {
      case "busy": {
        if (!awaitingIdleRef.current) {
          setStatus("streaming");
        }
        break;
      }
      case "restarting": {
        setStatus("submitted");
        break;
      }
      case "error": {
        setError(new Error(normalized.detail || "消息发送失败"));
        setStatus("error");
        setAwaitingFirstResponse(false);
        awaitingIdleRef.current = false;
        completeStreamingMessages();
        if (!explicitReplayInProgress) {
          interruptStaleToolCalls();
        }
        break;
      }
      case "stopped": {
        if (explicitReplayInProgress) {
          setStatus((current) => (current === "streaming" ? current : "submitted"));
          break;
        }

        setStatus(errorRef.current ? "error" : "ready");
        setAwaitingFirstResponse(false);
        awaitingIdleRef.current = false;
        completeStreamingMessages();
        interruptStaleToolCalls();
        break;
      }
      case "idle": {
        if (explicitReplayInProgress) {
          setStatus((current) => (current === "streaming" ? current : "submitted"));
          break;
        }

        // ACP reports `idle` as soon as the worker connection is ready. A
        // pending prompt can still be waiting to be sent (or for its RPC
        // response) at that point, so treating this as terminal would clear
        // its request id before the real completion arrives.
        if (pendingMessageRef.current !== null || promptRequestIdsRef.current.size > 0) {
          setStatus("submitted");
          break;
        }

        if (errorRef.current) {
          setStatus("error");
          setAwaitingFirstResponse(false);
          awaitingIdleRef.current = false;
          completeStreamingMessages();
          interruptStaleToolCalls();
          break;
        }

        setStatus("ready");
        setAwaitingFirstResponse(false);
        awaitingIdleRef.current = false;
        completeStreamingMessages();
        interruptStaleToolCalls();
        break;
      }
    }
  };

  const syncTauriStatusSnapshot = async (connection: StreamConnection | null, source: string) => {
    if (!sessionId) {
      return false;
    }

    try {
      const statusSnapshot = await wireStatus(sessionId);
      if (connection && wsRef.current !== connection) {
        return false;
      }
      if (!statusSnapshot) {
        return false;
      }
      applySessionStatus(sessionStatusToPayload(statusSnapshot));
      return true;
    } catch (err) {
      console.warn(`[SessionStream] Failed to sync Tauri status after ${source}:`, err);
      return false;
    }
  };

  const updateMessageById = (
    messageId: string,
    transform: (message: LiveMessage) => LiveMessage,
  ) => {
    setMessages((prev) =>
      prev.map((message) => (message.id === messageId ? transform(message) : message)),
    );
  };

  const safeStringify = (value: unknown): string => {
    if (value === null || value === undefined) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };

  type ParsedUserInput = { text: string; attachments: MessageAttachmentPart[] };

  const parseMediaTypeFromDataUrl = (url: string): string | null => {
    if (!url.startsWith("data:")) {
      return null;
    }
    const match = DATA_URL_MEDIA_TYPE_REGEX.exec(url);
    return match?.[1] ?? null;
  };

  const getSessionUploadUrl = (filename?: string): string | undefined => {
    if (!(sessionId && filename)) {
      return undefined;
    }
    const basePath = baseUrl ?? getApiBaseUrl();
    // Media tags (<img>, <video>) cannot send Authorization headers, so the
    // upload URL still carries the token in the query string. Prefer fetch +
    // getAuthHeader() for API calls; this path remains for browser-rendered media.
    const token = getAuthToken();
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${basePath}/api/sessions/${encodeURIComponent(
      sessionId,
    )}/uploads/${encodeURIComponent(filename)}${tokenParam}`;
  };

  const parseUserInput = (input: string | ContentPart[]): ParsedUserInput => {
    if (typeof input === "string") {
      return { text: input, attachments: [] };
    }

    const textParts: string[] = [];
    const attachments: MessageAttachmentPart[] = [];
    const uploadedFilePaths: string[] = [];
    let inUploadedFilesBlock = false;
    const collectUploadedFilePath = (line: string): boolean => {
      const match = NUMBERED_LIST_ITEM_REGEX.exec(line.trim());
      if (!match) {
        return false;
      }
      const filePath = match[1].trim();
      if (!(filePath && (filePath.startsWith("/") || filePath.startsWith("uploads/")))) {
        return false;
      }
      uploadedFilePaths.push(filePath);
      return true;
    };

    // Pending metadata for associating with next image_url part
    let pendingFilename: string | undefined;
    let pendingMediaType: string | undefined;

    // State for collecting document content
    let inDocument = false;
    let documentFilename: string | undefined;
    let documentMediaType: string | undefined;
    let documentContent: string[] = [];

    for (const part of input) {
      if (part.type === "text" || part.type === "input_text") {
        const text = part.text;

        // New format: <image path="/path/to/uploads/file.name" content_type="image/png">
        const imageTagMatch = IMAGE_TAG_REGEX.exec(text);
        if (imageTagMatch) {
          // Extract filename from path
          const fullPath = imageTagMatch[1];
          pendingFilename = fullPath.split("/").pop() ?? fullPath;
          pendingMediaType = imageTagMatch[2];
          continue; // Skip this text part, it's just metadata
        }

        // New format: </image> closing tag - skip it
        if (text.trim() === "</image>") {
          continue;
        }

        // New format: <video path="/path/to/uploads/file.name" content_type="video/mp4">
        const videoTagMatch = VIDEO_TAG_REGEX.exec(text);
        if (videoTagMatch) {
          // Extract filename from path
          const fullPath = videoTagMatch[1];
          pendingFilename = fullPath.split("/").pop() ?? fullPath;
          pendingMediaType = videoTagMatch[2];
          continue; // Skip this text part, it's just metadata
        }

        // New format: </video> closing tag - create attachment if no video_url follows
        if (text.trim() === "</video>") {
          // If we have pending video metadata but no video_url part will follow,
          // create a video attachment from the session uploads.
          if (pendingFilename && pendingMediaType?.startsWith("video/")) {
            const url = getSessionUploadUrl(pendingFilename);
            if (url) {
              attachments.push({
                type: "file",
                mediaType: pendingMediaType,
                filename: pendingFilename,
                url,
              });
            } else {
              attachments.push({
                kind: "video-nopreview",
                mediaType: pendingMediaType,
                filename: pendingFilename,
              });
            }
            pendingFilename = undefined;
            pendingMediaType = undefined;
          }
          continue;
        }

        // New format: <document path="/path/to/uploads/..." content_type="..."> - start collecting
        const documentTagMatch = DOCUMENT_TAG_REGEX.exec(text);
        if (documentTagMatch) {
          inDocument = true;
          // Extract filename from path
          const fullPath = documentTagMatch[1];
          documentFilename = fullPath.split("/").pop() ?? fullPath;
          documentMediaType = documentTagMatch[2];
          documentContent = [];
          continue;
        }

        // New format: </document> - finalize document attachment
        if (text.trim() === "</document>") {
          if (inDocument && documentFilename) {
            const content = documentContent.join("");
            const bytes = new TextEncoder().encode(content);
            const base64 = btoa(String.fromCharCode(...bytes));
            const dataUrl = `data:${documentMediaType ?? "text/plain"};base64,${base64}`;
            attachments.push({
              type: "file",
              mediaType: documentMediaType ?? "text/plain",
              filename: documentFilename,
              url: dataUrl,
            });
          }
          inDocument = false;
          documentFilename = undefined;
          documentMediaType = undefined;
          documentContent = [];
          continue;
        }

        // If inside document, collect content instead of adding to textParts
        if (inDocument) {
          documentContent.push(text);
          continue;
        }

        const lines = text.split(NEWLINE_REGEX);
        const filteredLines: string[] = [];

        for (const line of lines) {
          if (line.includes("<uploaded_files>")) {
            inUploadedFilesBlock = true;
            continue;
          }
          if (line.includes("</uploaded_files>")) {
            inUploadedFilesBlock = false;
            continue;
          }
          if (inUploadedFilesBlock) {
            collectUploadedFilePath(line);
            continue;
          }
          if (collectUploadedFilePath(line)) {
            continue;
          }
          filteredLines.push(line);
        }

        const filteredText = filteredLines.join("\n");

        // Legacy format: `uploads/file.name`
        const legacyMatch = LEGACY_UPLOADS_REGEX.exec(filteredText);
        if (legacyMatch) {
          pendingFilename = legacyMatch[1];
        }

        // Only add non-metadata text parts
        if (filteredText.trim()) {
          textParts.push(filteredText);
        }
        continue;
      }

      if (part.type === "image_url") {
        const inferredMediaType = parseMediaTypeFromDataUrl(part.image_url.url);
        attachments.push({
          type: "file",
          mediaType: pendingMediaType ?? inferredMediaType ?? "image/*",
          filename: pendingFilename,
          url: part.image_url.url,
        });
        pendingFilename = undefined;
        pendingMediaType = undefined;
      }

      if (part.type === "video_url") {
        const inferredMediaType = parseMediaTypeFromDataUrl(part.video_url.url);
        attachments.push({
          type: "file",
          mediaType: pendingMediaType ?? inferredMediaType ?? "video/*",
          filename: pendingFilename,
          url: part.video_url.url,
        });
        pendingFilename = undefined;
        pendingMediaType = undefined;
      }
    }

    if (uploadedFilePaths.length > 0) {
      const existingFilenames = new Set(
        attachments
          .map((attachment) => attachment.filename)
          .filter((filename): filename is string => Boolean(filename)),
      );
      const seenUploadedFilenames = new Set<string>();
      for (const filePath of uploadedFilePaths) {
        const filename = filePath.split("/").pop() ?? filePath;
        if (!filename) {
          continue;
        }
        if (existingFilenames.has(filename) || seenUploadedFilenames.has(filename)) {
          continue;
        }
        attachments.push({
          kind: "nopreview",
          filename,
        });
        seenUploadedFilenames.add(filename);
      }
    }

    return { text: textParts.join("\n\n").trim(), attachments };
  };

  const upsertMessage = (incoming: LiveMessage) => {
    setMessages((prev) => {
      const index = prev.findIndex((message) => message.id === incoming.id);
      if (index === -1) {
        return [...prev, incoming];
      }
      const next = [...prev];
      next[index] = { ...next[index], ...incoming };
      return next;
    });
  };

  // Create unique message ID
  const getNextMessageId = (prefix: "user" | "assistant"): string => createMessageId(prefix);

  const addOptimisticUserMessage = (
    input: string,
    explicitAttachments: UploadSessionFileResponse[] = [],
  ) => {
    const parsedUserInput = parseUserInput(input);
    const turnIndex = turnCounterRef.current;
    turnCounterRef.current += 1;

    const userMessage: LiveMessage = {
      id: getNextMessageId("user"),
      role: "user",
      turnIndex,
      content: parsedUserInput.text,
      ...(parsedUserInput.attachments.length > 0
        ? { attachments: parsedUserInput.attachments }
        : explicitAttachments.length > 0
          ? {
              attachments: explicitAttachments.map((attachment) => ({
                kind: "nopreview" as const,
                filename: attachment.filename,
              })),
            }
          : {}),
    };
    optimisticUserMessagesRef.current.push({
      id: userMessage.id,
      turnIndex,
    });
    hasTurnStartedRef.current = true;
    upsertMessage(userMessage);
  };

  const applyBufferedStreamContent = () => {
    const thinkingMessageId = thinkingMessageIdRef.current;
    const textMessageId = textMessageIdRef.current;
    const thinkingContent = currentThinkingRef.current;
    const textContent = currentTextRef.current;
    if (!thinkingMessageId && !textMessageId) {
      return;
    }

    setMessages((prev) =>
      prev.map((msg) => {
        if (thinkingMessageId && msg.id === thinkingMessageId) {
          return {
            ...msg,
            thinking: thinkingContent,
          };
        }
        if (textMessageId && msg.id === textMessageId) {
          return {
            ...msg,
            content: textContent,
          };
        }
        return msg;
      }),
    );
  };

  const scheduleBufferedStreamUpdate = () => {
    if (streamUpdateFrameRef.current !== null) {
      return;
    }

    streamUpdateFrameRef.current = window.requestAnimationFrame(() => {
      streamUpdateFrameRef.current = null;
      applyBufferedStreamContent();
    });
  };

  const flushBufferedStreamUpdate = () => {
    if (streamUpdateFrameRef.current !== null) {
      window.cancelAnimationFrame(streamUpdateFrameRef.current);
      streamUpdateFrameRef.current = null;
    }
    applyBufferedStreamContent();
  };

  const appendThinkingContent = (delta: string, isReplay: boolean) => {
    if (!delta) {
      return;
    }

    if (!isReplay) {
      clearAwaitingFirstResponse();
    }

    currentThinkingRef.current += delta;
    if (!thinkingMessageIdRef.current) {
      thinkingCompletedRef.current = false;
      thinkingMessageIdRef.current = getNextMessageId("assistant");
      turnStreamBlockIdsRef.current.push(thinkingMessageIdRef.current);
      const thinkingMsg: LiveMessage = {
        id: thinkingMessageIdRef.current,
        role: "assistant",
        variant: "thinking",
        thinking: currentThinkingRef.current,
        isStreaming: !isReplay,
      };

      if (textMessageIdRef.current) {
        setMessages((prev) => {
          const textIndex = prev.findIndex((message) => message.id === textMessageIdRef.current);
          if (textIndex === -1) {
            return [...prev, thinkingMsg];
          }
          const next = [...prev];
          next.splice(textIndex, 0, thinkingMsg);
          return next;
        });
      } else {
        upsertMessage(thinkingMsg);
      }
      return;
    }

    scheduleBufferedStreamUpdate();
  };

  const appendTextContent = (delta: string, isReplay: boolean) => {
    if (!delta) {
      return;
    }

    if (!isReplay) {
      clearAwaitingFirstResponse();
    }

    if (thinkingMessageIdRef.current && !thinkingCompletedRef.current) {
      thinkingCompletedRef.current = true;
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === thinkingMessageIdRef.current ? { ...msg, isStreaming: false } : msg,
        ),
      );
    }

    currentTextRef.current += delta;
    if (!textMessageIdRef.current) {
      textMessageIdRef.current = getNextMessageId("assistant");
      turnStreamBlockIdsRef.current.push(textMessageIdRef.current);
      upsertMessage({
        id: textMessageIdRef.current,
        role: "assistant",
        variant: "text",
        turnIndex: turnCounterRef.current > 0 ? turnCounterRef.current - 1 : undefined,
        content: currentTextRef.current,
        isStreaming: !isReplay,
      });
      return;
    }

    scheduleBufferedStreamUpdate();
  };

  const appendInlineThinkSegments = (segments: InlineThinkSegment[], isReplay: boolean) => {
    for (const segment of segments) {
      if (segment.kind === "think") {
        appendThinkingContent(segment.value, isReplay);
      } else {
        appendTextContent(segment.value, isReplay);
      }
    }
  };

  const flushInlineThinkBuffer = (isReplay: boolean) => {
    appendInlineThinkSegments(flushInlineThinkText(inlineThinkParserRef.current), isReplay);
  };

  flushBufferedStreamUpdateRef.current = flushBufferedStreamUpdate;
  flushInlineThinkBufferRef.current = flushInlineThinkBuffer;

  // Seal the currently streaming thinking/text blocks at a message boundary
  // (e.g. a tool call). Live ACP never emits StepBegin, so without this the
  // next thinking/text chunk would keep merging into the first block of the
  // turn instead of opening a new block after the boundary.
  const sealOpenStreamBlocks = () => {
    flushBufferedStreamUpdate();
    const thinkingMessageId = thinkingMessageIdRef.current;
    const textMessageId = textMessageIdRef.current;
    if (!thinkingMessageId && !textMessageId) {
      return;
    }
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === thinkingMessageId || msg.id === textMessageId
          ? { ...msg, isStreaming: false }
          : msg,
      ),
    );
    currentThinkingRef.current = "";
    currentTextRef.current = "";
    thinkingCompletedRef.current = false;
    thinkingMessageIdRef.current = null;
    textMessageIdRef.current = null;
  };

  // Reset state for new step
  const resetStepState = () => {
    flushInlineThinkBuffer(isReplayingRef.current);
    flushBufferedStreamUpdate();
    currentThinkingRef.current = "";
    currentTextRef.current = "";
    inlineThinkParserRef.current = { inThink: false, buffer: "" };
    thinkingCompletedRef.current = false;
    thinkingMessageIdRef.current = null;
    textMessageIdRef.current = null;
    turnStreamBlockIdsRef.current = [];
  };

  const clearStepRetryStatus = () => {
    const statusMessageId = stepRetryStatusMessageIdRef.current;
    if (!statusMessageId) {
      return;
    }
    stepRetryStatusMessageIdRef.current = null;
    setMessages((prev) => prev.filter((msg) => msg.id !== statusMessageId));
  };

  const showStepRetryStatus = (retry: StepRetryPayload, isReplay: boolean) => {
    const content = formatStepRetryStatus(retry);
    const existingMessageId = stepRetryStatusMessageIdRef.current;

    if (existingMessageId) {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === existingMessageId ? { ...msg, content, isStreaming: !isReplay } : msg,
        ),
      );
      return;
    }

    const statusMessageId = getNextMessageId("assistant");
    stepRetryStatusMessageIdRef.current = statusMessageId;
    setMessages((prev) => [
      ...prev,
      {
        id: statusMessageId,
        role: "assistant",
        variant: "status",
        content,
        isStreaming: !isReplay,
      },
    ]);
  };

  const discardRetryAttemptMessages = () => {
    const messageIds = new Set<string>();
    const discardedToolCallIds = new Set<string>();
    for (const id of turnStreamBlockIdsRef.current) {
      messageIds.add(id);
    }
    if (thinkingMessageIdRef.current) {
      messageIds.add(thinkingMessageIdRef.current);
    }
    if (textMessageIdRef.current) {
      messageIds.add(textMessageIdRef.current);
    }
    // Only discard tool calls that haven't produced a result yet — i.e. the
    // ones still in-flight when the retry fires. Tool calls from earlier
    // successful steps in the same turn already have `tc.result` set by
    // ToolResult and must be preserved.
    for (const toolCall of currentToolCallsRef.current.values()) {
      if (toolCall.result !== undefined) {
        continue;
      }
      discardedToolCallIds.add(toolCall.id);
      if (toolCall.messageId) {
        messageIds.add(toolCall.messageId);
      }
    }

    resetStepState();
    for (const id of discardedToolCallIds) {
      currentToolCallsRef.current.delete(id);
    }
    if (
      currentToolCallIdRef.current !== null &&
      discardedToolCallIds.has(currentToolCallIdRef.current)
    ) {
      currentToolCallIdRef.current = null;
    }
    for (const [requestId, request] of pendingApprovalRequestsRef.current) {
      if (discardedToolCallIds.has(request.toolCallId)) {
        pendingApprovalRequestsRef.current.delete(requestId);
      }
    }
    for (const [requestId, request] of pendingQuestionRequestsRef.current) {
      if (discardedToolCallIds.has(request.toolCallId)) {
        pendingQuestionRequestsRef.current.delete(requestId);
      }
    }

    if (messageIds.size > 0) {
      setMessages((prev) => prev.filter((msg) => !messageIds.has(msg.id)));
    }
  };

  // Reset all state
  const resetState = (preserveSlashCommands = false, preserveSessionState = false) => {
    if (!preserveSessionState) {
      goalHistoryResyncGenerationRef.current += 1;
      goalHistoryResyncActiveRef.current = false;
      goalHistoryReplayBufferRef.current = null;
    }
    resetStepState();
    stepRetryStatusMessageIdRef.current = null;
    currentToolCallsRef.current?.clear();
    currentToolCallIdRef.current = null;
    pendingApprovalRequestsRef.current?.clear();
    pendingQuestionRequestsRef.current?.clear();
    optimisticUserMessagesRef.current = [];
    promptRequestIdsRef.current.clear();
    cancelRequestIdsRef.current.clear();
    pendingClearRef.current = false;
    pendingCompactRef.current = false;
    compactionMessageIdRef.current = null;
    setCurrentStep(0);
    setContextUsage(0);
    setContextTokens(null);
    setMaxContextTokens(null);
    setTokenUsage(null);
    if (!preserveSessionState) {
      setPlanMode(false);
      planModeRef.current = false;
      setPermissionMode("manual");
      permissionModeRef.current = "manual";
      setSwarmMode(false);
      swarmModeRef.current = false;
      setGoalMode(false);
      goalModeRef.current = false;
      setSessionConfigState(emptySessionConfigState(sessionId ?? ""));
      setSessionConfigUpdating(false);
      setSessionStatus(null);
      latestSessionStatusRef.current = null;
      lastStatusSeqRef.current = null;
    }
    if (!preserveSessionState) {
      setError(null);
    }
    initializeIdRef.current = null;
    replayIdRef.current = null;
    initializeRetryCountRef.current = 0;
    isReplayingRef.current = true;
    setIsReplayingHistory(true);
    setAwaitingFirstResponse(false);
    if (!preserveSessionState) {
      // Reset first turn tracking only when ownership changes. A Goal
      // catch-up replay must not trigger auto-rename a second time.
      hasTurnStartedRef.current = false;
      firstTurnCompleteCalledRef.current = false;
    }
    // Reset turn counter
    turnCounterRef.current = 0;
    // Clear history_complete timeout
    if (historyCompleteTimeoutRef.current) {
      window.clearTimeout(historyCompleteTimeoutRef.current);
      historyCompleteTimeoutRef.current = null;
    }
    // Handle slashCommands: preserve or clear
    if (!preserveSlashCommands) {
      setSlashCommands([]);
      slashCommandsLenRef.current = 0;
      usingCachedCommandsRef.current = false;
    } else if (slashCommandsLenRef.current > 0) {
      usingCachedCommandsRef.current = true;
    }
  };

  const applySessionConfigFromWire = (payload: ConfigOptionUpdateEvent["payload"]) => {
    const targetSessionId = payload.session_id;
    if (!targetSessionId || targetSessionId !== sessionId) {
      return;
    }
    setSessionConfigState((prev) => {
      const nextMap = applyConfigOptionWirePayload(
        { [targetSessionId]: prev },
        payload as Record<string, unknown>,
      );
      const next = nextMap[targetSessionId] ?? emptySessionConfigState(targetSessionId);
      sessionConfigStateRef.current = next;
      return next;
    });

    const modeOption = payload.options.find((option) => option.id === "mode");
    const mapped = runtimeModesFromSessionModeValue(
      modeOption?.currentValue ?? modeOption?.current_value,
    );
    if (!mapped) {
      return;
    }
    if (typeof pendingModeUpdatesRef.current.planMode !== "boolean") {
      setPlanMode(mapped.planMode);
      planModeRef.current = mapped.planMode;
    }
    if (!pendingModeUpdatesRef.current.permissionMode) {
      setPermissionMode(mapped.permissionMode);
      permissionModeRef.current = mapped.permissionMode;
    }
  };

  // Accumulate inner subagent events into a steps array. Recurses into
  // nested SubagentEvents so subagents spawned by subagents render as
  // their own nested step group instead of being dropped.
  const accumulateSubagentSteps = (
    steps: SubagentStep[],
    innerType: string,
    innerPayload: unknown,
    agentId?: string,
    subagentType?: string,
  ) => {
    switch (innerType) {
      case "ContentPart": {
        const cp = innerPayload as {
          type: string;
          think?: string;
          text?: string;
        };
        if (cp.type === "think" && cp.think) {
          const last = steps[steps.length - 1];
          if (last?.kind === "thinking") {
            steps[steps.length - 1] = {
              ...last,
              text: last.text + cp.think,
            };
          } else {
            steps.push({ kind: "thinking", text: cp.think });
          }
        } else if (cp.type === "text" && cp.text) {
          const last = steps[steps.length - 1];
          if (last?.kind === "text") {
            steps[steps.length - 1] = {
              ...last,
              text: last.text + cp.text,
            };
          } else {
            steps.push({ kind: "text", text: cp.text });
          }
        }
        break;
      }

      case "ToolCall": {
        const tc = innerPayload as {
          type: string;
          id: string;
          function: { name: string; arguments: string };
        };
        const initialArgs = tc.function.arguments || "";
        let parsedInput: unknown;
        try {
          parsedInput = JSON.parse(initialArgs || "{}");
        } catch {
          // not valid JSON yet
        }
        steps.push({
          kind: "tool-call",
          toolCallId: tc.id,
          toolName: tc.function.name,
          rawArgs: initialArgs,
          input: parsedInput,
          status: "running",
        });
        break;
      }

      case "ToolCallPart": {
        const tcp = innerPayload as { arguments_part: string };
        // Find the last running tool-call step and append arguments
        for (let i = steps.length - 1; i >= 0; i--) {
          const step = steps[i];
          if (step.kind === "tool-call" && step.status === "running") {
            const newArgs = (step.rawArgs ?? "") + tcp.arguments_part;
            let parsedInput: unknown;
            try {
              parsedInput = JSON.parse(newArgs);
            } catch {
              // not complete JSON yet
            }
            steps[i] = {
              ...step,
              rawArgs: newArgs,
              input: parsedInput ?? step.input,
            };
            break;
          }
        }
        break;
      }

      case "ToolResult": {
        const tr = innerPayload as {
          tool_call_id: string;
          return_value: {
            is_error: boolean;
            output: Array<{ text?: string }> | string;
            message: string;
          };
        };
        for (let i = steps.length - 1; i >= 0; i--) {
          const step = steps[i];
          if (step.kind === "tool-call" && step.toolCallId === tr.tool_call_id) {
            const outputStr = Array.isArray(tr.return_value.output)
              ? tr.return_value.output
                  .map((p) => p.text ?? "")
                  .filter(Boolean)
                  .join("\n")
              : tr.return_value.output;
            steps[i] = {
              ...step,
              status: tr.return_value.is_error ? "error" : "success",
              output: outputStr || undefined,
              errorText: tr.return_value.is_error
                ? tr.return_value.message || undefined
                : undefined,
            };
            break;
          }
        }
        break;
      }

      case "StepRetry": {
        const retainedSteps = discardSubagentRetryAttempt(steps);
        steps.length = 0;
        steps.push(...retainedSteps);
        break;
      }

      case "SubagentEvent": {
        // innerPayload is the nested SubagentEvent's payload object
        // (parent_tool_call_id / agent_id / subagent_type / event).
        const nestedPayload = innerPayload as {
          parent_tool_call_id?: string | null;
          agent_id?: string | null;
          subagent_type?: string | null;
          event: { type: string; payload: unknown };
        };
        const nestedAgentId = nestedPayload.agent_id ?? undefined;
        const nestedToolCallId = nestedPayload.parent_tool_call_id ?? undefined;

        const nestedIdx = steps.findIndex(
          (step) => step.kind === "subagent" && step.agentId === (nestedAgentId ?? ""),
        );
        const existingNested =
          nestedIdx >= 0
            ? (steps[nestedIdx] as Extract<SubagentStep, { kind: "subagent" }>)
            : undefined;
        const nestedSteps = existingNested ? [...existingNested.steps] : [];
        accumulateSubagentSteps(
          nestedSteps,
          nestedPayload.event.type,
          nestedPayload.event.payload,
          nestedPayload.agent_id ?? undefined,
          nestedPayload.subagent_type ?? subagentType,
        );
        const nestedStep: Extract<SubagentStep, { kind: "subagent" }> = {
          kind: "subagent",
          agentId: nestedAgentId ?? nestedToolCallId ?? agentId ?? "",
          agentType: existingNested?.agentType ?? nestedPayload.subagent_type ?? subagentType,
          status: existingNested?.status ?? "running",
          steps: nestedSteps,
        };
        if (nestedIdx >= 0) steps[nestedIdx] = nestedStep;
        else steps.push(nestedStep);
        break;
      }

      default:
        // Ignore StepBegin, TurnBegin, TurnEnd, StatusUpdate, etc.
        break;
    }
  };

  // Process a SubagentEvent: accumulate inner events into parent Agent tool's subagentSteps
  const processSubagentEvent = (
    parentToolCallId: string,
    innerType: string,
    innerPayload: unknown,
    agentId?: string,
    subagentType?: string,
  ) => {
    // Nested SubagentEvents: keep the agent-monitor hierarchy intact by
    // recursing the sync with the inner event's own parent link. The
    // inner payload is itself a SubagentEvent payload object.
    if (innerType === "SubagentEvent") {
      const nestedPayload = innerPayload as {
        parent_tool_call_id?: string | null;
        agent_id?: string | null;
        subagent_type?: string | null;
        event: { type: string; payload: unknown };
      };
      syncAgentMonitorFromSubagentEvent(
        nestedPayload.parent_tool_call_id ?? parentToolCallId,
        nestedPayload.event.type,
        nestedPayload.event.payload,
        nestedPayload.agent_id ?? undefined,
        nestedPayload.subagent_type ?? subagentType,
        sessionId ?? undefined,
      );
    }

    syncAgentMonitorFromSubagentEvent(
      parentToolCallId,
      innerType,
      innerPayload,
      agentId,
      subagentType,
      sessionId ?? undefined,
    );

    setMessages((prev) => {
      // Find the parent Agent tool message by toolCallId
      const parentIdx = prev.findIndex((msg) => msg.toolCall?.toolCallId === parentToolCallId);
      if (parentIdx === -1) return prev;

      const parentMsg = prev[parentIdx];
      const steps: SubagentStep[] = [...(parentMsg.toolCall?.subagentSteps ?? [])];

      accumulateSubagentSteps(steps, innerType, innerPayload, agentId, subagentType);

      const next = [...prev];
      next[parentIdx] = {
        ...parentMsg,
        toolCall: {
          // biome-ignore lint/style/noNonNullAssertion: TS narrowing cannot follow the spread (moved verbatim from useSessionStream.ts).
          ...parentMsg.toolCall!,
          subagentSteps: steps,
          subagentRunning: true,
          // Preserve existing values; only set if provided and not yet set
          subagentType: parentMsg.toolCall?.subagentType ?? subagentType,
          subagentAgentId: parentMsg.toolCall?.subagentAgentId ?? agentId,
        },
      };
      return next;
    });
  };

  const syncGoalSnapshot = async (targetSessionId = sessionId) => {
    if (!targetSessionId || !isTauri()) return null;
    const requestSeq = ++goalSnapshotRequestSeqRef.current;
    const snapshot = await getSessionGoalSnapshot(targetSessionId);
    if (
      requestSeq === goalSnapshotRequestSeqRef.current &&
      targetSessionId === activeSessionIdRef.current
    ) {
      useToolEventsStore.getState().setCurrentGoal(snapshot);
    }
    return snapshot;
  };
  // Process a single wire event
  const processEvent = (event: WireEvent, isReplay = false, rpcMessageId?: string | number) => {
    if (!isReplay && awaitingFirstResponseRef.current) {
      const timing = promptTimingRef.current;
      if (timing && timing.firstEventAt === undefined) {
        timing.firstEventAt = performance.now();
      }
    }
    switch (event.type) {
      case "TurnBegin": {
        // Reset step state to ensure slash commands create new messages
        clearStepRetryStatus();
        resetStepState();

        const parsedUserInput = parseUserInput(event.payload.user_input);

        // ACP echoes prompts without their request ID. Prompts are serialized,
        // so reconcile the next live echo with the locally displayed message.
        const optimisticUserMessage = isReplay
          ? undefined
          : optimisticUserMessagesRef.current.shift();

        // Track turn index for fork feature
        const currentTurnIndex = optimisticUserMessage?.turnIndex ?? turnCounterRef.current;
        if (!optimisticUserMessage) {
          turnCounterRef.current += 1;
        }

        // Track that at least one turn has started (for auto-rename trigger)
        if (!isReplay) {
          hasTurnStartedRef.current = true;
        }

        // Check if this is a /clear or /reset command (needs UI clear)
        const userText = parsedUserInput.text.trim();
        pendingClearRef.current = userText === "/clear" || userText === "/reset";
        const slash = parseSlashCommandInput(userText);
        if (slash?.name === "compact") {
          // Slash compaction is a command, not a chat turn — keep the
          // Compacting… status row and skip the user bubble.
          pendingCompactRef.current = true;
          break;
        }

        // Add user message
        const userMessageId = getNextMessageId("user");
        const userMessage: LiveMessage = {
          id: optimisticUserMessage?.id ?? userMessageId,
          role: "user",
          turnIndex: currentTurnIndex,
          content:
            parsedUserInput.text ||
            (parsedUserInput.attachments.length > 0
              ? ""
              : safeStringify(event.payload.user_input ?? "")),
          ...(parsedUserInput.attachments.length > 0
            ? { attachments: parsedUserInput.attachments }
            : {}),
        };

        upsertMessage(userMessage);
        break;
      }

      case "SteerInput": {
        const parsedUserInput = parseUserInput(event.payload.user_input);
        const optimisticUserMessage = isReplay
          ? undefined
          : optimisticUserMessagesRef.current.shift();

        // Optimistic sends are initially counted as turns. A SteerInput belongs
        // to the active turn, so return that provisional counter slot.
        if (optimisticUserMessage) {
          turnCounterRef.current = Math.max(0, turnCounterRef.current - 1);
        }
        const activeTurnIndex = turnCounterRef.current > 0 ? turnCounterRef.current - 1 : undefined;

        upsertMessage({
          id: optimisticUserMessage?.id ?? getNextMessageId("user"),
          role: "user",
          variant: "steer",
          turnIndex: activeTurnIndex,
          content:
            parsedUserInput.text ||
            (parsedUserInput.attachments.length > 0
              ? ""
              : safeStringify(event.payload.user_input ?? "")),
          ...(parsedUserInput.attachments.length > 0
            ? { attachments: parsedUserInput.attachments }
            : {}),
        });
        break;
      }

      case "StepBegin": {
        setCurrentStep(event.payload.n);
        clearStepRetryStatus();
        resetStepState();
        if (!isReplay) {
          setStatus("streaming");
        }
        break;
      }

      case "StepRetry": {
        discardRetryAttemptMessages();
        showStepRetryStatus(event.payload, isReplay);
        if (!isReplay) {
          clearAwaitingFirstResponse();
          setStatus("streaming");
        }
        break;
      }

      case "ContentPart": {
        // /compact streams summarization tokens over ACP as normal chunks;
        // keep the command UI (Compacting…) instead of a chat reply.
        if (pendingCompactRef.current) {
          if (!isReplay) {
            clearAwaitingFirstResponse();
            setStatus("streaming");
          }
          break;
        }
        clearStepRetryStatus();
        // Live ACP does not emit StepBegin; promote status on the first
        // content chunk so the composer/status strip leave "submitted".
        if (!isReplay) {
          setStatus("streaming");
        }
        if (event.payload.type === "think" && event.payload.think) {
          flushInlineThinkBuffer(isReplay);
          appendThinkingContent(event.payload.think, isReplay);
        } else if (event.payload.type === "text" && event.payload.text) {
          appendInlineThinkSegments(
            consumeInlineThinkText(inlineThinkParserRef.current, event.payload.text),
            isReplay,
          );
        } else if (
          event.payload.type === "image_url" ||
          event.payload.type === "audio_url" ||
          event.payload.type === "video_url"
        ) {
          const media = event.payload[event.payload.type];
          if (media?.url) {
            if (!isReplay) {
              clearAwaitingFirstResponse();
            }
            // Finish the preceding text block so later text is inserted after
            // the attachment instead of being merged ahead of it.
            flushBufferedStreamUpdate();
            if (textMessageIdRef.current) {
              const completedTextId = textMessageIdRef.current;
              setMessages((prev) =>
                prev.map((message) =>
                  message.id === completedTextId ? { ...message, isStreaming: false } : message,
                ),
              );
              textMessageIdRef.current = null;
              currentTextRef.current = "";
            }

            const mediaKind = event.payload.type.replace("_url", "");
            const filename =
              media.id ??
              (() => {
                try {
                  return new URL(media.url).pathname.split("/").pop();
                } catch {
                  return undefined;
                }
              })() ??
              mediaKind;
            upsertMessage({
              id: getNextMessageId("assistant"),
              role: "assistant",
              variant: "text",
              turnIndex: turnCounterRef.current > 0 ? turnCounterRef.current - 1 : undefined,
              content: "",
              attachments: [
                {
                  type: "file",
                  mediaType: `${mediaKind}/*`,
                  filename,
                  url: media.url,
                },
              ],
              isStreaming: false,
            });
          }
        }
        break;
      }

      case "ToolCall": {
        clearStepRetryStatus();
        if (!isReplay) {
          clearAwaitingFirstResponse();
          setStatus("streaming");
        }
        // A tool call is a hard boundary: seal any open thinking/text block
        // so later chunks open new blocks after the tool card (live ACP
        // never emits StepBegin to do this for us).
        sealOpenStreamBlocks();
        const toolCall = event.payload;
        currentToolCallIdRef.current = toolCall.id;

        // Initialize tool call state
        const initialArgs = toolCall.function.arguments || "";
        currentToolCallsRef.current.set(toolCall.id, {
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: initialArgs,
          argumentsComplete: false,
          messageId: undefined,
        });

        // Parse initial arguments if available
        let parsedInput: unknown;
        if (initialArgs) {
          try {
            parsedInput = JSON.parse(initialArgs);
          } catch {
            // Not valid JSON yet, leave as undefined
          }
        }

        // Create tool message
        const toolMessageId = getNextMessageId("assistant");
        upsertMessage({
          id: toolMessageId,
          role: "assistant",
          variant: "tool",
          toolCall: {
            title: toolCall.function.name,
            type: "tool-call" as ToolUIPart["type"],
            state: "input-streaming" as ToolUIPart["state"],
            toolCallId: toolCall.id,
            input: parsedInput,
          },
          isStreaming: !isReplay,
        });

        // Store message ID in tool call state for later updates
        const tc = currentToolCallsRef.current.get(toolCall.id);
        if (tc) {
          tc.messageId = toolMessageId;
        }
        break;
      }

      case "ToolCallPart": {
        if (currentToolCallIdRef.current) {
          const tc = currentToolCallsRef.current.get(currentToolCallIdRef.current);
          if (tc) {
            tc.arguments += event.payload.arguments_part;

            const messageId = tc.messageId;
            if (messageId) {
              let parsedInput: unknown = tc.arguments;
              try {
                parsedInput = JSON.parse(tc.arguments);
              } catch {
                // Not complete JSON yet
              }

              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === messageId && msg.toolCall
                    ? {
                        ...msg,
                        toolCall: {
                          ...msg.toolCall,
                          state: "input-available" as ToolUIPart["state"],
                          input: parsedInput,
                        },
                      }
                    : msg,
                ),
              );
            }
          }
        }
        break;
      }

      case "ToolResult": {
        clearStepRetryStatus();
        if (!isReplay) {
          clearAwaitingFirstResponse();
        }
        const { tool_call_id, return_value } = event.payload;
        const tc = currentToolCallsRef.current.get(tool_call_id);

        const outputStr = Array.isArray(return_value.output)
          ? return_value.output
              .map((part) => part.text ?? "")
              .filter(Boolean)
              .join("\n")
          : return_value.output;

        // Extract media parts (image_url/video_url) from output array
        let mediaParts: Array<{ type: "image_url" | "video_url"; url: string }> = [];
        if (Array.isArray(return_value.output)) {
          mediaParts = return_value.output
            .filter(
              (part: Record<string, unknown>) =>
                part.type === "image_url" || part.type === "video_url",
            )
            .map((part: Record<string, unknown>) => ({
              type: part.type as "image_url" | "video_url",
              url: extractMediaUrl(part),
            }))
            .filter((p) => p.url);

          // For non-browser-renderable URLs (e.g. ms:// from Kimi model),
          // try to construct serving URLs from file paths in text output tags
          const hasNonBrowserUrl = mediaParts.some((p) => !isBrowserUrl(p.url));
          if (hasNonBrowserUrl) {
            const textOutput = return_value.output
              .map((p: Record<string, unknown>) => (p.text as string) ?? "")
              .filter(Boolean)
              .join("");
            // Collect all API URLs from media tags in order
            const apiUrls: string[] = [];
            const basePath = baseUrl ?? getApiBaseUrl();
            for (const match of textOutput.matchAll(MEDIA_TAG_PATH_REGEX)) {
              const [, , sid, filename] = match;
              apiUrls.push(
                `${basePath}/api/sessions/${sid}/uploads/${encodeURIComponent(filename)}`,
              );
            }
            if (apiUrls.length > 0) {
              let apiIdx = 0;
              mediaParts = mediaParts.map((p) => {
                if (isBrowserUrl(p.url)) return p;
                const url = apiUrls[apiIdx] ?? apiUrls[apiUrls.length - 1];
                apiIdx++;
                return { ...p, url };
              });
            }
          }
        }

        const messageStr = return_value.message;
        const extrasRecord =
          return_value.extras && typeof return_value.extras === "object"
            ? (return_value.extras as Record<string, unknown>)
            : undefined;
        // ACP tool_call_update status=in_progress is translated to ToolResult with
        // extras.in_progress. That is a progress tick — not terminal completion.
        const toolStillInProgress = extrasRecord?.in_progress === true;

        if (tc && !toolStillInProgress) {
          tc.argumentsComplete = true;
          tc.result = {
            isError: return_value.is_error,
            output: outputStr || undefined,
            message: messageStr || undefined,
          };
        }

        // Match message by toolCallId directly - this is robust against:
        // 1. Out-of-order ToolResult (parallel tool calls)
        // 2. Missing tc.messageId (race conditions)
        // 3. Replay mode (messages already have toolCallId)
        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.toolCall?.toolCallId !== tool_call_id) return msg;
            if (
              !toolStillInProgress &&
              (msg.toolCall?.subagentRunning || msg.toolCall?.subagentSteps?.length)
            ) {
              const taskId = msg.toolCall.subagentAgentId ?? msg.toolCall.toolCallId;
              if (taskId) {
                completeAgentMonitorTask(
                  taskId,
                  return_value.is_error ? "error" : "success",
                  return_value.is_error ? messageStr || "Subagent failed" : "Completed",
                  sessionId ?? undefined,
                );
              }
            }
            return {
              ...msg,
              toolCall: {
                ...msg.toolCall,
                state: return_value.is_error
                  ? ("output-error" as ToolUIPart["state"])
                  : toolStillInProgress
                    ? ("input-available" as ToolUIPart["state"])
                    : ("output-available" as ToolUIPart["state"]),
                // Aligned with backend ToolReturnValue
                output: outputStr || undefined,
                message: messageStr || undefined,
                display: return_value.display,
                extras: return_value.extras,
                isError: return_value.is_error,
                errorText: return_value.is_error ? messageStr || undefined : undefined,
                mediaParts: mediaParts.length > 0 ? mediaParts : undefined,
                // Only keep subagentRunning for tools that already have subagent
                // activity. ACP in_progress ticks hit every tool — must not mark
                // Bash/Edit/Read as subagent or GenericToolCard shows agent UI.
                subagentRunning: toolStillInProgress
                  ? Boolean(msg.toolCall.subagentRunning || msg.toolCall.subagentSteps?.length)
                  : false,
              },
              isStreaming: toolStillInProgress ? msg.isStreaming : false,
            };
          }),
        );

        if (!toolStillInProgress && currentToolCallIdRef.current === tool_call_id) {
          currentToolCallIdRef.current = null;
        }

        // Handle tool-specific events (e.g., WriteFile → new files notification)
        if (tc && !toolStillInProgress) {
          handleToolResult(tc.name, tc.arguments, return_value.is_error, isReplay);
        }

        const resolvedToolName =
          (typeof extrasRecord?.tool_title === "string" && extrasRecord.tool_title) || tc?.name;
        if (resolvedToolName && sessionId) {
          const syncResult = syncBackgroundTaskFromToolResult({
            sessionId,
            toolCallId: tool_call_id,
            toolName: resolvedToolName,
            toolArguments: tc?.arguments,
            output: typeof outputStr === "string" ? outputStr : undefined,
            isError: return_value.is_error,
            inProgress: toolStillInProgress,
            isReplay,
          });
          maybeNotifyBackgroundTaskComplete(syncResult, isReplay);
        }

        if (
          typeof extrasRecord?.tool_title === "string" &&
          isBackgroundOrCronObservationTool(extrasRecord.tool_title)
        ) {
          setMessages((prev) => {
            if (prev.some((msg) => msg.toolCall?.toolCallId === tool_call_id)) {
              return prev;
            }
            const toolMessageId = getNextMessageId("assistant");
            return [
              ...prev,
              {
                id: toolMessageId,
                role: "assistant",
                variant: "tool",
                toolCall: {
                  title: extrasRecord.tool_title as string,
                  type: "tool-call" as ToolUIPart["type"],
                  state: return_value.is_error
                    ? ("output-error" as ToolUIPart["state"])
                    : toolStillInProgress
                      ? ("input-available" as ToolUIPart["state"])
                      : ("output-available" as ToolUIPart["state"]),
                  toolCallId: tool_call_id,
                  output: typeof outputStr === "string" ? outputStr : undefined,
                  message: messageStr || undefined,
                  display: return_value.display,
                  extras: return_value.extras,
                  isError: return_value.is_error,
                  errorText: return_value.is_error ? messageStr || undefined : undefined,
                },
                isStreaming: false,
              },
            ];
          });
        }

        if (
          tc &&
          !toolStillInProgress &&
          !isReplay &&
          ["creategoal", "getgoal", "updategoal", "setgoalbudget"].includes(tc.name.toLowerCase())
        ) {
          void syncGoalSnapshot().catch((error) => {
            console.warn("[SessionStream] Failed to refresh Goal state:", error);
          });
        }

        // Extract todo list from display blocks
        if (!isReplay && Array.isArray(return_value.display)) {
          const todoBlock = return_value.display.find((d: { type: string }) => d.type === "todo");
          if (todoBlock) {
            useToolEventsStore
              .getState()
              .setTodoItems((todoBlock as unknown as { type: string; items: TodoItem[] }).items);
          }
        }
        break;
      }

      case "ApprovalRequest": {
        if (!isReplay) {
          clearAwaitingFirstResponse();
        }
        const payload = (event as ApprovalRequestEvent).payload;
        const tc = currentToolCallsRef.current.get(payload.tool_call_id);

        if (isReplay) {
          const approvalState = {
            id: payload.id,
            action: payload.action,
            description: payload.description,
            sender: payload.sender,
            toolCallId: payload.tool_call_id,
            toolKind: payload.kind ?? null,
            rpcMessageId,
            submitted: true,
            resolved: true,
            approved: false,
            sourceKind: payload.source_kind ?? null,
            sourceDescription: payload.source_description ?? null,
          };

          if (tc) {
            tc.approval = approvalState;
          }

          const messageId = tc?.messageId;
          const approvalDisplay = payload.display?.length ? payload.display : undefined;
          if (messageId) {
            updateMessageById(messageId, (message) =>
              message.toolCall
                ? {
                    ...message,
                    isStreaming: false,
                    toolCall: {
                      ...message.toolCall,
                      state: "output-denied",
                      approval: approvalState,
                      display: message.toolCall.display ?? approvalDisplay,
                    },
                  }
                : message,
            );
          } else {
            setMessages((prev) => [
              ...prev,
              {
                id: getNextMessageId("assistant"),
                role: "assistant",
                variant: "tool",
                isStreaming: false,
                toolCall: {
                  title: payload.action,
                  type: "tool-call" as ToolUIPart["type"],
                  state: "output-denied",
                  approval: approvalState,
                  display: approvalDisplay,
                },
              },
            ]);
          }
          break;
        }

        const approvalState = {
          id: payload.id,
          action: payload.action,
          description: payload.description,
          sender: payload.sender,
          toolCallId: payload.tool_call_id,
          toolKind: payload.kind ?? null,
          rpcMessageId,
          submitted: false,
          resolved: false,
          sourceKind: payload.source_kind ?? null,
          sourceDescription: payload.source_description ?? null,
        };

        if (tc) {
          tc.approval = approvalState;
        } else {
          const fallbackState: ToolCallState = {
            id: payload.tool_call_id,
            name: payload.action,
            arguments: "",
            argumentsComplete: false,
            messageId: undefined,
            approval: approvalState,
          };
          currentToolCallsRef.current.set(payload.tool_call_id, fallbackState);
        }

        let messageId = tc?.messageId;

        const approvalDisplay = payload.display?.length ? payload.display : undefined;

        if (messageId) {
          updateMessageById(messageId, (message) => {
            if (!message.toolCall) {
              return message;
            }
            return {
              ...message,
              isStreaming: false,
              toolCall: {
                ...message.toolCall,
                state: "approval-requested",
                approval: approvalState,
                // Prefer permission-request preview (plan markdown / diff).
                display:
                  approvalDisplay && approvalDisplay.length > 0
                    ? approvalDisplay
                    : message.toolCall.display,
              },
            };
          });
        } else {
          const isSubagentOrigin = Boolean(payload.agent_id);
          const fallbackMessageId = getNextMessageId("assistant");
          const approvalMessage: LiveMessage = {
            id: fallbackMessageId,
            role: "assistant",
            variant: "tool",
            isStreaming: false,
            toolCall: {
              title: payload.action,
              type: "tool-call" as ToolUIPart["type"],
              state: "approval-requested",
              approval: approvalState,
              display: approvalDisplay,
              ...(isSubagentOrigin && {
                isSubagentOrigin: true,
                subagentType: payload.subagent_type ?? undefined,
                subagentAgentId: payload.agent_id ?? undefined,
              }),
            },
          };

          currentToolCallsRef.current.set(payload.tool_call_id, {
            ...(currentToolCallsRef.current.get(payload.tool_call_id) ?? {
              id: payload.tool_call_id,
              name: payload.action,
              arguments: "",
              argumentsComplete: false,
            }),
            messageId: fallbackMessageId,
          });

          setMessages((prev) => [...prev, approvalMessage]);
          messageId = fallbackMessageId;
        }

        pendingApprovalRequestsRef.current.set(payload.id, {
          requestId: payload.id,
          toolCallId: payload.tool_call_id,
          messageId,
          rpcId: rpcMessageId,
          submitted: false,
        });

        break;
      }

      case "ApprovalRequestResolved": {
        const { request_id, response, feedback } =
          event.payload as ApprovalRequestResolvedEvent["payload"];
        const pending = pendingApprovalRequestsRef.current.get(request_id);

        let tc: ToolCallState | undefined;

        if (pending) {
          tc = currentToolCallsRef.current.get(pending.toolCallId);
        }

        if (!tc) {
          for (const entry of currentToolCallsRef.current.values()) {
            if (entry.approval?.id === request_id) {
              tc = entry;
              break;
            }
          }
        }

        const approval = tc?.approval ?? {
          id: request_id,
          action: "",
          description: "",
          sender: "",
          toolCallId: pending?.toolCallId ?? "",
        };

        let approved: boolean | undefined;
        let reason: string | undefined;

        if (typeof response === "boolean") {
          approved = response;
        } else if (response && typeof response === "object") {
          const candidate = response as {
            approved?: unknown;
            reason?: unknown;
          };
          if (typeof candidate.approved === "boolean") {
            approved = candidate.approved;
          }
          if (typeof candidate.reason === "string") {
            reason = candidate.reason;
          }
        } else if (typeof response === "string") {
          const normalizedResponse = response.toLowerCase();
          if (
            normalizedResponse === "approve" ||
            normalizedResponse === "approve_for_session" ||
            normalizedResponse === "approval" ||
            normalizedResponse === "approved"
          ) {
            approved = true;
          } else if (normalizedResponse === "reject") {
            approved = false;
          } else {
            reason = response;
          }
        }

        const effectiveReason = reason ?? feedback ?? approval.reason;
        const updatedApproval = {
          ...approval,
          response,
          resolved: true,
          submitted: true,
          approved,
          reason: effectiveReason,
        };

        if (tc) {
          tc.approval = updatedApproval;
        }

        const messageId = tc?.messageId ?? pending?.messageId;
        const nextState = approved === false ? "output-denied" : "input-available";
        const nextStreaming = approved !== false;

        if (messageId) {
          updateMessageById(messageId, (message) => {
            if (!message.toolCall) {
              return message;
            }

            // Don't overwrite terminal states — a late ApprovalRequestResolved
            // arriving after cancel() must not flip a denied tool back to active.
            const currentState = message.toolCall.state;
            if (
              currentState === "output-denied" ||
              currentState === "output-available" ||
              currentState === "output-error"
            ) {
              return {
                ...message,
                toolCall: {
                  ...message.toolCall,
                  approval: updatedApproval,
                },
              };
            }

            return {
              ...message,
              isStreaming: nextStreaming,
              toolCall: {
                ...message.toolCall,
                state: nextState,
                approval: updatedApproval,
                errorText:
                  approved === false
                    ? (updatedApproval.reason ?? message.toolCall.errorText)
                    : message.toolCall.errorText,
              },
            };
          });
        }

        if (pending) {
          pendingApprovalRequestsRef.current.delete(pending.requestId);
        } else {
          pendingApprovalRequestsRef.current.delete(request_id);
        }

        break;
      }

      case "QuestionRequest": {
        if (!isReplay) {
          clearAwaitingFirstResponse();
        }
        const qPayload = (event as QuestionRequestEvent).payload;
        // ACP ask-user permission ids are `${parentId}:question:N`; prefer the
        // already-streamed AskUserQuestion tool card so we don't leave a
        // dangling Agent/Generic row beside the QuestionCard.
        const parentToolCallId = resolveAskUserParentToolCallId(qPayload.tool_call_id);
        const qtc =
          currentToolCallsRef.current.get(qPayload.tool_call_id) ??
          (parentToolCallId !== qPayload.tool_call_id
            ? currentToolCallsRef.current.get(parentToolCallId)
            : undefined);

        if (isReplay) {
          const questionState = {
            id: qPayload.id,
            toolCallId: qPayload.tool_call_id,
            questions: qPayload.questions,
            rpcMessageId,
            submitted: true,
            resolved: true,
          };

          const qMessageId = qtc?.messageId;
          if (qMessageId) {
            updateMessageById(qMessageId, (message) =>
              message.toolCall
                ? {
                    ...message,
                    isStreaming: false,
                    toolCall: {
                      ...message.toolCall,
                      title: "AskUserQuestion",
                      state: "question-responded",
                      question: questionState,
                    },
                  }
                : message,
            );
          } else {
            setMessages((prev) => [
              ...prev,
              {
                id: getNextMessageId("assistant"),
                role: "assistant",
                variant: "tool",
                isStreaming: false,
                toolCall: {
                  title: "AskUserQuestion",
                  type: "tool-call" as ToolUIPart["type"],
                  state: "question-responded",
                  question: questionState,
                },
              },
            ]);
          }
          break;
        }

        const questionState = {
          id: qPayload.id,
          toolCallId: qPayload.tool_call_id,
          questions: qPayload.questions,
          rpcMessageId,
          submitted: false,
          resolved: false,
        };

        let qMessageId = qtc?.messageId;

        if (qMessageId) {
          updateMessageById(qMessageId, (message) => {
            if (!message.toolCall) {
              return message;
            }
            return {
              ...message,
              isStreaming: false,
              toolCall: {
                ...message.toolCall,
                title: "AskUserQuestion",
                state: "question-requested",
                question: questionState,
              },
            };
          });
        } else {
          const fallbackMessageId = getNextMessageId("assistant");
          const questionMessage: LiveMessage = {
            id: fallbackMessageId,
            role: "assistant",
            variant: "tool",
            isStreaming: false,
            toolCall: {
              title: "AskUserQuestion",
              type: "tool-call" as ToolUIPart["type"],
              state: "question-requested",
              question: questionState,
            },
          };

          currentToolCallsRef.current.set(qPayload.tool_call_id, {
            ...(currentToolCallsRef.current.get(qPayload.tool_call_id) ?? {
              id: qPayload.tool_call_id,
              name: "AskUserQuestion",
              arguments: "",
              argumentsComplete: false,
            }),
            messageId: fallbackMessageId,
          });

          setMessages((prev) => [...prev, questionMessage]);
          qMessageId = fallbackMessageId;
        }

        // Alias permission toolCallId → parent message so respond/result stay linked.
        if (parentToolCallId !== qPayload.tool_call_id && qtc?.messageId) {
          currentToolCallsRef.current.set(qPayload.tool_call_id, {
            ...(currentToolCallsRef.current.get(qPayload.tool_call_id) ?? {
              id: qPayload.tool_call_id,
              name: "AskUserQuestion",
              arguments: "",
              argumentsComplete: false,
            }),
            messageId: qtc.messageId,
          });
        }

        pendingQuestionRequestsRef.current.set(qPayload.id, {
          requestId: qPayload.id,
          toolCallId: qPayload.tool_call_id,
          messageId: qMessageId,
          rpcId: rpcMessageId,
          submitted: false,
        });

        break;
      }

      case "SubagentEvent": {
        const subPayload = (event as SubagentEventWire).payload;
        // Wire 1.6 uses parent_tool_call_id; fall back to legacy task_tool_call_id
        const parentToolCallId =
          subPayload.parent_tool_call_id ??
          ((subPayload as Record<string, unknown>).task_tool_call_id as string | undefined);
        if (parentToolCallId) {
          processSubagentEvent(
            parentToolCallId,
            subPayload.event.type,
            subPayload.event.payload,
            subPayload.agent_id ?? undefined,
            subPayload.subagent_type ?? undefined,
          );
        }
        break;
      }

      case "TaskCreated": {
        syncAgentMonitorFromTaskCreated(event as TaskCreatedEvent);
        break;
      }

      case "TaskProgress": {
        syncAgentMonitorFromTaskProgress(event as TaskProgressEvent);
        break;
      }

      case "TaskCompleted": {
        syncAgentMonitorFromTaskCompleted(event as TaskCompletedEvent);
        break;
      }

      case "SubagentLifecycle": {
        syncAgentMonitorFromSubagentLifecycle(event as SubagentLifecycleEvent);
        break;
      }

      case "StatusUpdate": {
        clearStepRetryStatus();
        const nextContextUsage = event.payload.context_usage;
        if (typeof nextContextUsage === "number") {
          setContextUsage(nextContextUsage);
        }

        const nextContextTokens = event.payload.context_tokens;
        if (typeof nextContextTokens === "number") {
          setContextTokens(nextContextTokens);
        }

        const nextMaxContextTokens = event.payload.max_context_tokens;
        if (typeof nextMaxContextTokens === "number") {
          setMaxContextTokens(nextMaxContextTokens);
        }

        const nextTokenUsage = event.payload.token_usage;
        if (nextTokenUsage) {
          setTokenUsage(nextTokenUsage);
        }

        const nextPlanMode = event.payload.plan_mode;
        if (
          typeof nextPlanMode === "boolean" &&
          typeof pendingModeUpdatesRef.current.planMode !== "boolean"
        ) {
          setPlanMode(nextPlanMode);
          planModeRef.current = nextPlanMode;
        }

        const rawPermissionMode = event.payload.permission_mode;
        const nextPermissionMode = rawPermissionMode === "ask" ? "manual" : rawPermissionMode;
        if (
          (nextPermissionMode === "manual" ||
            nextPermissionMode === "auto" ||
            nextPermissionMode === "yolo") &&
          !pendingModeUpdatesRef.current.permissionMode
        ) {
          setPermissionMode(nextPermissionMode);
          permissionModeRef.current = nextPermissionMode;
        }

        const nextSwarmMode = event.payload.swarm_mode;
        if (
          typeof nextSwarmMode === "boolean" &&
          typeof pendingModeUpdatesRef.current.swarmMode !== "boolean"
        ) {
          setSwarmMode(nextSwarmMode);
          swarmModeRef.current = nextSwarmMode;
        }

        if (event.payload.goal_refresh && !isReplay) {
          void syncGoalSnapshot().catch((error) => {
            console.warn("[SessionStream] Failed to refresh native Goal:", error);
          });
        }

        const nextGoalMode = event.payload.goal_mode;
        if (
          typeof nextGoalMode === "boolean" &&
          typeof pendingModeUpdatesRef.current.goalMode !== "boolean"
        ) {
          setGoalMode(nextGoalMode);
          goalModeRef.current = nextGoalMode;
        }

        // If we have a message_id, create a special message to display it
        const messageId = event.payload.message_id;
        if (messageId) {
          const displayMessageId = getNextMessageId("assistant");
          upsertMessage({
            id: displayMessageId,
            role: "assistant",
            variant: "message-id",
            messageId,
          });
        }

        // Clear UI for /clear command (triggered by StatusUpdate after clear)
        if (pendingClearRef.current) {
          pendingClearRef.current = false;
          setMessages((prev) => {
            let lastUserMsgIndex = -1;
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].role === "user") {
                lastUserMsgIndex = i;
                break;
              }
            }
            return lastUserMsgIndex >= 0 ? prev.slice(lastUserMsgIndex) : [];
          });
        }
        break;
      }

      case "SessionNotice": {
        if (!isReplay) {
          clearAwaitingFirstResponse();
        }
        if (event.payload.text) {
          setMessages((prev) => [
            ...prev,
            {
              id: getNextMessageId("assistant"),
              role: "assistant",
              variant: "status",
              content: event.payload.text,
            },
          ]);
        }
        break;
      }

      case "StepInterrupted": {
        clearStepRetryStatus();
        completeRunningAgentMonitorTasks("error", "Interrupted", sessionId ?? undefined);
        // Clear pending approval and question requests
        pendingApprovalRequestsRef.current.clear();
        pendingQuestionRequestsRef.current.clear();
        promptRequestIdsRef.current.clear();
        cancelRequestIdsRef.current.clear();

        setMessages((prev) =>
          prev.map((msg) => {
            let updated = msg;
            if (msg.isStreaming) {
              updated = { ...updated, isStreaming: false };
            }
            // Mark subagent as no longer running
            if (msg.toolCall?.subagentRunning) {
              updated = {
                ...updated,
                toolCall: {
                  // biome-ignore lint/style/noNonNullAssertion: TS narrowing cannot follow the spread (moved verbatim from useSessionStream.ts).
                  ...updated.toolCall!,
                  subagentRunning: false,
                },
              };
            }
            // Update pending approval tool states to denied
            if (msg.variant === "tool" && msg.toolCall?.state === "approval-requested") {
              return {
                ...updated,
                toolCall: {
                  ...msg.toolCall,
                  ...updated.toolCall,
                  state: "output-denied",
                  approval: msg.toolCall.approval
                    ? {
                        ...msg.toolCall.approval,
                        submitted: true,
                        resolved: true,
                        approved: false,
                        response: "reject",
                      }
                    : undefined,
                },
              };
            }
            // Update pending question tool states to responded
            if (msg.variant === "tool" && msg.toolCall?.state === "question-requested") {
              return {
                ...updated,
                toolCall: {
                  ...msg.toolCall,
                  ...updated.toolCall,
                  state: "question-responded",
                  question: msg.toolCall.question
                    ? {
                        ...msg.toolCall.question,
                        submitted: true,
                        resolved: true,
                      }
                    : undefined,
                },
              };
            }
            // Mark still-running tool calls as interrupted
            if (
              msg.variant === "tool" &&
              (updated.toolCall?.state === "input-streaming" ||
                updated.toolCall?.state === "input-available")
            ) {
              return {
                ...updated,
                toolCall: {
                  ...updated.toolCall,
                  state: "output-denied",
                },
              };
            }
            return updated;
          }),
        );
        setAwaitingFirstResponse(false);
        if (awaitingIdleRef.current) {
          setStatus("submitted");
        } else {
          setStatus("ready");
        }
        break;
      }

      case "CompactionBegin": {
        pendingCompactRef.current = true;
        const compactionMsgId = getNextMessageId("assistant");
        compactionMessageIdRef.current = compactionMsgId;
        setMessages((prev) => [
          ...prev,
          {
            id: compactionMsgId,
            role: "assistant",
            variant: "status",
            content: "Compacting conversation history…",
            isStreaming: true,
          },
        ]);
        break;
      }

      case "CompactionEnd": {
        const compactMsgId = compactionMessageIdRef.current;
        compactionMessageIdRef.current = null;
        pendingCompactRef.current = false;
        // Clear old messages after compaction, only keep the current turn
        // Also remove the compaction indicator message
        setMessages((prev) => {
          let lastUserMsgIndex = -1;
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === "user") {
              lastUserMsgIndex = i;
              break;
            }
          }
          const kept = lastUserMsgIndex >= 0 ? prev.slice(lastUserMsgIndex) : [];
          const withoutIndicator = compactMsgId ? kept.filter((m) => m.id !== compactMsgId) : kept;
          if (withoutIndicator.length > 0) return withoutIndicator;
          return [
            {
              id: getNextMessageId("assistant"),
              role: "assistant",
              variant: "status",
              content: "Context compacted.",
              isStreaming: false,
            },
          ];
        });
        break;
      }

      case "MCPLoadingBegin": {
        const mcpMsgId = getNextMessageId("assistant");
        mcpLoadingMessageIdRef.current = mcpMsgId;
        setMessages((prev) => [
          ...prev,
          {
            id: mcpMsgId,
            role: "assistant",
            variant: "status",
            content: "Connecting to MCP servers…",
            isStreaming: true,
          },
        ]);
        break;
      }

      case "MCPLoadingEnd": {
        const mcpMsgId = mcpLoadingMessageIdRef.current;
        mcpLoadingMessageIdRef.current = null;
        if (mcpMsgId) {
          setMessages((prev) => prev.filter((m) => m.id !== mcpMsgId));
        }
        break;
      }

      case "PlanDisplay": {
        const planPayload = (event as PlanDisplayEvent).payload;
        const planBody = planPayload.content?.trim() ?? "";
        const planPath = planPayload.file_path?.trim() ?? "";
        if (!planBody && !planPath) {
          break;
        }
        const planMessageId = getNextMessageId("assistant");
        const content = planPath
          ? planBody
            ? `Plan saved to: ${planPath}\n\n${planBody}`
            : `Plan saved to: ${planPath}`
          : planBody;
        upsertMessage({
          id: planMessageId,
          role: "assistant",
          variant: "text",
          turnIndex: turnCounterRef.current > 0 ? turnCounterRef.current - 1 : undefined,
          content,
          isStreaming: false,
        });
        break;
      }

      case "SlashCommandsUpdate": {
        const commands = (event as SlashCommandsUpdateEvent).payload.slash_commands ?? [];
        const incoming = normalizeIncomingSlashCommands(commands);
        setSlashCommands((prev) => {
          const nextCommands = mergeSlashCommandsByName(prev, incoming);
          slashCommandsLenRef.current = nextCommands.length;
          return nextCommands;
        });
        usingCachedCommandsRef.current = false;
        break;
      }

      case "ConfigOptionUpdate": {
        applySessionConfigFromWire((event as ConfigOptionUpdateEvent).payload);
        break;
      }

      case "BackgroundTaskObserved": {
        const payload = (event as BackgroundTaskObservedEvent).payload;
        if (payload.session_id === sessionId) {
          const syncResult = syncBackgroundTaskFromWire(payload, isReplay);
          maybeNotifyBackgroundTaskComplete(syncResult, isReplay);
        }
        break;
      }

      default:
        break;
    }
  };

  const createTauriWireConnection = (sid: string): TauriWireConnection => {
    const connectionId = `${Date.now()}-${++nextTauriConnectionId}`;
    let state = STREAM_CONNECTING;
    let unlisten: (() => void) | undefined;
    let disconnecting = false;
    const pendingSends: Promise<void>[] = [];

    const drainPendingSends = async () => {
      if (pendingSends.length === 0) {
        return;
      }
      await Promise.allSettled([...pendingSends]);
    };

    return {
      connectionId,
      get readyState() {
        return state;
      },
      send(data: string) {
        if (state !== STREAM_OPEN) {
          throw new Error("Tauri wire connection is closed");
        }
        let isConfigOptionSend = false;
        try {
          const parsed = JSON.parse(data) as { method?: string };
          isConfigOptionSend = parsed.method === "set_config_option";
        } catch {
          isConfigOptionSend = false;
        }
        const pendingSend = wireSend(sid, data)
          .catch((err) => {
            console.error("[SessionStream] Failed to send Tauri wire message:", err);
            const error = err instanceof Error ? err : new Error(String(err));
            if (!isConfigOptionSend) {
              setError(error);
              onError?.(error);
            }
            throw error;
          })
          .finally(() => {
            const idx = pendingSends.indexOf(pendingSend);
            if (idx >= 0) {
              pendingSends.splice(idx, 1);
            }
          });
        pendingSends.push(pendingSend);
        void pendingSend.catch(() => undefined);
        return pendingSend;
      },
      close() {
        if (state === STREAM_CLOSED) {
          return;
        }
        state = STREAM_CLOSED;
        if (unlisten) {
          unlisten();
          unlisten = undefined;
        }
        if (!disconnecting) {
          disconnecting = true;
          void drainPendingSends().finally(() => {
            void wireDisconnect(sid, connectionId).catch((err) => {
              console.warn("[SessionStream] Failed to disconnect Tauri wire:", err);
            });
          });
        }
      },
      replaceUnlisten(nextUnlisten: () => void) {
        if (unlisten) {
          unlisten();
        }
        if (state === STREAM_CLOSED) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      },
      markOpen() {
        if (state !== STREAM_CLOSED) {
          state = STREAM_OPEN;
        }
      },
      markClosed() {
        state = STREAM_CLOSED;
        if (unlisten) {
          unlisten();
          unlisten = undefined;
        }
      },
    };
  };

  // Helper to send initialize message
  const sendInitialize = async (ws: StreamConnection) => {
    const id = uuidV4();
    initializeIdRef.current = id;
    const clientVersion = await resolveKimiCliVersion();
    const message = {
      jsonrpc: "2.0",
      method: "initialize",
      id,
      params: {
        protocol_version: WIRE_PROTOCOL_VERSION,
        client: {
          name: "kiwi",
          version: clientVersion,
        },
        capabilities: {
          supports_question: true,
          supports_plan_mode: true,
          supports_swarm_mode: true,
          supports_goal_mode: true,
        },
      },
    };

    try {
      await Promise.resolve(ws.send(JSON.stringify(message)));
      console.log("[SessionStream] Sent initialize message");
    } catch (err) {
      if (initializeIdRef.current === id) {
        initializeIdRef.current = null;
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  };

  const flushPendingModeUpdates = async (connection: StreamConnection) => {
    const runFlush = async () => {
      // Drain until empty so updates queued while we were sending are not dropped.
      for (;;) {
        const pending = pendingModeUpdatesRef.current;
        const updates: Array<
          | ["set_permission_mode", { mode: PermissionMode }]
          | ["set_plan_mode" | "set_swarm_mode" | "set_goal_mode", { enabled: boolean }]
        > = [];
        if (pending.permissionMode) {
          updates.push(["set_permission_mode", { mode: pending.permissionMode }]);
        }
        if (typeof pending.planMode === "boolean") {
          updates.push(["set_plan_mode", { enabled: pending.planMode }]);
        }
        if (typeof pending.swarmMode === "boolean") {
          updates.push(["set_swarm_mode", { enabled: pending.swarmMode }]);
        }
        if (typeof pending.goalMode === "boolean") {
          updates.push(["set_goal_mode", { enabled: pending.goalMode }]);
        }
        if (updates.length === 0) {
          return;
        }

        const sentPermission = pending.permissionMode;
        const sentPlan = pending.planMode;
        const sentSwarm = pending.swarmMode;
        const sentGoal = pending.goalMode;

        // Permission before plan: plan recovery uses the worker's permission
        // snapshot; sending plan first with stale Manual writes `default`.
        // Pending values are only deleted below, so a failed write remains
        // queued for a later retry.
        for (const [method, params] of updates) {
          await Promise.resolve(
            connection.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method,
                id: uuidV4(),
                params,
              }),
            ),
          );
        }

        // Keep each value pending until its backend write has completed.
        // A newer click made while awaiting the write wins and is drained by
        // the next loop iteration.
        const current = pendingModeUpdatesRef.current;
        if (sentPermission && current.permissionMode === sentPermission) {
          delete current.permissionMode;
        }
        if (typeof sentPlan === "boolean" && current.planMode === sentPlan) {
          delete current.planMode;
        }
        if (typeof sentSwarm === "boolean" && current.swarmMode === sentSwarm) {
          delete current.swarmMode;
        }
        if (typeof sentGoal === "boolean" && current.goalMode === sentGoal) {
          delete current.goalMode;
        }
      }
    };

    const next = modeFlushChainRef.current.then(runFlush, runFlush);
    modeFlushChainRef.current = next.then(
      () => undefined,
      () => undefined,
    );
    await next;
  };

  // Helper to send pending message
  const sendPendingMessage = async (ws: StreamConnection) => {
    const pendingMessage = pendingMessageRef.current;
    if (!pendingMessage) {
      return;
    }

    await flushPendingModeUpdates(ws);

    const messageId = uuidV4();
    promptRequestIdsRef.current.add(messageId);
    const message: WireMessage = {
      jsonrpc: "2.0",
      method: "prompt",
      id: messageId,
      params: {
        user_input:
          joinPromptText(pendingMessage.text, pendingMessage.attachments) ||
          "KIMI_FILE_UPLOAD_WITHOUT_MESSAGE",
        plan_mode: planModeRef.current,
        swarm_mode: swarmModeRef.current,
        goal_mode: goalModeRef.current,
        ...(pendingMessage.goalAction ? { goal_action: pendingMessage.goalAction } : {}),
        ...(pendingMessage.upcomingGoalId
          ? { upcoming_goal_id: pendingMessage.upcomingGoalId }
          : {}),
      },
    };

    try {
      setAwaitingFirstResponse(true);
      setStatus("submitted");
      if (promptTimingRef.current) {
        promptTimingRef.current.promptSubmittedAt = performance.now();
      }
      // `wireSend` resolves only after the Tauri prompt command finishes. Clear
      // the connection-level queue before awaiting it so the terminal `idle`
      // event cannot mistake an already-finished prompt for an unsent one.
      pendingMessageRef.current = null;
      await Promise.resolve(ws.send(JSON.stringify(message)));
      console.log("[SessionStream] Sent pending message after connect:", pendingMessage.text);
    } catch (err) {
      if (pendingMessageRef.current === null) {
        pendingMessageRef.current = pendingMessage;
      }
      promptRequestIdsRef.current.delete(messageId);
      optimisticUserMessagesRef.current.shift();
      if (pendingMessage.goalSwitchWasArmed && useToolEventsStore.getState().currentGoal === null) {
        rearmFailedGoalStart();
      }
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      onError?.(error);
      setAwaitingFirstResponse(false);
      setStatus("error");
      throw error;
    }
  };

  const resyncGoalHistory = (targetSessionId: string) => {
    const generation = ++goalHistoryResyncGenerationRef.current;
    const connection = wsRef.current;
    const sessionStatusSeqAtStart = latestSessionStatusRef.current?.seq ?? null;
    goalHistoryResyncActiveRef.current = true;
    isReplayingRef.current = true;
    setIsReplayingHistory(true);
    setStatus("submitted");

    void (async () => {
      let replayBuffer: { messages: LiveMessage[] } | null = null;
      const isCurrent = () =>
        generation === goalHistoryResyncGenerationRef.current &&
        activeSessionIdRef.current === targetSessionId &&
        wsRef.current === connection;

      try {
        const history = await replaySessionHistory(targetSessionId);
        if (!isCurrent()) return;

        replayBuffer = { messages: [] };
        goalHistoryReplayBufferRef.current = replayBuffer;
        resetStateRef.current(true, true);
        await replayHistoryMessagesInBatches(
          history,
          (message) => handleMessageRef.current(message),
          () => !isCurrent(),
        );
        if (!isCurrent()) return;

        flushInlineThinkBufferRef.current(true);
        flushBufferedStreamUpdateRef.current();
        if (!isCurrent()) return;

        try {
          await syncGoalSnapshot(targetSessionId);
        } catch (error) {
          console.warn("[SessionStream] Failed to sync Goal after continuation replay:", error);
        }
        if (!isCurrent()) return;

        if (goalHistoryReplayBufferRef.current === replayBuffer) {
          goalHistoryReplayBufferRef.current = null;
        }
        setMessagesInternal(replayBuffer.messages);
        // StatusUpdate records replayed from the journal (or received from
        // the worker while replay was in flight) are canonical. Do not put
        // the stale mode snapshot from resync start back over them. The only
        // local value that may intentionally outrank replay is a still
        // pending one-shot Goal arm.
        if (pendingModeUpdatesRef.current.goalMode === true) {
          setGoalMode(true);
          goalModeRef.current = true;
        }
        goalHistoryResyncActiveRef.current = false;
        isReplayingRef.current = false;
        setIsReplayingHistory(false);
        const latestSessionStatus = latestSessionStatusRef.current;
        const hasNewerSessionStatus =
          latestSessionStatus !== null && latestSessionStatus.seq !== sessionStatusSeqAtStart;
        if (errorRef.current || (hasNewerSessionStatus && latestSessionStatus.state === "error")) {
          setStatus("error");
        } else if (hasNewerSessionStatus && latestSessionStatus.state === "busy") {
          setStatus("streaming");
        } else if (hasNewerSessionStatus && latestSessionStatus.state === "restarting") {
          setStatus("submitted");
        } else {
          // A finished prompt with no newer busy/restarting/error snapshot,
          // including canonical idle/stopped, is ready for another turn.
          setStatus("ready");
        }
      } catch (error) {
        if (!isCurrent()) return;
        if (replayBuffer && goalHistoryReplayBufferRef.current === replayBuffer) {
          goalHistoryReplayBufferRef.current = null;
        }
        goalHistoryResyncActiveRef.current = false;
        isReplayingRef.current = false;
        setIsReplayingHistory(false);
        const historyError = error instanceof Error ? error : new Error(String(error));
        setError(historyError);
        onError?.(historyError);
        setStatus("error");
        void syncGoalSnapshot(targetSessionId).catch((syncError) => {
          console.warn("[SessionStream] Failed to sync Goal after replay error:", syncError);
        });
      } finally {
        if (replayBuffer && goalHistoryReplayBufferRef.current === replayBuffer && !isCurrent()) {
          goalHistoryReplayBufferRef.current = null;
        }
      }
    })();
  };
  // Handle incoming stream message
  const handleMessage = (data: string) => {
    try {
      const message: WireMessage = JSON.parse(data);

      // Check for JSON-RPC error response
      if (message.error) {
        // Initialize failure during busy session is non-fatal - retry after delay
        if (message.id === initializeIdRef.current) {
          initializeRetryCountRef.current += 1;

          if (initializeRetryCountRef.current > MAX_INITIALIZE_RETRIES) {
            initializeIdRef.current = null;
            initializeRetryCountRef.current = 0;
            return;
          }

          initializeIdRef.current = null;

          // Auto-retry initialize after 2 seconds
          setTimeout(() => {
            if (wsRef.current?.readyState === STREAM_OPEN) {
              void sendInitialize(wsRef.current)
                // biome-ignore lint/style/noNonNullAssertion: narrowing into the closure is lost for ref properties (moved verbatim from useSessionStream.ts).
                .then(() => flushPendingModeUpdates(wsRef.current!))
                .catch((err) => {
                  console.warn("[SessionStream] Failed to retry initialize:", err);
                });
            }
          }, 2000);

          return;
        }

        if (message.id && String(message.id) === replayIdRef.current) {
          console.warn("[SessionStream] Replay failed, continuing:", message.error);
          if (historyCompleteTimeoutRef.current) {
            window.clearTimeout(historyCompleteTimeoutRef.current);
            historyCompleteTimeoutRef.current = null;
          }
          replayIdRef.current = null;
          isReplayingRef.current = false;
          setIsReplayingHistory(false);
          awaitingIdleRef.current = false;
          if (pendingMessageRef.current && wsRef.current?.readyState === STREAM_OPEN) {
            void sendPendingMessage(wsRef.current).catch((sendErr) => {
              console.warn(
                "[SessionStream] Failed to send pending message after replay error:",
                sendErr,
              );
            });
          } else {
            setStatus("ready");
          }
          return;
        }

        const errorResponseId = message.id ? String(message.id) : null;
        if (errorResponseId && cancelRequestIdsRef.current.has(errorResponseId)) {
          cancelRequestIdsRef.current.delete(errorResponseId);
          console.warn("[SessionStream] Cancel request failed, treating as idle:", message.error);
          clearStepRetryStatus();
          setAwaitingFirstResponse(false);
          awaitingIdleRef.current = false;
          setStatus(goalHistoryResyncActiveRef.current ? "submitted" : "ready");
          completeStreamingMessages();
          return;
        }

        if (errorResponseId && configOptionRequestIdsRef.current.has(errorResponseId)) {
          configOptionRequestIdsRef.current.get(errorResponseId)?.resolve(false);
          console.warn("[SessionStream] Config option update failed:", message.error);
          return;
        }

        // Other errors remain fatal
        console.error("[SessionStream] Received error:", message.error);
        const err = new Error(message.error.message || "Unknown error");
        setError(err);
        onError?.(err);
        setStatus("error");
        clearStepRetryStatus();
        setAwaitingFirstResponse(false);
        awaitingIdleRef.current = false;
        promptRequestIdsRef.current.clear();
        cancelRequestIdsRef.current.clear();
        // Mark all streaming/subagent messages as complete
        completeStreamingMessages();
        return;
      }

      if (message.method === "session_status") {
        // A Tauri explicit replay uses the same timeout ref. Do not clear it
        // for early status snapshots; only the replay response (or timeout)
        // should end replay-gated prompt sending.
        if (historyCompleteTimeoutRef.current && replayIdRef.current === null) {
          window.clearTimeout(historyCompleteTimeoutRef.current);
          historyCompleteTimeoutRef.current = null;
        }
        applySessionStatus(message.params as SessionStatusPayload);
        return;
      }

      const replayId = message.id ? String(message.id) : null;
      const replayResult = message.result as
        | { status?: string; events?: number; requests?: number }
        | undefined;
      if (replayId && configOptionRequestIdsRef.current.has(replayId)) {
        configOptionRequestIdsRef.current.get(replayId)?.resolve(true);
        return;
      }
      if (replayId && replayId === replayIdRef.current && replayResult) {
        console.log("[SessionStream] Replay complete", replayResult);
        if (historyCompleteTimeoutRef.current) {
          window.clearTimeout(historyCompleteTimeoutRef.current);
          historyCompleteTimeoutRef.current = null;
        }
        replayIdRef.current = null;
        isReplayingRef.current = false;
        setIsReplayingHistory(false);
        awaitingIdleRef.current = false;
        void syncGoalSnapshot().catch((error) => {
          console.warn("[SessionStream] Failed to restore Goal after replay:", error);
        });
        if (pendingMessageRef.current && wsRef.current?.readyState === STREAM_OPEN) {
          void sendPendingMessage(wsRef.current).catch((err) => {
            console.warn("[SessionStream] Failed to send pending message after replay:", err);
          });
        } else {
          setStatus("ready");
        }
        return;
      }

      const promptResultId = message.id ? String(message.id) : null;
      if (promptResultId && promptRequestIdsRef.current.has(promptResultId)) {
        promptRequestIdsRef.current.delete(promptResultId);
        optimisticUserMessagesRef.current.shift();
        const result = message.result as
          | {
              status?: string;
              goal_history_resync?: boolean;
              goal_completed?: boolean;
            }
          | undefined;
        if (result?.goal_completed === true) setGoalCompletionEpoch((epoch) => epoch + 1);
        const shouldGoalResync =
          result?.goal_history_resync === true && Boolean(sessionId) && isTauri();
        const finishedWithoutVisibleResponse =
          result?.status === "finished" && awaitingFirstResponseRef.current && !shouldGoalResync;
        if (result?.status === "finished" || result?.status === "cancelled") {
          console.log(`[SessionStream] Stream ${result.status}`);
        }
        clearStepRetryStatus();
        setAwaitingFirstResponse(false);
        awaitingIdleRef.current = false;
        if (!shouldGoalResync) {
          isReplayingRef.current = false;
          setIsReplayingHistory(false);
        }
        completeStreamingMessages();
        if (pendingCompactRef.current) {
          pendingCompactRef.current = false;
          compactionMessageIdRef.current = null;
          setMessages([
            {
              id: getNextMessageId("assistant"),
              role: "assistant",
              variant: "status",
              content:
                result?.status === "cancelled" ? "Compaction cancelled." : "Context compacted.",
              isStreaming: false,
            },
          ]);
          setStatus("ready");
          setError(null);
          return;
        }
        if (shouldGoalResync && sessionId) {
          if (result?.status === "finished") {
            triggerFirstTurnComplete();
          }
          resyncGoalHistory(sessionId);
          return;
        }
        if (finishedWithoutVisibleResponse) {
          const emptyResponseError = new Error("模型未返回可显示内容");
          setError(emptyResponseError);
          onError?.(emptyResponseError);
          setStatus("error");
        } else {
          setStatus("ready");
        }
        if (result?.status === "finished" && !finishedWithoutVisibleResponse) {
          triggerFirstTurnComplete();
        }
        return;
      }

      const cancelResultId = message.id ? String(message.id) : null;
      if (cancelResultId && cancelRequestIdsRef.current.has(cancelResultId)) {
        cancelRequestIdsRef.current.delete(cancelResultId);
        const result = message.result as { status?: string } | undefined;
        if (result?.status === "finished" || result?.status === "cancelled") {
          console.log(`[SessionStream] Cancel ${result.status}`);
        }
        setStatus(goalHistoryResyncActiveRef.current ? "submitted" : "ready");
        clearStepRetryStatus();
        setAwaitingFirstResponse(false);
        awaitingIdleRef.current = false;
        if (!goalHistoryResyncActiveRef.current) {
          isReplayingRef.current = false;
          setIsReplayingHistory(false);
        }
        completeStreamingMessages();
        return;
      }

      // Check for finished or cancelled status from legacy transports
      if (message.result?.status === "finished" || message.result?.status === "cancelled") {
        console.log(`[SessionStream] Stream ${message.result.status}`);
        setStatus("ready");
        clearStepRetryStatus();
        setAwaitingFirstResponse(false);
        awaitingIdleRef.current = false;
        isReplayingRef.current = false;
        setIsReplayingHistory(false);
        completeStreamingMessages();
        return;
      }

      // Check for replay_complete marker (custom event from server)
      if (
        message.method === "event" &&
        (message.params as { type?: string })?.type === "ReplayComplete"
      ) {
        console.log("[SessionStream] Replay complete");
        isReplayingRef.current = false;
        setIsReplayingHistory(false);
        setStatus("ready");
        awaitingIdleRef.current = false;
        return;
      }

      // Check for history_complete - history loaded but environment not ready yet
      // This allows showing history while SSH connection is being established
      if (message.method === "history_complete") {
        console.log("[SessionStream] History loaded, waiting for environment...");
        isReplayingRef.current = false;
        // Keep status as "submitted" - input stays disabled until session_status
        setStatus((current) => (current === "ready" ? current : "submitted"));

        // Timeout fallback: reconnect if session_status not received within 15s
        const currentWs = wsRef.current;
        if (historyCompleteTimeoutRef.current) {
          window.clearTimeout(historyCompleteTimeoutRef.current);
        }
        historyCompleteTimeoutRef.current = window.setTimeout(() => {
          if (wsRef.current === currentWs) {
            if (isTauri()) {
              console.warn(
                "[SessionStream] session_status timeout after history_complete, syncing Tauri status...",
              );
              void syncTauriStatusSnapshot(currentWs, "history_complete timeout");
              return;
            }
            console.warn(
              "[SessionStream] session_status timeout after history_complete, reconnecting...",
            );
            reconnectRef.current();
          }
        }, 15000);
        return;
      }

      // Handle initialize response
      if (message.id && message.id === initializeIdRef.current && message.result) {
        initializeIdRef.current = null;
        initializeRetryCountRef.current = 0;

        const { slash_commands } = message.result;

        if (slash_commands && slash_commands.length > 0) {
          const incoming = normalizeIncomingSlashCommands(slash_commands);
          setSlashCommands((prev) => {
            const nextCommands = mergeSlashCommandsByName(prev, incoming);
            slashCommandsLenRef.current = nextCommands.length;
            return nextCommands;
          });
          usingCachedCommandsRef.current = false;
        }
        return;
      }

      // Handle approval/question requests sent as JSON-RPC requests
      if (message.method === "request") {
        const params = message.params as {
          type?: string;
          payload?: unknown;
        };

        if (params?.type === "ApprovalRequest") {
          const approvalEvent: ApprovalRequestEvent = {
            type: "ApprovalRequest",
            payload: params.payload as ApprovalRequestEvent["payload"],
          };
          processEvent(
            approvalEvent,
            isReplayingRef.current,
            message.id ?? (approvalEvent.payload.id as string | number),
          );
          return;
        }

        if (params?.type === "QuestionRequest") {
          const questionEvent: QuestionRequestEvent = {
            type: "QuestionRequest",
            payload: params.payload as QuestionRequestEvent["payload"],
          };
          processEvent(
            questionEvent,
            isReplayingRef.current,
            message.id ?? (questionEvent.payload.id as string | number),
          );
          return;
        }
      }

      // Process event
      const event = extractEvent(message);
      if (event) {
        processEvent(event, isReplayingRef.current);
      }
    } catch (err) {
      console.warn("[SessionStream] Failed to parse stream message:", data, err);
    }
  };
  handleMessageRef.current = handleMessage;

  const startWatchdog = (connection: StreamConnection) => {
    if (watchdogIntervalRef.current !== null) {
      window.clearInterval(watchdogIntervalRef.current);
      watchdogIntervalRef.current = null;
    }
    const watchdogIntervalId = window.setInterval(() => {
      if (!wsRef.current || wsRef.current !== connection) {
        window.clearInterval(watchdogIntervalId);
        if (watchdogIntervalRef.current === watchdogIntervalId) {
          watchdogIntervalRef.current = null;
        }
        return;
      }
      if (wsRef.current.readyState !== STREAM_OPEN) return;
      const elapsed = Date.now() - lastWsMessageTimeRef.current;
      const hasUnsubmittedApproval = Array.from(pendingApprovalRequestsRef.current.values()).some(
        (e) => !e.submitted,
      );
      const hasUnsubmittedQuestion = Array.from(pendingQuestionRequestsRef.current.values()).some(
        (e) => !e.submitted,
      );
      const hasPendingInteraction = hasUnsubmittedApproval || hasUnsubmittedQuestion;
      if (elapsed > 45_000 && statusRef.current === "streaming" && !hasPendingInteraction) {
        if (isTauri()) {
          lastWsMessageTimeRef.current = Date.now();
          console.warn(
            `[SessionStream] Watchdog: no messages for ${Math.round(elapsed / 1000)}s while streaming, syncing Tauri status...`,
          );
          void syncTauriStatusSnapshot(connection, "watchdog");
          return;
        }
        console.warn(
          `[SessionStream] Watchdog: no messages for ${Math.round(elapsed / 1000)}s while streaming, reconnecting...`,
        );
        reconnectRef.current();
      }
    }, 10_000);
    watchdogIntervalRef.current = watchdogIntervalId;
  };

  const finishConnection = (connection: StreamConnection, code?: number, reason?: string) => {
    if (wsRef.current !== connection) {
      return;
    }

    goalHistoryResyncGenerationRef.current += 1;
    goalHistoryResyncActiveRef.current = false;
    goalHistoryReplayBufferRef.current = null;
    console.log("[SessionStream] Disconnected:", code ?? 1000, reason ?? "");
    setIsConnected(false);
    setConnectionPhase("disconnected");
    setConnectionId(null);
    wsRef.current = null;
    pendingMessageRef.current = null;
    pendingApprovalRequestsRef.current.clear();
    pendingQuestionRequestsRef.current.clear();
    promptRequestIdsRef.current.clear();
    cancelRequestIdsRef.current.clear();
    initializeIdRef.current = null;
    replayIdRef.current = null;
    initializeRetryCountRef.current = 0;
    if (historyCompleteTimeoutRef.current !== null) {
      window.clearTimeout(historyCompleteTimeoutRef.current);
      historyCompleteTimeoutRef.current = null;
    }
    awaitingIdleRef.current = false;
    setAwaitingFirstResponse(false);
    setSessionStatus(null);
    latestSessionStatusRef.current = null;
    lastStatusSeqRef.current = null;
    setIsReplayingHistory(false);
    isReplayingRef.current = false;
    if (watchdogIntervalRef.current !== null) {
      window.clearInterval(watchdogIntervalRef.current);
      watchdogIntervalRef.current = null;
    }

    if (code === 4004) {
      const err = new Error("Session not found");
      setError(err);
      onError?.(err);
    } else if (code === 4029) {
      const err = new Error("Too many concurrent sessions");
      setError(err);
      onError?.(err);
    }

    clearStepRetryStatus();
    completeStreamingMessages();
    setStatus(errorRef.current ? "error" : "ready");
  };

  // Build WebSocket URL. WebSocket handshakes cannot attach Authorization headers
  // in all environments, so the token is passed as a query param when present.
  const getWebSocketUrl = (sid: string): string => {
    const token = getAuthToken();
    if (baseUrl) {
      // Convert HTTP URL to WebSocket URL
      const url = baseUrl.replace(HTTP_TO_WS_REGEX, "ws");
      const wsUrl = `${url}/api/sessions/${sid}/stream`;
      return token ? `${wsUrl}?token=${encodeURIComponent(token)}` : wsUrl;
    }

    // Use current host
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/api/sessions/${sid}/stream`;
    return token ? `${wsUrl}?token=${encodeURIComponent(token)}` : wsUrl;
  };

  const respondToApproval = async (
    requestId: string,
    response: ApprovalResponseDecision,
    reason?: string,
  ) => {
    syncRefsFromState();
    const ws = wsRef.current;
    if (!ws || ws.readyState !== STREAM_OPEN) {
      throw new Error("Not connected to session stream");
    }

    const pending = pendingApprovalRequestsRef.current.get(requestId);
    if (!pending) {
      throw new Error("Approval request not found");
    }

    if (pending.submitted) {
      return;
    }

    const trimmedReason =
      typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : undefined;

    const isApproved = response !== "reject";
    const rejectionReason = response === "reject" ? trimmedReason : undefined;
    const responseMessage: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: pending.rpcId ?? requestId,
      result: {
        request_id: pending.requestId ?? requestId,
        response,
        ...(response === "reject" && trimmedReason ? { feedback: trimmedReason } : {}),
      },
    };

    try {
      await Promise.resolve(ws.send(JSON.stringify(responseMessage)));
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }

    pending.submitted = true;
    pendingApprovalRequestsRef.current.set(requestId, pending);

    const tc = currentToolCallsRef.current.get(pending.toolCallId);
    const nextState = isApproved ? "input-available" : "output-denied";
    const nextStreaming = isApproved;

    if (tc) {
      const existingApproval = tc.approval ?? {
        id: requestId,
        action: "",
        description: "",
        sender: "",
        toolCallId: pending.toolCallId,
      };

      const updatedApproval = {
        ...existingApproval,
        approved: isApproved,
        reason: isApproved ? existingApproval.reason : (rejectionReason ?? existingApproval.reason),
        submitted: true,
        resolved: isApproved ? existingApproval.resolved : true,
        response,
      };

      tc.approval = updatedApproval;

      if (tc.messageId) {
        updateMessageById(tc.messageId, (message) => {
          if (!message.toolCall) {
            return message;
          }

          return {
            ...message,
            isStreaming: nextStreaming,
            toolCall: {
              ...message.toolCall,
              state: nextState,
              approval: updatedApproval,
              errorText: isApproved
                ? message.toolCall.errorText
                : (rejectionReason ?? message.toolCall.errorText),
            },
          };
        });
      }
    }
  };

  const respondToQuestion = async (requestId: string, answers: Record<string, string>) => {
    syncRefsFromState();
    const ws = wsRef.current;
    if (!ws || ws.readyState !== STREAM_OPEN) {
      throw new Error("Not connected to session stream");
    }

    const pending = pendingQuestionRequestsRef.current.get(requestId);
    if (!pending) {
      throw new Error("Question request not found");
    }

    if (pending.submitted) {
      return;
    }

    const responseMessage: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: pending.rpcId ?? requestId,
      result: {
        request_id: pending.requestId ?? requestId,
        answers,
      },
    };

    try {
      await Promise.resolve(ws.send(JSON.stringify(responseMessage)));
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }

    pending.submitted = true;
    pendingQuestionRequestsRef.current.set(requestId, pending);

    const tc =
      currentToolCallsRef.current.get(pending.toolCallId) ??
      currentToolCallsRef.current.get(resolveAskUserParentToolCallId(pending.toolCallId));

    if (tc?.messageId) {
      updateMessageById(tc.messageId, (message) => {
        if (!message.toolCall) {
          return message;
        }

        return {
          ...message,
          isStreaming: true,
          toolCall: {
            ...message.toolCall,
            state: "question-responded",
            question: message.toolCall.question
              ? {
                  ...message.toolCall.question,
                  submitted: true,
                  answers,
                }
              : undefined,
          },
        };
      });
    }
  };

  // Connect to session stream
  const connect = () => {
    syncRefsFromState();
    if (!sessionId) return;
    setConnectionPhase("connecting");
    // Capture the narrowed session id for async closures (the option may be
    // refreshed by the adapter while a connect attempt is in flight).
    const targetSessionId = sessionId;

    const skipReplay = skipReplayOnConnectRef.current;
    skipReplayOnConnectRef.current = false;

    initializeRetryCountRef.current = 0; // Reset retry count for new connection

    const existing = wsRef.current;
    if (existing) {
      console.log("[SessionStream] Closing existing stream");
      existing.close();
      wsRef.current = null;
    }
    if (watchdogIntervalRef.current !== null) {
      window.clearInterval(watchdogIntervalRef.current);
      watchdogIntervalRef.current = null;
    }

    awaitingIdleRef.current = false;
    const preserveMessages = preserveMessagesOnConnectRef.current;
    preserveMessagesOnConnectRef.current = false;
    if (preserveMessages) {
      resetStepState();
      promptRequestIdsRef.current.clear();
      cancelRequestIdsRef.current.clear();
      initializeIdRef.current = null;
      replayIdRef.current = null;
      initializeRetryCountRef.current = 0;
      setError(null);
      setSessionStatus(null);
      latestSessionStatusRef.current = null;
      lastStatusSeqRef.current = null;
      isReplayingRef.current = false;
      setIsReplayingHistory(false);
    } else {
      resetState(true); // preserve slashCommands on reconnect
      setMessages([]);

      // A lazy connection can be triggered while the new-session Goal
      // confirmation is open (for example, when the user declines it). Keep
      // the locally selected modes visible until their queued backend writes
      // finish instead of flashing back to the persisted defaults.
      const pendingModes = pendingModeUpdatesRef.current;
      if (typeof pendingModes.planMode === "boolean") {
        setPlanMode(pendingModes.planMode);
        planModeRef.current = pendingModes.planMode;
      }
      if (pendingModes.permissionMode) {
        setPermissionMode(pendingModes.permissionMode);
        permissionModeRef.current = pendingModes.permissionMode;
      }
      if (typeof pendingModes.swarmMode === "boolean") {
        setSwarmMode(pendingModes.swarmMode);
        swarmModeRef.current = pendingModes.swarmMode;
      }
      if (typeof pendingModes.goalMode === "boolean") {
        setGoalMode(pendingModes.goalMode);
        goalModeRef.current = pendingModes.goalMode;
      }
    }
    setStatus(skipReplay ? "ready" : "submitted");
    setAwaitingFirstResponse(Boolean(pendingMessageRef.current));

    if (isTauri()) {
      const connection = createTauriWireConnection(sessionId);
      wsRef.current = connection;
      setConnectionId(connection.connectionId);

      const handleTauriConnectError = (err: unknown) => {
        if (wsRef.current !== connection) {
          return;
        }
        console.error("[SessionStream] Failed to connect Tauri wire:", err);
        const failedPendingMessage = pendingMessageRef.current;
        const connectionError = err instanceof Error ? err : new Error(String(err));

        // The first wire_connect can fire while kimi acp is still starting up
        // (e.g. waiting on a permission/login confirmation), which fails the
        // lease. Retry once before surfacing the error so a single-try failure
        // does not break the first turn; keep the pending message for the retry.
        if (connectRetryCountRef.current < MAX_TAURI_CONNECT_RETRIES) {
          connectRetryCountRef.current += 1;
          pendingMessageRef.current = failedPendingMessage;
          awaitingIdleRef.current = false;
          connection.markClosed();
          wsRef.current = null;
          window.setTimeout(() => {
            if (wsRef.current === null) {
              connect();
            }
          }, TAURI_CONNECT_RETRY_DELAY_MS);
          return;
        }
        connectRetryCountRef.current = 0;

        setError(connectionError);
        onError?.(connectionError);
        awaitingIdleRef.current = false;
        setAwaitingFirstResponse(false);
        setStatus("error");
        clearStepRetryStatus();
        pendingMessageRef.current = null;
        if (
          failedPendingMessage?.goalSwitchWasArmed &&
          useToolEventsStore.getState().currentGoal === null
        ) {
          rearmFailedGoalStart();
        }
        promptRequestIdsRef.current.clear();
        cancelRequestIdsRef.current.clear();
        initializeIdRef.current = null;
        replayIdRef.current = null;
        initializeRetryCountRef.current = 0;
        if (historyCompleteTimeoutRef.current !== null) {
          window.clearTimeout(historyCompleteTimeoutRef.current);
          historyCompleteTimeoutRef.current = null;
        }
        setIsReplayingHistory(false);
        isReplayingRef.current = false;
        connection.markClosed();
        setConnectionPhase("disconnected");
        setConnectionId(null);
        wsRef.current = null;
      };

      try {
        if (registerPerSessionListener) {
          const unlisten = onWireMessage(sessionId, (message) => {
            if (wsRef.current !== connection) {
              return;
            }
            handleWireMessage(message);
          });
          connection.replaceUnlisten(unlisten);
        } else {
          // G5 orchestrator owns the single global wire:message listener; the
          // connection still needs a close-time hook for lease cleanup.
          connection.replaceUnlisten(() => undefined);
        }

        void wireConnect(sessionId, connection.connectionId)
          .then(async () => {
            if (wsRef.current !== connection) {
              connection.markClosed();
              void wireDisconnect(targetSessionId, connection.connectionId).catch(() => undefined);
              return;
            }

            connection.markOpen();
            const promptTiming = promptTimingRef.current;
            if (promptTiming && promptTiming.workerReadyAt === undefined) {
              promptTiming.workerReadyAt = performance.now();
            }
            console.log("[SessionStream] Connected to Tauri wire session:", sessionId);
            setIsConnected(true);
            setConnectionPhase("connected");
            connectRetryCountRef.current = 0;
            setError(null);
            awaitingIdleRef.current = false;
            lastWsMessageTimeRef.current = Date.now();
            startWatchdog(connection);

            await sendInitialize(connection);
            await flushPendingModeUpdates(connection);

            if (pendingMessageRef.current) {
              replayIdRef.current = null;
              isReplayingRef.current = false;
              setIsReplayingHistory(false);
              await sendPendingMessage(connection);
              return;
            }

            if (skipReplay) {
              setStatus("ready");
              return;
            }

            const replayId = uuidV4();
            replayIdRef.current = replayId;
            isReplayingRef.current = true;
            setIsReplayingHistory(true);
            await Promise.resolve(
              connection.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "replay",
                  id: replayId,
                }),
              ),
            );
            const currentConnection = connection;
            if (historyCompleteTimeoutRef.current) {
              window.clearTimeout(historyCompleteTimeoutRef.current);
            }
            historyCompleteTimeoutRef.current = window.setTimeout(() => {
              if (wsRef.current === currentConnection && replayIdRef.current === replayId) {
                console.warn("[SessionStream] replay timeout, continuing without blocking prompt");
                replayIdRef.current = null;
                isReplayingRef.current = false;
                setIsReplayingHistory(false);
                if (pendingMessageRef.current && currentConnection.readyState === STREAM_OPEN) {
                  void sendPendingMessage(currentConnection).catch((err) => {
                    console.warn(
                      "[SessionStream] Failed to send pending message after replay timeout:",
                      err,
                    );
                  });
                } else {
                  setStatus("ready");
                }
              }
            }, 15_000);
          })
          .catch(handleTauriConnectError);
      } catch (err) {
        handleTauriConnectError(err);
      }
      return;
    }

    const wsUrl = getWebSocketUrl(sessionId);

    try {
      const ws = new WebSocket(wsUrl);
      // Mark this socket as the "current attempt" immediately.
      // If the user switches sessions before `onopen`, `disconnect()` will clear `wsRef.current`,
      // and any late callbacks from this `ws` will be ignored by the identity guard.
      wsRef.current = ws;

      ws.onopen = () => {
        if (wsRef.current !== ws) {
          ws.close();
          return;
        }

        console.log("[SessionStream] Connected to session:", sessionId);
        setIsConnected(true);
        setConnectionPhase("connected");
        setError(null);
        awaitingIdleRef.current = false;
        setStatus("streaming"); // Will receive replay, then switch to ready
        lastWsMessageTimeRef.current = Date.now();

        // Start stale-connection watchdog
        startWatchdog(ws);

        // Send initialize message to get slash commands
        void sendInitialize(ws)
          .then(() => flushPendingModeUpdates(ws))
          .then(() => sendPendingMessage(ws))
          .catch((err) => {
            console.warn("[SessionStream] Failed to send initialize:", err);
          });
      };

      ws.onmessage = (event) => {
        if (wsRef.current !== ws) {
          return;
        }

        handleWireMessage(event.data);
      };

      ws.onerror = (event) => {
        if (wsRef.current !== ws) {
          return;
        }

        console.error("[SessionStream] WebSocket error:", event);
        const err = new Error("WebSocket connection error");
        setError(err);
        onError?.(err);
        setAwaitingFirstResponse(false);
        setStatus("error");
        clearStepRetryStatus();
        awaitingIdleRef.current = false;
        pendingMessageRef.current = null; // Clear pending message on error
      };

      ws.onclose = (event) => {
        if (wsRef.current !== ws) {
          return;
        }

        finishConnection(ws, event.code, event.reason);
      };
    } catch (err) {
      console.error("[SessionStream] Failed to connect:", err);
      const connectionError = err instanceof Error ? err : new Error(String(err));
      setError(connectionError);
      onError?.(connectionError);
      awaitingIdleRef.current = false;
      setAwaitingFirstResponse(false);
      setStatus("error");
      clearStepRetryStatus();
      pendingMessageRef.current = null; // Clear pending message on error
      setConnectionPhase("disconnected");
      setConnectionId(null);
    }
  };

  // Send cancel message to server
  // Disconnect
  const disconnect = () => {
    syncRefsFromState();
    goalHistoryResyncGenerationRef.current += 1;
    goalHistoryResyncActiveRef.current = false;
    goalHistoryReplayBufferRef.current = null;
    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (watchdogIntervalRef.current !== null) {
      window.clearInterval(watchdogIntervalRef.current);
      watchdogIntervalRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    awaitingIdleRef.current = false;
    setAwaitingFirstResponse(false);
    pendingMessageRef.current = null;
    initializeIdRef.current = null;
    replayIdRef.current = null;
    initializeRetryCountRef.current = 0;
    if (historyCompleteTimeoutRef.current !== null) {
      window.clearTimeout(historyCompleteTimeoutRef.current);
      historyCompleteTimeoutRef.current = null;
    }
    clearStepRetryStatus();
    setIsConnected(false);
    setConnectionPhase("disconnected");
    setConnectionId(null);
    setStatus("ready");
    setSessionStatus(null);
    latestSessionStatusRef.current = null;
    lastStatusSeqRef.current = null;
    setIsReplayingHistory(false);
    isReplayingRef.current = false;
    pendingApprovalRequestsRef.current.clear();
    pendingQuestionRequestsRef.current.clear();
    promptRequestIdsRef.current.clear();
    cancelRequestIdsRef.current.clear();

    // Remove lingering MCP loading indicator (e.g. MCPLoadingEnd was never received)
    const mcpMsgId = mcpLoadingMessageIdRef.current;
    if (mcpMsgId) {
      mcpLoadingMessageIdRef.current = null;
      setMessages((prev) => prev.filter((m) => m.id !== mcpMsgId));
    }

    // Mark all streaming/subagent messages as complete
    completeStreamingMessages();
  };

  // Send cancel request or disconnect if stream not ready
  const cancel = () => {
    syncRefsFromState();
    const hasActivePrompt =
      pendingMessageRef.current !== null ||
      promptRequestIdsRef.current.size > 0 ||
      (status === "streaming" && !isReplayingRef.current);
    if (!hasActivePrompt) {
      console.log("[SessionStream] Ignoring cancel without an active prompt");
      return;
    }

    const ws = wsRef.current;
    if (!ws || ws.readyState !== STREAM_OPEN) {
      console.log("[SessionStream] Cancel requested before stream is ready, disconnecting instead");
      awaitingIdleRef.current = false;
      pendingMessageRef.current = null;
      // Clear pending approval/question requests and update message states
      pendingApprovalRequestsRef.current.clear();
      pendingQuestionRequestsRef.current.clear();
      promptRequestIdsRef.current.clear();
      cancelRequestIdsRef.current.clear();
      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.variant === "tool" && msg.toolCall?.state === "approval-requested") {
            return {
              ...msg,
              isStreaming: false,
              toolCall: {
                ...msg.toolCall,
                state: "output-denied",
                approval: msg.toolCall.approval
                  ? {
                      ...msg.toolCall.approval,
                      submitted: true,
                      resolved: true,
                      approved: false,
                      response: "reject",
                    }
                  : undefined,
              },
            };
          }
          if (msg.variant === "tool" && msg.toolCall?.state === "question-requested") {
            return {
              ...msg,
              isStreaming: false,
              toolCall: {
                ...msg.toolCall,
                state: "question-responded",
                question: msg.toolCall.question
                  ? {
                      ...msg.toolCall.question,
                      submitted: true,
                      resolved: true,
                    }
                  : undefined,
              },
            };
          }
          // Mark still-running tool calls as interrupted
          if (
            msg.variant === "tool" &&
            (msg.toolCall?.state === "input-streaming" || msg.toolCall?.state === "input-available")
          ) {
            return {
              ...msg,
              isStreaming: false,
              toolCall: {
                ...msg.toolCall,
                state: "output-denied",
              },
            };
          }
          return msg;
        }),
      );
      disconnect();
      return;
    }

    // Clear all pending approval/question requests and update message states
    pendingApprovalRequestsRef.current.clear();
    pendingQuestionRequestsRef.current.clear();
    promptRequestIdsRef.current.clear();
    cancelRequestIdsRef.current.clear();

    // Always update messages (consistent with StepInterrupted handler)
    setMessages((prev) =>
      prev.map((msg) => {
        if (msg.variant === "tool" && msg.toolCall?.state === "approval-requested") {
          return {
            ...msg,
            isStreaming: false,
            toolCall: {
              ...msg.toolCall,
              state: "output-denied",
              approval: msg.toolCall.approval
                ? {
                    ...msg.toolCall.approval,
                    submitted: true,
                    resolved: true,
                    approved: false,
                    response: "reject",
                  }
                : undefined,
            },
          };
        }
        if (msg.variant === "tool" && msg.toolCall?.state === "question-requested") {
          return {
            ...msg,
            isStreaming: false,
            toolCall: {
              ...msg.toolCall,
              state: "question-responded",
              question: msg.toolCall.question
                ? {
                    ...msg.toolCall.question,
                    submitted: true,
                    resolved: true,
                  }
                : undefined,
            },
          };
        }
        // Mark still-running tool calls as interrupted
        if (
          msg.variant === "tool" &&
          (msg.toolCall?.state === "input-streaming" || msg.toolCall?.state === "input-available")
        ) {
          return {
            ...msg,
            isStreaming: false,
            toolCall: {
              ...msg.toolCall,
              state: "output-denied",
            },
          };
        }
        return msg;
      }),
    );

    const cancelId = uuidV4();
    cancelRequestIdsRef.current.add(cancelId);
    const cancelMessage: JsonRpcRequest = {
      jsonrpc: "2.0",
      method: "cancel",
      id: cancelId,
    };

    try {
      console.log("[SessionStream] Sending cancel request");
      const sendResult = Promise.resolve(ws.send(JSON.stringify(cancelMessage)));
      const shouldAwaitIdle = status === "streaming" || status === "submitted";
      awaitingIdleRef.current = shouldAwaitIdle;
      if (status === "streaming") {
        setStatus("submitted");
      }
      setAwaitingFirstResponse(false);
      void sendResult.catch((err) => {
        cancelRequestIdsRef.current.delete(cancelId);
        awaitingIdleRef.current = false;
        const error = err instanceof Error ? err : new Error(String(err));
        console.error("[SessionStream] Failed to send cancel request:", error);
        setError(error);
        onError?.(error);
        setStatus("error");
      });
    } catch (err) {
      cancelRequestIdsRef.current.delete(cancelId);
      awaitingIdleRef.current = false;
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[SessionStream] Failed to send cancel request:", error);
      setError(error);
      onError?.(error);
      setStatus("error");
    }
  };

  // Reconnect
  const reconnect = () => {
    syncRefsFromState();
    disconnect();
    setConnectionPhase("reconnecting");
    // Small delay before reconnecting
    reconnectTimeoutRef.current = window.setTimeout(() => {
      connect();
    }, 100);
  };

  // Keep refs in sync so useLayoutEffect can use stable references
  connectRef.current = connect;
  disconnectRef.current = disconnect;
  reconnectRef.current = reconnect;
  resetStateRef.current = resetState;

  const sendModeUpdate = (
    key: "planMode" | "swarmMode" | "goalMode",
    enabled: boolean,
  ): boolean => {
    syncRefsFromState();
    if (!sessionId) {
      return false;
    }

    pendingModeUpdatesRef.current[key] = enabled;
    if (key === "planMode") {
      planModeRef.current = enabled;
      setPlanMode(enabled);
    } else if (key === "swarmMode") {
      swarmModeRef.current = enabled;
      setSwarmMode(enabled);
    } else {
      goalModeRef.current = enabled;
      setGoalMode(enabled);
    }

    const connection = wsRef.current;
    const canFlushImmediately =
      connection?.readyState === STREAM_OPEN &&
      statusRef.current === "ready" &&
      initializeIdRef.current === null &&
      replayIdRef.current === null;
    if (canFlushImmediately && connection) {
      void flushPendingModeUpdates(connection).catch((error) => {
        console.warn(`[SessionStream] Failed to set ${key}:`, error);
      });
      return true;
    }

    // An initialize or replay is already in progress. Keep only the latest
    // requested value and let the ready-state effect apply it; reconnecting
    // here would tear down the worker that is still starting.
    if (connection) {
      return true;
    }

    preserveMessagesOnConnectRef.current = hasMessagesRef.current;
    connect();
    return true;
  };

  const sendSetPermissionMode = (mode: PermissionMode): boolean => {
    syncRefsFromState();
    if (!sessionId) {
      return false;
    }

    pendingModeUpdatesRef.current.permissionMode = mode;
    permissionModeRef.current = mode;
    setPermissionMode(mode);

    const connection = wsRef.current;
    const canFlushImmediately =
      connection?.readyState === STREAM_OPEN &&
      statusRef.current === "ready" &&
      initializeIdRef.current === null &&
      replayIdRef.current === null;
    if (canFlushImmediately && connection) {
      void flushPendingModeUpdates(connection).catch((error) => {
        console.warn("[SessionStream] Failed to set permission mode:", error);
      });
      return true;
    }

    if (connection) {
      return true;
    }

    preserveMessagesOnConnectRef.current = hasMessagesRef.current;
    connect();
    return true;
  };
  const sendSetPlanMode = (enabled: boolean) => sendModeUpdate("planMode", enabled);

  const sendSetSwarmMode = (enabled: boolean) => sendModeUpdate("swarmMode", enabled);

  const sendSetGoalMode = (enabled: boolean) => sendModeUpdate("goalMode", enabled);

  const sendSetConfigOption = (configId: string, value: unknown): Promise<boolean> => {
    syncRefsFromState();
    if (!sessionId) {
      return Promise.resolve(false);
    }
    if (!isValidSessionConfigValue(sessionConfigStateRef.current, configId, value)) {
      return Promise.resolve(false);
    }

    const connection = wsRef.current;
    if (!connection) {
      preserveMessagesOnConnectRef.current = hasMessagesRef.current;
      connect();
      return Promise.resolve(false);
    }

    const requestId = uuidV4();
    return new Promise<boolean>((resolve) => {
      const finish = (ok: boolean) => {
        if (!configOptionRequestIdsRef.current.has(requestId)) {
          return;
        }
        configOptionRequestIdsRef.current.delete(requestId);
        setSessionConfigUpdating(false);
        resolve(ok);
      };
      const timeoutId = window.setTimeout(() => finish(false), 30_000);
      configOptionRequestIdsRef.current.set(requestId, {
        configId,
        resolve: (ok) => {
          window.clearTimeout(timeoutId);
          finish(ok);
        },
      });
      setSessionConfigUpdating(true);

      void Promise.resolve(
        connection.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "set_config_option",
            id: requestId,
            params: { configId, value },
          }),
        ),
      ).catch((error) => {
        console.warn("[SessionStream] Failed to set config option:", error);
        configOptionRequestIdsRef.current.get(requestId)?.resolve(false);
      });
    });
  };

  const runLocalInfoCommand = async (command: "usage" | "status") => {
    syncRefsFromState();
    const managedRaw = isTauri()
      ? await fetchManagedUsage()
      : {
          kind: "error" as const,
          message: "Usage is available on Kimi Code platform only.",
        };
    const managed = parseManagedUsageFetchResult(managedRaw);
    let modelLabel: string | null = null;
    let modelDisplayName: string | null = null;
    let thinkingEffort: string | null = null;
    let version: string | null = null;
    let workDir: string | null = null;
    let sessionTitle: string | null = null;
    if (isTauri()) {
      try {
        version = await getKimiCliVersion();
      } catch {
        version = null;
      }
      try {
        const config = await getGlobalConfig();
        modelLabel = config.defaultModel || null;
        modelDisplayName = modelLabel;
        const matched = config.models?.find((m) => m.name === modelLabel || m.model === modelLabel);
        if (matched?.name) modelDisplayName = matched.name;
        const effort = (config.thinkingEffort ?? "").trim();
        if (effort) thinkingEffort = effort;
        else thinkingEffort = config.defaultThinking ? "on" : "off";
      } catch {
        modelLabel = null;
      }
      if (sessionId) {
        try {
          const session = await getSession(sessionId);
          workDir = session?.workDir ?? null;
          sessionTitle = session?.title?.trim() ? session.title : null;
        } catch {
          workDir = null;
        }
      }
    }
    const token = tokenUsageRef.current;
    const sessionUsage: SessionUsageContext = {
      contextUsage: contextUsageRef.current,
      contextTokens: contextTokensRef.current,
      maxContextTokens: maxContextTokensRef.current,
      modelLabel,
      tokenInput: token?.input_other ?? null,
      tokenOutput: token?.output ?? null,
      tokenCacheRead: token?.input_cache_read ?? null,
      tokenCacheCreation: token?.input_cache_creation ?? null,
    };
    if (command === "usage") {
      return formatUsageReport({ managed, session: sessionUsage });
    }
    return formatStatusReport({
      managed,
      status: {
        version,
        model: modelLabel,
        modelDisplayName,
        workDir,
        sessionId,
        sessionTitle,
        permissionMode: permissionModeRef.current,
        planMode: planModeRef.current,
        thinkingEffort,
      },
      session: sessionUsage,
    });
  };

  // Send message to session (auto-connects if not connected)
  const sendMessage = async (
    text: string,
    attachments: UploadSessionFileResponse[] = [],
    options: SendMessageOptions = {},
  ): Promise<SendMessageResult> => {
    syncRefsFromState();
    if (!text.trim() && attachments.length === 0) return;

    const initialModes = options.initialModes;
    if (initialModes) {
      pendingModeUpdatesRef.current = {
        planMode: initialModes.planMode,
        permissionMode: initialModes.permissionMode,
        swarmMode: initialModes.swarmMode,
        goalMode: initialModes.goalMode,
      };
      planModeRef.current = initialModes.planMode;
      permissionModeRef.current = initialModes.permissionMode;
      swarmModeRef.current = initialModes.swarmMode;
      goalModeRef.current = initialModes.goalMode;
      setPlanMode(initialModes.planMode);
      setPermissionMode(initialModes.permissionMode);
      setSwarmMode(initialModes.swarmMode);
      setGoalMode(initialModes.goalMode);
    }

    const trimmedText = text.trim();
    const slashDecision = classifySlashDispatch(trimmedText, slashCommandsRef.current ?? []);

    let promptText = trimmedText;
    let goalAction: GoalPromptAction | undefined;
    let isGoalPrompt = false;
    if (slashDecision.kind === "local" && slashDecision.name === "goal") {
      const goalCommand = parseGoalCommand(slashDecision.args);
      if (goalCommand.kind === "status") {
        try {
          const snapshot = await syncGoalSnapshot();
          return {
            kind: "info-panel",
            command: "goal",
            content: formatGoalStatus(snapshot),
          };
        } catch (err) {
          return {
            kind: "info-panel",
            command: "goal",
            content: err instanceof Error ? err.message : "Failed to read Goal status",
            error: true,
          };
        }
      }
      if (goalCommand.kind === "invalid") {
        return {
          kind: "info-panel",
          command: "goal",
          content: goalCommand.message,
        };
      }
      if (
        goalCommand.kind === "pause" ||
        goalCommand.kind === "resume" ||
        goalCommand.kind === "cancel"
      ) {
        if (!sessionId || !isTauri()) {
          return {
            kind: "info-panel",
            command: "goal",
            content: "Goal controls require a Kimi Code desktop session.",
            error: true,
          };
        }
        try {
          // A lifecycle command is authoritative over any older in-flight
          // goal_refresh read. Invalidate both before and after the IPC so a
          // late active snapshot cannot resurrect a cancelled Goal.
          goalSnapshotRequestSeqRef.current += 1;
          const snapshot = await controlSessionGoal(sessionId, goalCommand.kind);
          goalSnapshotRequestSeqRef.current += 1;
          if (activeSessionIdRef.current === sessionId) {
            useToolEventsStore.getState().setCurrentGoal(snapshot);
          }
          if (goalCommand.kind !== "resume") {
            return {
              kind: "info-panel",
              command: "goal",
              content:
                goalCommand.kind === "cancel" && !snapshot
                  ? "Goal cancelled and cleared."
                  : formatGoalStatus(snapshot),
            };
          }
          if (!snapshot) {
            return {
              kind: "info-panel",
              command: "goal",
              content: "No current Goal to resume.",
              error: true,
            };
          }
          // Resume is performed by the following Goal-aware ACP prompt:
          // Kimi's native GetGoal/UpdateGoal tools reactivate the existing
          // state, then its own multi-turn Goal driver continues the work.
        } catch (err) {
          return {
            kind: "info-panel",
            command: "goal",
            content: err instanceof Error ? err.message : `Failed to ${goalCommand.kind} Goal`,
            error: true,
          };
        }
      }

      const goalPrompt = goalPromptForCommand(goalCommand);
      if (!goalPrompt) {
        return {
          kind: "info-panel",
          command: "goal",
          content: "Unsupported Goal command.",
          error: true,
        };
      }
      promptText = goalPrompt.text;
      goalAction = goalPrompt.action;
      isGoalPrompt = true;
    }
    if (slashDecision.kind === "local" && slashDecision.name === "swarm") {
      const arg = slashDecision.args.trim().toLowerCase();
      const nextMode = arg === "on" ? true : arg === "off" ? false : !swarmModeRef.current;
      if (!sendSetSwarmMode(nextMode)) {
        throw new Error("No session selected");
      }
      return;
    }

    if (slashDecision.kind === "blocked") {
      addOptimisticUserMessage(trimmedText);
      const statusMessageId = getNextMessageId("assistant");
      setMessages((prev) => [
        ...prev,
        {
          id: statusMessageId,
          role: "assistant",
          variant: "status",
          content: slashDecision.message,
          isStreaming: false,
        },
      ]);
      return;
    }

    if (slashDecision.kind === "local" && !isGoalPrompt) {
      if (slashDecision.name === "usage" || slashDecision.name === "status") {
        try {
          const content = await runLocalInfoCommand(slashDecision.name);
          return {
            kind: "info-panel",
            command: slashDecision.name,
            content,
          };
        } catch (err) {
          return {
            kind: "info-panel",
            command: slashDecision.name,
            content: err instanceof Error ? err.message : `Failed to run /${slashDecision.name}`,
          };
        }
      }

      addOptimisticUserMessage(trimmedText);
      const statusMessageId = getNextMessageId("assistant");
      let content = "";
      try {
        content = formatDesktopHelpReport(slashCommandsRef.current ?? []);
      } catch (err) {
        content = err instanceof Error ? err.message : `Failed to run /${slashDecision.name}`;
      }
      setMessages((prev) => [
        ...prev,
        {
          id: statusMessageId,
          role: "assistant",
          variant: "status",
          content,
          isStreaming: false,
        },
      ]);
      return;
    }

    const compactSlash = parseSlashCommandInput(trimmedText);
    const isCompactCommand = compactSlash?.name === "compact";
    if (
      !goalAction &&
      !compactSlash &&
      goalModeRef.current &&
      useToolEventsStore.getState().currentGoal === null
    ) {
      goalAction = "create";
    }

    const startsGoal = goalAction === "create" || goalAction === "replace";
    if (startsGoal && !options.goalStartConfirmed && permissionModeRef.current !== "auto") {
      return {
        kind: "goal-start-confirmation",
        objective: promptText,
        replace: goalAction === "replace",
        permissionMode: permissionModeRef.current,
        goalSwitchArmed: goalModeRef.current,
      };
    }

    // Defense against double-fire from StrictMode effects, unstable effect
    // deps, or rapid double Enter/click before React re-renders `busy`.
    if (
      pendingMessageRef.current !== null ||
      promptRequestIdsRef.current.size > 0 ||
      awaitingFirstResponseRef.current ||
      statusRef.current === "submitted" ||
      statusRef.current === "streaming"
    ) {
      console.warn("[SessionStream] Ignoring duplicate send while a prompt is in flight");
      return;
    }

    // The bottom Goal switch arms exactly one Goal, matching the CLI's
    // one-shot `/goal <objective>` entry point rather than becoming a
    // persistent "turn every future prompt into a Goal" mode.
    const goalSwitchWasArmed = startsGoal && goalModeRef.current;
    if (goalSwitchWasArmed) {
      sendSetGoalMode(false);
    }

    clearStepRetryStatus();
    resetStepState();
    setError(null);
    if (isCompactCommand) {
      pendingCompactRef.current = true;
      const compactionMsgId = getNextMessageId("assistant");
      compactionMessageIdRef.current = compactionMsgId;
      setMessages((prev) => [
        ...prev,
        {
          id: compactionMsgId,
          role: "assistant",
          variant: "status",
          content: "Compacting conversation history…",
          isStreaming: true,
        },
      ]);
    } else {
      addOptimisticUserMessage(trimmedText, attachments);
    }
    const startedAt = performance.now();
    promptTimingRef.current = {
      startedAt,
      ...(wsRef.current?.readyState === STREAM_OPEN ? { workerReadyAt: startedAt } : {}),
    };
    setAwaitingFirstResponse(true);
    setStatus("submitted");

    // If not connected, store the message and connect
    if (!wsRef.current || wsRef.current.readyState !== STREAM_OPEN) {
      if (!sessionId) {
        throw new Error("No session selected");
      }

      pendingMessageRef.current = {
        text: promptText,
        attachments,
        ...(goalAction ? { goalAction } : {}),
        ...(options.upcomingGoalId ? { upcomingGoalId: options.upcomingGoalId } : {}),
        ...(goalSwitchWasArmed ? { goalSwitchWasArmed: true } : {}),
      };
      preserveMessagesOnConnectRef.current = true;
      if (wsRef.current?.readyState === STREAM_CONNECTING) {
        return;
      }
      connect();
      return;
    }

    // Send as JSON-RPC prompt message — modes must land before the prompt so
    // ACP is not still on `default`/manual when the first tool asks permission.
    const connection = wsRef.current;
    try {
      await flushPendingModeUpdates(connection);
    } catch (err) {
      if (pendingCompactRef.current) {
        pendingCompactRef.current = false;
        const compactMsgId = compactionMessageIdRef.current;
        compactionMessageIdRef.current = null;
        if (compactMsgId) {
          setMessages((prev) => prev.filter((message) => message.id !== compactMsgId));
        }
      } else {
        optimisticUserMessagesRef.current.shift();
      }
      if (goalSwitchWasArmed) rearmFailedGoalStart();
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      onError?.(error);
      setAwaitingFirstResponse(false);
      setStatus("error");
      throw error;
    }

    const messageId = uuidV4();
    promptRequestIdsRef.current.add(messageId);
    const message: WireMessage = {
      jsonrpc: "2.0",
      method: "prompt",
      id: messageId,
      params: {
        user_input: joinPromptText(promptText, attachments) || "KIMI_FILE_UPLOAD_WITHOUT_MESSAGE",
        plan_mode: planModeRef.current,
        swarm_mode: swarmModeRef.current,
        goal_mode: goalModeRef.current,
        ...(goalAction ? { goal_action: goalAction } : {}),
        ...(options.upcomingGoalId ? { upcoming_goal_id: options.upcomingGoalId } : {}),
      },
    };

    try {
      if (promptTimingRef.current) {
        promptTimingRef.current.promptSubmittedAt = performance.now();
      }
      const sendResult = Promise.resolve(connection.send(JSON.stringify(message)));
      void sendResult
        .then(() => {
          awaitingIdleRef.current = false;
        })
        .catch((err) => {
          promptRequestIdsRef.current.delete(messageId);
          if (pendingCompactRef.current) {
            pendingCompactRef.current = false;
            const compactMsgId = compactionMessageIdRef.current;
            compactionMessageIdRef.current = null;
            if (compactMsgId) {
              setMessages((prev) => prev.filter((m) => m.id !== compactMsgId));
            }
          } else {
            optimisticUserMessagesRef.current.shift();
          }
          if (goalSwitchWasArmed && useToolEventsStore.getState().currentGoal === null) {
            rearmFailedGoalStart();
          }
          const error = err instanceof Error ? err : new Error(String(err));
          setError(error);
          onError?.(error);
          setAwaitingFirstResponse(false);
          setStatus("error");
        });
    } catch (err) {
      promptRequestIdsRef.current.delete(messageId);
      if (pendingCompactRef.current) {
        pendingCompactRef.current = false;
        const compactMsgId = compactionMessageIdRef.current;
        compactionMessageIdRef.current = null;
        if (compactMsgId) {
          setMessages((prev) => prev.filter((m) => m.id !== compactMsgId));
        }
      } else {
        optimisticUserMessagesRef.current.shift();
      }
      if (goalSwitchWasArmed && useToolEventsStore.getState().currentGoal === null) {
        rearmFailedGoalStart();
      }
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      onError?.(error);
      setAwaitingFirstResponse(false);
      setStatus("error");
      throw error;
    }
  };

  const controlGoal = async (action: "pause" | "resume" | "cancel") => {
    const outcome = await sendMessage(`/goal ${action}`);
    return outcome?.kind === "info-panel" ? outcome : undefined;
  };
  // Clear messages
  const clearMessages = () => {
    syncRefsFromState();
    resetStateRef.current(true);
    setMessages([]);
  };
  let startGeneration = 0;

  /**
   * Start the per-session lifecycle (former useLayoutEffect([sessionId]) body):
   * disconnect any stale worker, reset per-session accumulators, then run the
   * async startup chain (goal/config/modes restore + fast history replay or
   * autoConnect connect). A stop() (or a newer start()) invalidates the in-flight
   * chain via `startGeneration`.
   */
  const start = (): void => {
    const generation = ++startGeneration;

    // When sessionId changes, disconnect from previous session
    if (wsRef.current) {
      disconnect();
    }

    // Reset state for the new session. Swarm is loaded from Kimi's per-session
    // state below; localStorage is only consulted for one-time migration.
    pendingModeUpdatesRef.current = {};
    setGoalCompletionEpoch(0);
    resetState(true);
    setSwarmMode(false);
    swarmModeRef.current = false;
    setGoalMode(false);
    goalModeRef.current = false;
    setMessages([]);
    resetBackgroundTaskNotifications();
    useToolEventsStore.getState().clearNewFiles();
    useToolEventsStore.getState().clearTodoItems();
    useToolEventsStore.getState().clearCurrentGoal();
    syncRefsFromState();

    // Capture the target session id for this start run.
    const targetSessionId = sessionId;
    const isCurrent = () => generation === startGeneration;

    const startSession = async () => {
      if (!targetSessionId) {
        setIsReplayingHistory(false);
        return;
      }

      if (isTauri()) {
        try {
          await syncGoalSnapshot(targetSessionId);
          if (!isCurrent()) return;
        } catch (error) {
          console.warn("[SessionStream] Failed to restore Goal state:", error);
        }
        try {
          const configState = await getSessionConfigState(targetSessionId);
          if (!isCurrent()) return;
          setSessionConfigState(configState);
          sessionConfigStateRef.current = configState;
        } catch (error) {
          console.warn("[SessionStream] Failed to load session config state:", error);
        }
      }

      let persistedModes: PersistedSessionModes = {
        planMode: false,
        permissionMode: "manual",
        swarmMode: false,
        goalMode: false,
      };
      if (isTauri()) {
        try {
          persistedModes = await loadSessionRuntimeModes(targetSessionId);
          if (!isCurrent()) {
            return;
          }
        } catch (error) {
          console.warn("[SessionStream] Failed to load session runtime modes:", error);
        }
      }

      if (!isCurrent()) {
        return;
      }

      const applyPersistedModes = () => {
        // Draft / in-flight UI writes win over the snapshot taken at session
        // open (often still `manual` for a brand-new session).
        if (typeof pendingModeUpdatesRef.current.planMode !== "boolean") {
          setPlanMode(persistedModes.planMode);
          planModeRef.current = persistedModes.planMode;
        }
        if (!pendingModeUpdatesRef.current.permissionMode) {
          setPermissionMode(persistedModes.permissionMode);
          permissionModeRef.current = persistedModes.permissionMode;
        }
        if (typeof pendingModeUpdatesRef.current.swarmMode !== "boolean") {
          setSwarmMode(persistedModes.swarmMode);
          swarmModeRef.current = persistedModes.swarmMode;
        }
        if (typeof pendingModeUpdatesRef.current.goalMode !== "boolean") {
          setGoalMode(persistedModes.goalMode);
          goalModeRef.current = persistedModes.goalMode;
        }
      };

      // In Tauri, opening a completed session should not pay the full worker
      // startup cost. Read persisted history first; connect the worker only for
      // running sessions or when the user sends a prompt.
      if (isTauri() && !autoConnectRef.current) {
        setStatus("submitted");
        isReplayingRef.current = true;
        setIsReplayingHistory(true);

        try {
          const historyMessages = await replaySessionHistory(targetSessionId);
          if (!isCurrent()) {
            return;
          }
          await replayHistoryMessagesInBatches(
            historyMessages,
            (message) => handleMessageRef.current(message),
            () => !isCurrent(),
          );
          if (!isCurrent()) {
            return;
          }
          flushInlineThinkBufferRef.current(true);
          flushBufferedStreamUpdateRef.current();
          void syncGoalSnapshot(targetSessionId).catch((error) => {
            console.warn("[SessionStream] Failed to restore Goal after history replay:", error);
          });
          isReplayingRef.current = false;
          setIsReplayingHistory(false);
          // Lazy connect: only spawn `kimi acp` for a pending prompt (or when
          // autoConnect is true for running sessions). Idle sessions stay on
          // local history until the user sends a message.
          if (pendingMessageRef.current) {
            preserveMessagesOnConnectRef.current = true;
            skipReplayOnConnectRef.current = true;
            connectRef.current();
          } else {
            setStatus("ready");
            preserveMessagesOnConnectRef.current = true;
            skipReplayOnConnectRef.current = true;
          }
          // History StatusUpdate may restore modes; re-apply the resolved
          // snapshot so permission / plan / swarm stay consistent if replay
          // omitted them.
          applyPersistedModes();
        } catch (err) {
          if (!isCurrent()) {
            return;
          }
          const historyError = err instanceof Error ? err : new Error(String(err));
          console.warn("[SessionStream] Fast history replay failed:", historyError);
          setError(historyError);
          onError?.(historyError);
          isReplayingRef.current = false;
          setIsReplayingHistory(false);
          setStatus("ready");
          applyPersistedModes();
        }
        return;
      }

      connectRef.current();
      applyPersistedModes();
    };

    void startSession();
  };

  /**
   * Stop the runtime (former layout-effect cleanup + switch cleanup): cancel
   * any in-flight start chain, disconnect the worker, and reset per-session
   * accumulators so a later start() begins from a clean slate.
   */
  const stop = (): void => {
    startGeneration += 1;
    disconnect();
    pendingModeUpdatesRef.current = {};
    setGoalCompletionEpoch(0);
    resetState(true);
    setSwarmMode(false);
    swarmModeRef.current = false;
    setGoalMode(false);
    goalModeRef.current = false;
    setMessages([]);
    resetBackgroundTaskNotifications();
    useToolEventsStore.getState().clearNewFiles();
    useToolEventsStore.getState().clearTodoItems();
    useToolEventsStore.getState().clearCurrentGoal();
    syncRefsFromState();
  };

  /**
   * Incoming wire message entry point. The connect() registration and the
   * browser WebSocket handler both route through here; PR-C replaces the
   * per-session registration with a global listener that dispatches to the
   * owning engine via this method.
   */
  const handleWireMessage = (message: string): void => {
    lastWsMessageTimeRef.current = Date.now();
    setField("lastEventAt", Date.now());
    handleMessage(message);
    // Ref mirrors update at wire boundaries (the former render-time sync).
    syncRefsFromState();
  };

  const updateOptions = (nextOptions: SessionRuntimeOptions): void => {
    sessionId = nextOptions.sessionId;
    baseUrl = nextOptions.baseUrl;
    autoConnect = nextOptions.autoConnect ?? false;
    onError = nextOptions.onError;
    onSessionStatus = nextOptions.onSessionStatus;
    onFirstTurnComplete = nextOptions.onFirstTurnComplete;
    registerPerSessionListener = nextOptions.registerPerSessionListener ?? true;
    // Option forwarding only. The state-derived ref mirrors are synced at
    // wire-event / action boundaries (syncRefsFromState) so that timer-driven
    // state changes behave like the former render-deferred ref sync.
    activeSessionIdRef.current = sessionId;
    autoConnectRef.current = autoConnect;
  };

  return {
    get sessionId() {
      return sessionId;
    },
    getSnapshot: () => state,
    subscribe,
    updateOptions,
    handleWireMessage,
    sendMessage,
    runLocalInfoCommand,
    respondToApproval,
    respondToQuestion,
    controlGoal,
    cancel,
    disconnect,
    reconnect,
    connect,
    setMessages,
    clearMessages,
    sendSetPlanMode,
    sendSetPermissionMode,
    sendSetSwarmMode,
    sendSetGoalMode,
    sendSetConfigOption,
    start,
    stop,
  };
}
