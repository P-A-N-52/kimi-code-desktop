import { getToolPresentation } from "@/lib/tool-events/tool-registry";
import {
  buildObservedBackgroundTask,
  buildObservedCronSchedules,
  isTerminalObservedTaskState,
  observedBackgroundTaskFromWirePayload,
  observedCronFromWirePayload,
  parseBackgroundSpawnFromToolResult,
} from "./normalize";
import type { BackgroundTaskObservedPayload } from "./types";
import { useBackgroundTasksStore } from "./store";

export type BackgroundTaskSyncResult = {
  terminalBackgroundTask?: {
    taskId: string;
    title: string;
    terminalState: "completed" | "failed" | "stopped";
  };
};

const notifiedTerminalTasks = new Set<string>();

export function resetBackgroundTaskNotifications(): void {
  notifiedTerminalTasks.clear();
}

export function syncBackgroundTaskFromToolResult(args: {
  sessionId: string;
  toolCallId: string;
  toolName?: string;
  toolArguments?: string;
  output?: string;
  isError?: boolean;
  inProgress?: boolean;
  isReplay?: boolean;
}): BackgroundTaskSyncResult {
  if (!args.sessionId || !args.toolCallId) {
    return {};
  }

  const store = useBackgroundTasksStore.getState();
  let terminalBackgroundTask: BackgroundTaskSyncResult["terminalBackgroundTask"];

  const resolvedName =
    args.toolName ??
    (args.toolArguments ? undefined : getToolPresentation("TaskOutput").canonicalName);

  if (resolvedName) {
    const observed = buildObservedBackgroundTask({
      sessionId: args.sessionId,
      toolCallId: args.toolCallId,
      toolName: resolvedName,
      toolArguments: args.toolArguments,
      output: args.output,
      isError: args.isError,
      inProgress: args.inProgress,
    });
    if (observed) {
      store.upsertBackgroundTask(observed);
      if (!args.inProgress && isTerminalObservedTaskState(observed.terminalState)) {
        terminalBackgroundTask = {
          taskId: observed.taskId,
          title: observed.title,
          terminalState: observed.terminalState as "completed" | "failed" | "stopped",
        };
      }
    }

    const cronSchedules = buildObservedCronSchedules({
      sessionId: args.sessionId,
      toolCallId: args.toolCallId,
      toolName: resolvedName,
      output: args.output,
    });
    if (cronSchedules.length > 0) {
      const presentation = getToolPresentation(resolvedName);
      if (presentation.canonicalName === "CronList") {
        store.replaceCronSchedules(args.sessionId, args.toolCallId, cronSchedules);
      } else {
        for (const schedule of cronSchedules) {
          store.upsertCronSchedule(schedule);
        }
      }
    }
  }

  if (args.toolName) {
    const spawned = parseBackgroundSpawnFromToolResult({
      sessionId: args.sessionId,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      toolArguments: args.toolArguments,
      output: args.output,
      inProgress: args.inProgress,
    });
    if (spawned) {
      store.upsertBackgroundTask(spawned);
    }
  }

  if (
    terminalBackgroundTask &&
    !args.isReplay &&
    !args.inProgress &&
    !notifiedTerminalTasks.has(`${args.sessionId}:${terminalBackgroundTask.taskId}`)
  ) {
    notifiedTerminalTasks.add(`${args.sessionId}:${terminalBackgroundTask.taskId}`);
    return { terminalBackgroundTask };
  }

  return {};
}

export function syncBackgroundTaskFromWire(
  payload: BackgroundTaskObservedPayload,
  isReplay = false,
): BackgroundTaskSyncResult {
  const store = useBackgroundTasksStore.getState();
  let terminalBackgroundTask: BackgroundTaskSyncResult["terminalBackgroundTask"];

  const task = observedBackgroundTaskFromWirePayload(payload);
  if (task) {
    store.upsertBackgroundTask(task);
    if (isTerminalObservedTaskState(task.terminalState)) {
      terminalBackgroundTask = {
        taskId: task.taskId,
        title: task.title,
        terminalState: task.terminalState as "completed" | "failed" | "stopped",
      };
    }
  }

  const cron = observedCronFromWirePayload(payload);
  if (cron) {
    store.upsertCronSchedule(cron);
  }

  if (
    terminalBackgroundTask &&
    !isReplay &&
    !notifiedTerminalTasks.has(`${payload.session_id}:${terminalBackgroundTask.taskId}`)
  ) {
    notifiedTerminalTasks.add(`${payload.session_id}:${terminalBackgroundTask.taskId}`);
    return { terminalBackgroundTask };
  }

  return {};
}

export function clearBackgroundTasksSession(sessionId: string): void {
  useBackgroundTasksStore.getState().clearSession(sessionId);
}
