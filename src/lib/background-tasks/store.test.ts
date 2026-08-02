import { describe, expect, it, beforeEach } from "vitest";
import { useBackgroundTasksStore } from "./store";

describe("background tasks store", () => {
  beforeEach(() => {
    useBackgroundTasksStore.setState({ backgroundTasks: [], cronSchedules: [] });
  });

  it("upserts tasks by session and task id", () => {
    const store = useBackgroundTasksStore.getState();
    store.upsertBackgroundTask({
      sessionId: "sess-1",
      toolCallId: "call-1",
      taskId: "task-1",
      title: "Task Output",
      snapshot: "running",
      terminalState: "running",
      updatedAt: 1,
    });
    store.upsertBackgroundTask({
      sessionId: "sess-1",
      toolCallId: "call-2",
      taskId: "task-1",
      title: "Task Output",
      snapshot: "done",
      terminalState: "completed",
      updatedAt: 2,
    });
    expect(useBackgroundTasksStore.getState().backgroundTasks).toHaveLength(1);
    expect(useBackgroundTasksStore.getState().backgroundTasks[0]?.terminalState).toBe("completed");
  });

  it("clears only one session", () => {
    const store = useBackgroundTasksStore.getState();
    store.upsertBackgroundTask({
      sessionId: "sess-a",
      toolCallId: "call-a",
      taskId: "task-a",
      title: "Task Output",
      snapshot: "a",
      terminalState: "running",
      updatedAt: 1,
    });
    store.upsertBackgroundTask({
      sessionId: "sess-b",
      toolCallId: "call-b",
      taskId: "task-b",
      title: "Task Output",
      snapshot: "b",
      terminalState: "running",
      updatedAt: 1,
    });
    store.clearSession("sess-a");
    const tasks = useBackgroundTasksStore.getState().backgroundTasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.sessionId).toBe("sess-b");
  });
});
