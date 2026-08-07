/** Terminal state for an observed background task (Bash/Agent/TaskOutput). */
export type ObservedBackgroundTaskState =
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "unknown";

/** Normalized observation from Task/TaskList/TaskOutput tool activity. */
export type ObservedBackgroundTask = {
  sessionId: string;
  toolCallId: string;
  taskId: string;
  title: string;
  snapshot: string;
  terminalState: ObservedBackgroundTaskState;
  outputPath?: string;
  updatedAt: number;
};

/** Cached Cron schedule returned by Agent tools (read-only). */
export type ObservedCronSchedule = {
  sessionId: string;
  toolCallId: string;
  cronId: string;
  cronExpression?: string;
  humanSchedule?: string;
  nextFireAt?: string;
  recurring?: boolean;
  snapshot: string;
  updatedAt: number;
};

export type BackgroundTaskObservedPayload = {
  session_id: string;
  tool_call_id: string;
  tool_name: string;
  task_id?: string | null;
  snapshot: string;
  terminal_state: ObservedBackgroundTaskState;
  output_path?: string | null;
  cron_id?: string | null;
  cron_expression?: string | null;
  human_schedule?: string | null;
  next_fire_at?: string | null;
  recurring?: boolean | null;
};
