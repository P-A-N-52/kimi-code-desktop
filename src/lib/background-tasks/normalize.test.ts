import { describe, expect, it } from "vitest";
import {
  buildObservedBackgroundTask,
  buildObservedCronSchedules,
  extractOutputPathFromText,
  extractTaskIdFromText,
  mergeObservedBackgroundTask,
  normalizeObservedTaskState,
} from "./normalize";

describe("background task normalize", () => {
  it("parses TaskOutput snapshots without blocking semantics", () => {
    const observed = buildObservedBackgroundTask({
      sessionId: "sess-1",
      toolCallId: "call-1",
      toolName: "TaskOutput",
      toolArguments: JSON.stringify({ task_id: "task-abc" }),
      output: "status: running\npartial output",
      inProgress: true,
    });
    expect(observed).toMatchObject({
      taskId: "task-abc",
      terminalState: "running",
      snapshot: "status: running\npartial output",
    });
  });

  it("merges terminal TaskOutput completion over prior running snapshot", () => {
    const running = buildObservedBackgroundTask({
      sessionId: "sess-1",
      toolCallId: "call-1",
      toolName: "TaskOutput",
      toolArguments: JSON.stringify({ task_id: "task-abc" }),
      output: "still running",
      inProgress: true,
    });
    const completed = buildObservedBackgroundTask({
      sessionId: "sess-1",
      toolCallId: "call-2",
      toolName: "TaskOutput",
      toolArguments: JSON.stringify({ task_id: "task-abc" }),
      output: "Task completed successfully.",
      inProgress: false,
    });
    expect(running && completed).toBeTruthy();
    if (!running || !completed) return;
    const merged = mergeObservedBackgroundTask(running, completed);
    expect(merged.terminalState).toBe("completed");
    expect(merged.snapshot).toContain("Task completed");
  });

  it("extracts output paths from TaskOutput text", () => {
    expect(
      extractOutputPathFromText(
        "Background task finished. Output written to .kimi/tasks/task-output-1.txt",
      ),
    ).toBe(".kimi/tasks/task-output-1.txt");
    expect(extractTaskIdFromText("task_id: task-output-1")).toBe("task-output-1");
  });

  it("parses CronList cache blocks", () => {
    const schedules = buildObservedCronSchedules({
      sessionId: "sess-1",
      toolCallId: "cron-list-1",
      toolName: "CronList",
      output: ["id: ab12cd34", "humanSchedule: every 5 minutes", "nextFireAt: 2026-07-31T12:00:00Z"].join(
        "\n",
      ),
    });
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      cronId: "ab12cd34",
      humanSchedule: "every 5 minutes",
    });
  });

  it("normalizes unknown states safely", () => {
    expect(normalizeObservedTaskState(undefined, false, false)).toBe("completed");
    expect(normalizeObservedTaskState("working", false, true)).toBe("running");
    expect(normalizeObservedTaskState("failed", true, false)).toBe("failed");
  });
});
