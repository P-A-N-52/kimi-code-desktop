import {
  getToolPresentation,
  isBackgroundTaskObservationTool,
  isCronObservationTool,
} from "@/lib/tool-events/tool-registry";
import type {
  BackgroundTaskObservedPayload,
  ObservedBackgroundTask,
  ObservedBackgroundTaskState,
  ObservedCronSchedule,
} from "./types";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : {};
}

function readString(record: UnknownRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readBoolean(record: UnknownRecord, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

export function normalizeObservedTaskState(
  input: unknown,
  isError = false,
  inProgress = false,
): ObservedBackgroundTaskState {
  if (inProgress) return "running";
  if (isError) return "failed";
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase();
  switch (normalized) {
    case "running":
    case "in_progress":
    case "in-progress":
    case "working":
      return "running";
    case "completed":
    case "complete":
    case "done":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
    case "failure":
      return "failed";
    case "stopped":
    case "cancelled":
    case "canceled":
    case "aborted":
      return "stopped";
    default:
      return normalized ? "unknown" : "completed";
  }
}

export function extractTaskIdFromText(text: string): string | undefined {
  const patterns = [
    /\btask[_-]?id[:=\s]+["']?([a-zA-Z0-9_-]+)/i,
    /\btask\s+([a-f0-9-]{8,})\b/i,
    /\bid[:=\s]+["']?([a-f0-9]{8,})\b/i,
    /output written to [^\s]*\/([a-zA-Z0-9_-]+)\.txt/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function extractOutputPathFromText(text: string): string | undefined {
  const patterns = [
    /output[_-]?path[:=\s]+["']?([^\s"']+)/i,
    /output written to\s+([^\s]+)/i,
    /saved to\s+([^\s]+)/i,
    /(\.kimi\/tasks\/[^\s"']+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function taskIdFromArgs(args: UnknownRecord): string | undefined {
  return readString(args, "task_id", "taskId", "id");
}

function parseCronCreateSnapshot(text: string): Partial<ObservedCronSchedule> {
  const cronId = text.match(/\bid[:=\s]+["']?([a-f0-9]{8,})\b/i)?.[1];
  const humanSchedule = text.match(/human[_\s-]?schedule[:=\s]+["']?([^\n"']+)/i)?.[1];
  const nextFireAt = text.match(/next[_\s-]?fire[_\s-]?at[:=\s]+["']?([^\n"']+)/i)?.[1];
  const cronExpression = text.match(/cron[:=\s]+["']?([^\n"']+)/i)?.[1];
  const recurring = /recurring[:=\s]+(true|false)/i.exec(text)?.[1];
  return {
    cronId,
    humanSchedule: humanSchedule?.trim(),
    nextFireAt: nextFireAt?.trim(),
    cronExpression: cronExpression?.trim(),
    recurring: recurring ? recurring.toLowerCase() === "true" : undefined,
  };
}

function parseCronListEntries(
  text: string,
): Array<Omit<ObservedCronSchedule, "sessionId" | "toolCallId" | "updatedAt">> {
  const blocks = text
    .split(/\n---+\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (blocks.length === 0 && text.trim()) {
    blocks.push(text.trim());
  }

  return blocks.flatMap((block) => {
    const parsed = parseCronCreateSnapshot(block);
    if (!parsed.cronId) return [];
    return [
      {
        cronId: parsed.cronId,
        cronExpression: parsed.cronExpression,
        humanSchedule: parsed.humanSchedule,
        nextFireAt: parsed.nextFireAt,
        recurring: parsed.recurring,
        snapshot: block,
      } satisfies Partial<ObservedCronSchedule>,
    ];
  });
}

export function buildObservedBackgroundTask(args: {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  toolArguments?: string;
  output?: string;
  isError?: boolean;
  inProgress?: boolean;
  now?: number;
}): ObservedBackgroundTask | null {
  const presentation = getToolPresentation(args.toolName);
  if (!isBackgroundTaskObservationTool(presentation.canonicalName)) {
    return null;
  }

  let parsedArgs: UnknownRecord = {};
  if (args.toolArguments) {
    try {
      parsedArgs = asRecord(JSON.parse(args.toolArguments));
    } catch {
      parsedArgs = {};
    }
  }

  const snapshot = (args.output ?? "").trim();
  const taskId =
    taskIdFromArgs(parsedArgs) ??
    extractTaskIdFromText(snapshot) ??
    extractTaskIdFromText(args.toolArguments ?? "") ??
    args.toolCallId;

  const outputPath = extractOutputPathFromText(snapshot);
  const terminalState = normalizeObservedTaskState(
    readString(parsedArgs, "status", "state"),
    args.isError,
    args.inProgress,
  );

  return {
    sessionId: args.sessionId,
    toolCallId: args.toolCallId,
    taskId,
    title: presentation.displayName,
    snapshot,
    terminalState,
    outputPath,
    updatedAt: args.now ?? Date.now(),
  };
}

export function buildObservedCronSchedules(args: {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  output?: string;
  now?: number;
}): ObservedCronSchedule[] {
  const presentation = getToolPresentation(args.toolName);
  if (!isCronObservationTool(presentation.canonicalName)) {
    return [];
  }

  const snapshot = (args.output ?? "").trim();
  const now = args.now ?? Date.now();

  if (presentation.canonicalName === "CronCreate") {
    const parsed = parseCronCreateSnapshot(snapshot);
    if (!parsed.cronId) return [];
    return [
      {
        sessionId: args.sessionId,
        toolCallId: args.toolCallId,
        cronId: parsed.cronId,
        cronExpression: parsed.cronExpression,
        humanSchedule: parsed.humanSchedule,
        nextFireAt: parsed.nextFireAt,
        recurring: parsed.recurring,
        snapshot,
        updatedAt: now,
      },
    ];
  }

  if (presentation.canonicalName === "CronList") {
    return parseCronListEntries(snapshot).map((entry) => ({
      sessionId: args.sessionId,
      toolCallId: args.toolCallId,
      cronId: entry.cronId ?? args.toolCallId,
      cronExpression: entry.cronExpression,
      humanSchedule: entry.humanSchedule,
      nextFireAt: entry.nextFireAt,
      recurring: entry.recurring,
      snapshot: entry.snapshot ?? snapshot,
      updatedAt: now,
    }));
  }

  return [];
}

export function observedBackgroundTaskFromWirePayload(
  payload: BackgroundTaskObservedPayload,
): ObservedBackgroundTask | null {
  const taskId = payload.task_id?.trim() || payload.tool_call_id;
  if (!taskId) return null;
  return {
    sessionId: payload.session_id,
    toolCallId: payload.tool_call_id,
    taskId,
    title: getToolPresentation(payload.tool_name).displayName,
    snapshot: payload.snapshot,
    terminalState: payload.terminal_state,
    outputPath: payload.output_path ?? undefined,
    updatedAt: Date.now(),
  };
}

export function observedCronFromWirePayload(
  payload: BackgroundTaskObservedPayload,
): ObservedCronSchedule | null {
  const cronId = payload.cron_id?.trim();
  if (!cronId) return null;
  return {
    sessionId: payload.session_id,
    toolCallId: payload.tool_call_id,
    cronId,
    cronExpression: payload.cron_expression ?? undefined,
    humanSchedule: payload.human_schedule ?? undefined,
    nextFireAt: payload.next_fire_at ?? undefined,
    recurring: payload.recurring ?? undefined,
    snapshot: payload.snapshot,
    updatedAt: Date.now(),
  };
}

export function isTerminalObservedTaskState(state: ObservedBackgroundTaskState): boolean {
  return state === "completed" || state === "failed" || state === "stopped";
}

export function mergeObservedBackgroundTask(
  existing: ObservedBackgroundTask | undefined,
  incoming: ObservedBackgroundTask,
): ObservedBackgroundTask {
  if (!existing) return incoming;
  const keepTerminal =
    isTerminalObservedTaskState(existing.terminalState) &&
    incoming.terminalState === "running" &&
    incoming.snapshot === existing.snapshot;
  return {
    ...existing,
    ...incoming,
    terminalState: keepTerminal ? existing.terminalState : incoming.terminalState,
    snapshot: incoming.snapshot || existing.snapshot,
    outputPath: incoming.outputPath ?? existing.outputPath,
    title: incoming.title || existing.title,
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
  };
}

export function parseBackgroundSpawnFromToolResult(args: {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  toolArguments?: string;
  output?: string;
  inProgress?: boolean;
  now?: number;
}): ObservedBackgroundTask | null {
  let parsedArgs: UnknownRecord = {};
  if (args.toolArguments) {
    try {
      parsedArgs = asRecord(JSON.parse(args.toolArguments));
    } catch {
      parsedArgs = {};
    }
  }
  const runInBackground = readBoolean(parsedArgs, "run_in_background", "runInBackground") === true;
  const presentation = getToolPresentation(args.toolName);
  if (
    !runInBackground ||
    (presentation.canonicalName !== "Shell" && presentation.canonicalName !== "Agent")
  ) {
    return null;
  }

  const snapshot = (args.output ?? "").trim();
  const taskId = extractTaskIdFromText(snapshot) ?? extractTaskIdFromText(args.toolArguments ?? "");
  if (!taskId) return null;

  return {
    sessionId: args.sessionId,
    toolCallId: args.toolCallId,
    taskId,
    title: readString(parsedArgs, "description") ?? presentation.displayName,
    snapshot,
    terminalState: args.inProgress ? "running" : "unknown",
    outputPath: extractOutputPathFromText(snapshot),
    updatedAt: args.now ?? Date.now(),
  };
}
