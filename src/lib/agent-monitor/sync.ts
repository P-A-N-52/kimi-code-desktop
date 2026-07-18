import type {
  SubagentEventWire,
  SubagentLifecycleEvent,
  TaskCompletedEvent,
  TaskCreatedEvent,
  TaskProgressEvent,
} from "@/hooks/wireTypes";
import {
  type AgentTask,
  type AgentTaskStatus,
  isActiveAgentStatus,
  UNSCOPED_AGENT_SESSION_ID,
  useAgentMonitorStore,
} from "./store";

type UnknownRecord = Record<string, unknown>;

export type AgentTaskEventEnvelope = {
  type?: string;
  payload?: unknown;
};

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : {};
}

function firstDefined(record: UnknownRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function readString(record: UnknownRecord, ...keys: string[]): string | undefined {
  const value = firstDefined(record, ...keys);
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(record: UnknownRecord, ...keys: string[]): number | undefined {
  const value = firstDefined(record, ...keys);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readBoolean(record: UnknownRecord, ...keys: string[]): boolean | undefined {
  const value = firstDefined(record, ...keys);
  return typeof value === "boolean" ? value : undefined;
}

function readTimestamp(record: UnknownRecord, ...keys: string[]): number | undefined {
  const value = firstDefined(record, ...keys);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

export function normalizeAgentTaskStatus(status: unknown): AgentTaskStatus {
  const normalized = String(status ?? "queued")
    .trim()
    .toLowerCase();
  switch (normalized) {
    case "running":
    case "working":
    case "in_progress":
    case "in-progress":
    case "started":
      return "running";
    case "suspended":
    case "paused":
    case "waiting":
      return "suspended";
    case "success":
    case "succeeded":
    case "complete":
    case "completed":
    case "done":
      return "success";
    case "error":
    case "failed":
    case "failure":
      return "error";
    case "cancelled":
    case "canceled":
    case "aborted":
    case "interrupted":
      return "cancelled";
    default:
      return "queued";
  }
}

function defaultStep(status: AgentTaskStatus): string {
  switch (status) {
    case "queued":
      return "Waiting to start";
    case "running":
      return "Working";
    case "suspended":
      return "Suspended";
    case "success":
      return "Completed";
    case "error":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function unwrapPayload(event: AgentTaskEventEnvelope): UnknownRecord {
  return asRecord(event.payload);
}

function getTaskRecord(payload: UnknownRecord): UnknownRecord {
  const task = payload.task;
  return task !== null && typeof task === "object" ? asRecord(task) : payload;
}

function getSessionId(payload: UnknownRecord, task: UnknownRecord): string {
  return (
    readString(task, "session_id", "sessionId") ??
    readString(payload, "session_id", "sessionId") ??
    UNSCOPED_AGENT_SESSION_ID
  );
}

function createTaskFromRecord(payload: UnknownRecord): AgentTask | null {
  const raw = getTaskRecord(payload);
  const id = readString(raw, "id", "task_id", "taskId");
  if (!id) return null;

  const status = normalizeAgentTaskStatus(firstDefined(raw, "status", "state", "outcome"));
  const createdAt =
    readTimestamp(raw, "created_at", "createdAt") ??
    readTimestamp(payload, "created_at", "createdAt") ??
    Date.now();
  const startedAt = readTimestamp(raw, "started_at", "startedAt");
  const completedAt = readTimestamp(raw, "completed_at", "completedAt");
  const agentType =
    readString(raw, "subagent_type", "subagentType", "agent_type", "agentType") ?? "agent";
  const description =
    readString(raw, "description", "item", "task") ??
    readString(raw, "command") ??
    `${agentType} agent`;
  const subagentPhase = readString(raw, "subagent_phase", "subagentPhase", "phase");
  const suspendedReason = readString(raw, "suspended_reason", "suspendedReason", "reason");

  return {
    id,
    sessionId: getSessionId(payload, raw),
    kind: readString(raw, "kind") ?? "subagent",
    agentType,
    description,
    status,
    currentStep: subagentPhase ?? suspendedReason ?? defaultStep(status),
    createdAt,
    startedAt,
    completedAt,
    command: readString(raw, "command"),
    outputPreview: readString(raw, "output_preview", "outputPreview"),
    outputBytes: readNumber(raw, "output_bytes", "outputBytes"),
    subagentPhase,
    parentToolCallId: readString(
      raw,
      "parent_tool_call_id",
      "parentToolCallId",
      "task_tool_call_id",
    ),
    suspendedReason,
    swarmIndex: readNumber(raw, "swarm_index", "swarmIndex"),
    runInBackground: readBoolean(raw, "run_in_background", "runInBackground"),
  };
}

function findTask(id: string, sessionId?: string): AgentTask | undefined {
  return useAgentMonitorStore
    .getState()
    .tasks.find(
      (task) => task.id === id && (sessionId === undefined || task.sessionId === sessionId),
    );
}

function ensureTask(id: string, sessionId: string, patch: Partial<AgentTask>): AgentTask {
  const store = useAgentMonitorStore.getState();
  const existing = findTask(id, sessionId);
  if (existing) return existing;

  const now = Date.now();
  const status = patch.status ?? "queued";
  const task: AgentTask = {
    id,
    sessionId,
    kind: patch.kind ?? "subagent",
    agentType: patch.agentType ?? "agent",
    description: patch.description ?? `${patch.agentType ?? "agent"} agent`,
    status,
    currentStep: patch.currentStep ?? defaultStep(status),
    createdAt: patch.createdAt ?? now,
    ...patch,
  };
  store.upsertTask(task);
  return task;
}

export function syncAgentMonitorFromTaskCreated(
  event: TaskCreatedEvent | AgentTaskEventEnvelope,
): void {
  const payload = unwrapPayload(event);
  const task = createTaskFromRecord(payload);
  if (!task) return;
  useAgentMonitorStore.getState().upsertTask(task);
}

function appendOutput(existing: AgentTask, chunk: string, stream?: string) {
  if (stream === "text" && existing.kind === "subagent") {
    return { text: `${existing.text ?? ""}${chunk}` };
  }

  const outputLines = [...(existing.outputLines ?? []), chunk];
  return { outputLines: outputLines.slice(-40) };
}

export function syncAgentMonitorFromTaskProgress(
  event: TaskProgressEvent | AgentTaskEventEnvelope,
): void {
  const payload = unwrapPayload(event);
  const id = readString(payload, "task_id", "taskId", "id");
  if (!id) return;
  const sessionId = readString(payload, "session_id", "sessionId") ?? UNSCOPED_AGENT_SESSION_ID;
  const existing = ensureTask(id, sessionId, {
    status: "running",
    startedAt: Date.now(),
  });
  const chunk = readString(payload, "output_chunk", "outputChunk", "chunk");
  const stream = readString(payload, "stream");
  const phase = readString(payload, "subagent_phase", "subagentPhase", "phase");

  useAgentMonitorStore.getState().updateTask(
    id,
    {
      status: "running",
      startedAt: existing.startedAt ?? Date.now(),
      currentStep: phase ?? existing.currentStep ?? "Working",
      subagentPhase: phase ?? existing.subagentPhase,
      ...(chunk ? appendOutput(existing, chunk, stream) : {}),
    },
    sessionId,
  );
}

export function syncAgentMonitorFromTaskCompleted(
  event: TaskCompletedEvent | AgentTaskEventEnvelope,
): void {
  const payload = unwrapPayload(event);
  const id = readString(payload, "task_id", "taskId", "id");
  if (!id) return;
  const sessionId = readString(payload, "session_id", "sessionId") ?? UNSCOPED_AGENT_SESSION_ID;
  const status = normalizeAgentTaskStatus(
    firstDefined(payload, "status", "state", "outcome") ?? "completed",
  );
  const terminalStatus = isActiveAgentStatus(status) ? "success" : status;
  const existing = ensureTask(id, sessionId, { status: terminalStatus });
  const outputPreview = readString(payload, "output_preview", "outputPreview");

  useAgentMonitorStore.getState().updateTask(
    id,
    {
      status: terminalStatus,
      completedAt: readTimestamp(payload, "completed_at", "completedAt") ?? Date.now(),
      currentStep:
        readString(payload, "subagent_phase", "subagentPhase", "phase") ??
        readString(payload, "error") ??
        defaultStep(terminalStatus),
      outputPreview: outputPreview ?? existing.outputPreview,
      outputBytes: readNumber(payload, "output_bytes", "outputBytes") ?? existing.outputBytes,
    },
    sessionId,
  );
}

function lifecycleKind(event: AgentTaskEventEnvelope): string {
  return String(event.type ?? "")
    .replace(/^event[._-]?/i, "")
    .replace(/^subagent[._-]?/i, "")
    .toLowerCase();
}

export function syncAgentMonitorFromSubagentLifecycle(
  event: SubagentLifecycleEvent | AgentTaskEventEnvelope,
): void {
  const payload = unwrapPayload(event);
  const id = readString(payload, "agent_id", "agentId", "task_id", "taskId", "id");
  if (!id) return;
  const sessionId = readString(payload, "session_id", "sessionId") ?? UNSCOPED_AGENT_SESSION_ID;
  const eventKind = lifecycleKind(event);
  const payloadPhase = readString(payload, "phase")?.toLowerCase();
  const kind = eventKind === "lifecycle" ? (payloadPhase ?? eventKind) : eventKind;
  const status =
    kind === "started"
      ? "running"
      : kind === "suspended"
        ? "suspended"
        : kind === "completed"
          ? "success"
          : kind === "failed"
            ? "error"
            : kind === "cancelled" || kind === "canceled" || kind === "aborted"
              ? "cancelled"
              : "queued";
  const reason = readString(payload, "suspended_reason", "suspendedReason", "reason", "error");
  const subagentPhase = readString(payload, "subagent_phase", "subagentPhase");
  const existing = ensureTask(id, sessionId, {
    status,
    agentType:
      readString(payload, "subagent_type", "subagentType", "agent_type", "agentType") ?? "agent",
    description: readString(payload, "description", "item", "task"),
    parentToolCallId: readString(
      payload,
      "parent_tool_call_id",
      "parentToolCallId",
      "task_tool_call_id",
    ),
    swarmIndex: readNumber(payload, "swarm_index", "swarmIndex"),
  });

  useAgentMonitorStore.getState().updateTask(
    id,
    {
      status,
      agentType:
        readString(payload, "subagent_type", "subagentType", "agent_type", "agentType") ??
        existing.agentType,
      description: readString(payload, "description", "item", "task") ?? existing.description,
      parentToolCallId:
        readString(payload, "parent_tool_call_id", "parentToolCallId", "task_tool_call_id") ??
        existing.parentToolCallId,
      swarmIndex: readNumber(payload, "swarm_index", "swarmIndex") ?? existing.swarmIndex,
      startedAt:
        status === "running"
          ? (readTimestamp(payload, "started_at", "startedAt") ?? existing.startedAt ?? Date.now())
          : existing.startedAt,
      completedAt: isActiveAgentStatus(status)
        ? existing.completedAt
        : (readTimestamp(payload, "completed_at", "completedAt") ?? Date.now()),
      subagentPhase: subagentPhase ?? payloadPhase ?? existing.subagentPhase,
      suspendedReason: reason ?? existing.suspendedReason,
      currentStep: reason ?? subagentPhase ?? defaultStep(status),
      outputPreview:
        readString(payload, "output_preview", "outputPreview", "summary") ?? existing.outputPreview,
    },
    sessionId,
  );
}

function describeSubagentStep(innerType: string, innerPayload: unknown): string {
  switch (innerType) {
    case "ContentPart": {
      const payload = asRecord(innerPayload);
      const text = readString(payload, "think", "text");
      return text?.slice(0, 120) ?? "Processing response";
    }
    case "ToolCall": {
      const payload = asRecord(innerPayload);
      const fn = asRecord(payload.function);
      return `Running ${readString(fn, "name") ?? "tool"}`;
    }
    case "ToolResult":
      return "Tool finished";
    case "StepInterrupted":
      return "Interrupted";
    default:
      return "Working";
  }
}

export function syncAgentMonitorFromSubagentEvent(
  parentToolCallId: string,
  innerType: string,
  innerPayload: unknown,
  agentId?: string,
  subagentType?: string,
  sessionId = UNSCOPED_AGENT_SESSION_ID,
): void {
  const store = useAgentMonitorStore.getState();
  const taskId = agentId ?? parentToolCallId;
  const currentStep = describeSubagentStep(innerType, innerPayload);
  const existing = findTask(taskId, sessionId);

  if (!existing) {
    store.upsertTask({
      id: taskId,
      sessionId,
      kind: "subagent",
      agentType: subagentType ?? "agent",
      description: `${subagentType ?? "agent"} agent`,
      status: innerType === "StepInterrupted" ? "cancelled" : "running",
      currentStep,
      createdAt: Date.now(),
      startedAt: Date.now(),
      parentToolCallId,
    });
    return;
  }

  if (!isActiveAgentStatus(existing.status)) return;

  const inner = asRecord(innerPayload);
  const content = innerType === "ContentPart" ? readString(inner, "think", "text") : undefined;
  store.updateTask(
    taskId,
    {
      currentStep,
      status: innerType === "StepInterrupted" ? "cancelled" : "running",
      completedAt: innerType === "StepInterrupted" ? Date.now() : existing.completedAt,
      agentType: subagentType ?? existing.agentType,
      parentToolCallId,
      ...(content ? { text: `${existing.text ?? ""}${content}` } : {}),
    },
    sessionId,
  );
}

export function completeAgentMonitorTask(
  taskId: string,
  status: "success" | "error",
  currentStep?: string,
  sessionId?: string,
): void {
  const store = useAgentMonitorStore.getState();
  for (const task of store.tasks) {
    if (
      (task.id === taskId || task.parentToolCallId === taskId) &&
      isActiveAgentStatus(task.status) &&
      (sessionId === undefined || task.sessionId === sessionId)
    ) {
      store.completeTask(task.id, status, currentStep, task.sessionId);
    }
  }
}

export function completeRunningAgentMonitorTasks(
  status: "success" | "error",
  currentStep: string,
  sessionId?: string,
): void {
  const store = useAgentMonitorStore.getState();
  for (const task of store.tasks) {
    if (
      isActiveAgentStatus(task.status) &&
      (sessionId === undefined || task.sessionId === sessionId)
    ) {
      store.completeTask(task.id, status, currentStep, task.sessionId);
    }
  }
}

export function clearAgentMonitorSession(sessionId: string): void {
  useAgentMonitorStore.getState().clearSession(sessionId);
}

export function parseSubagentEventPayload(event: SubagentEventWire): {
  parentToolCallId?: string;
  agentId?: string;
  subagentType?: string;
  innerType: string;
  innerPayload: unknown;
} {
  const payload = event.payload;
  const parentToolCallId =
    payload.parent_tool_call_id ??
    ((payload as Record<string, unknown>).task_tool_call_id as string | undefined);
  return {
    parentToolCallId,
    agentId: payload.agent_id ?? undefined,
    subagentType: payload.subagent_type ?? undefined,
    innerType: payload.event.type,
    innerPayload: payload.event.payload,
  };
}
