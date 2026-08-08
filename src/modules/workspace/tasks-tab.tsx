import { AlertCircle, Check, Circle, Clock, FilePlus2, ListTodo, LoaderCircle } from "lucide-react";
import { isTerminalObservedTaskState } from "@/lib/background-tasks/normalize";
import { useBackgroundTasksStore } from "@/lib/background-tasks/store";
import { EMPTY_TOOL_EVENTS, useToolEventsStore } from "@/lib/tool-events/store";
import { GoalCard } from "./goal-card";

function taskStateLabel(state: string): string {
  switch (state) {
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "stopped":
      return "已停止";
    default:
      return "未知";
  }
}

export function TasksTab({
  sessionId,
  onGoalControl,
}: {
  sessionId: string;
  onGoalControl?: (action: "pause" | "resume" | "cancel") => Promise<unknown>;
}) {
  const snapshot = useToolEventsStore(
    (state) => state.sessions[sessionId] ?? EMPTY_TOOL_EVENTS,
  );
  const { currentGoal: goal, todoItems, newFiles } = snapshot;
  // Select the stable arrays and filter in render; a `.filter()` inside the
  // selector returns a fresh array every snapshot and makes
  // useSyncExternalStore loop ("Maximum update depth exceeded").
  const allBackgroundTasks = useBackgroundTasksStore((state) => state.backgroundTasks);
  const allCronSchedules = useBackgroundTasksStore((state) => state.cronSchedules);
  const backgroundTasks = allBackgroundTasks.filter((task) => task.sessionId === sessionId);
  const cronSchedules = allCronSchedules.filter((schedule) => schedule.sessionId === sessionId);
  const uniqueNewFiles = [...new Set(newFiles)];

  if (
    !goal &&
    todoItems.length === 0 &&
    newFiles.length === 0 &&
    backgroundTasks.length === 0 &&
    cronSchedules.length === 0
  ) {
    return (
      <p className="py-10 text-center font-mono text-[11px] text-faint">当前会话还没有任务摘要</p>
    );
  }

  return (
    <div className="space-y-4 p-3">
      {goal && <GoalCard goal={goal} onControl={onGoalControl} />}
      {backgroundTasks.length > 0 && (
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
            <ListTodo size={12} /> 后台任务（只读）
          </h3>
          <p className="mb-2 text-[10px] text-faint">
            来自 Agent 已观察到的 Task/TaskOutput 结果；Desktop 不提供直接停止或控制。
          </p>
          <div className="space-y-1">
            {backgroundTasks.map((task) => (
              <div
                key={`${task.taskId}:${task.toolCallId}`}
                className="rounded-r1 px-2 py-1.5 text-[11px] hover:bg-hover"
              >
                <div className="flex items-center gap-2">
                  {task.terminalState === "running" ? (
                    <LoaderCircle size={13} className="animate-spin text-warning" />
                  ) : task.terminalState === "failed" ? (
                    <AlertCircle size={13} className="text-destructive" />
                  ) : task.terminalState === "stopped" ? (
                    <Circle size={13} className="text-faint" />
                  ) : isTerminalObservedTaskState(task.terminalState) ? (
                    <Check size={13} className="text-success" />
                  ) : (
                    <Circle size={13} className="text-faint" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                    {task.title} · {task.taskId}
                  </span>
                  <span className="font-mono text-[10px] text-faint">
                    {taskStateLabel(task.terminalState)}
                  </span>
                </div>
                {task.outputPath ? (
                  <p className="mt-1 truncate pl-5 font-mono text-[10px] text-muted">
                    {task.outputPath}
                  </p>
                ) : null}
                {task.snapshot ? (
                  <p className="mt-1 line-clamp-3 pl-5 font-mono text-[10px] text-faint">
                    {task.snapshot}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      )}
      {cronSchedules.length > 0 && (
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
            <Clock size={12} /> Cron 调度（缓存）
          </h3>
          <p className="mb-2 text-[10px] text-faint">
            仅展示 Agent 已返回的 CronCreate/CronList 结果；无 Desktop 控制 API。
          </p>
          <div className="space-y-1">
            {cronSchedules.map((schedule) => (
              <div
                key={`${schedule.cronId}:${schedule.toolCallId}`}
                className="rounded-r1 px-2 py-1.5 text-[11px] hover:bg-hover"
              >
                <div className="flex items-center gap-2">
                  <Clock size={13} className="text-muted" />
                  <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                    {schedule.humanSchedule ?? schedule.cronExpression ?? schedule.cronId}
                  </span>
                </div>
                {schedule.nextFireAt ? (
                  <p className="mt-1 pl-5 font-mono text-[10px] text-muted">
                    下次：{schedule.nextFireAt}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      )}
      {todoItems.length > 0 && (
        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
            Todo
          </h3>
          <div className="space-y-1">
            {todoItems.map((item) => (
              <div
                key={`${item.title}:${item.status}`}
                className="flex gap-2 rounded-r1 px-2 py-1.5 text-[11px] hover:bg-hover"
              >
                {item.status === "done" ? (
                  <Check size={13} className="text-success" />
                ) : item.status === "in_progress" ? (
                  <LoaderCircle size={13} className="animate-spin text-warning" />
                ) : (
                  <Circle size={13} className="text-faint" />
                )}
                <span
                  className={item.status === "done" ? "text-faint line-through" : "text-foreground"}
                >
                  {item.title}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      {newFiles.length > 0 && (
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
            <FilePlus2 size={12} /> 本轮文件
          </h3>
          <div className="space-y-1 font-mono text-[10.5px] text-muted">
            {uniqueNewFiles.map((path) => (
              <p key={path} className="truncate rounded-r1 bg-elevated px-2 py-1.5">
                {path}
              </p>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
