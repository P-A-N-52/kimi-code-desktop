import { Bot, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { groupAgentTasks, useAgentMonitorStore } from "@/lib/agent-monitor/store";
import { cn } from "@/lib/utils";

const STATUS_LABELS = {
  queued: "排队中",
  running: "运行中",
  suspended: "已暂停",
  success: "已完成",
  error: "失败",
  cancelled: "已取消",
} as const;

export function AgentsTab({ sessionId }: { sessionId: string }) {
  const tasks = useAgentMonitorStore((state) => state.tasks);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const groups = useMemo(
    () => groupAgentTasks(tasks.filter((task) => task.sessionId === sessionId)),
    [tasks, sessionId],
  );

  if (groups.length === 0) {
    return (
      <p className="py-10 text-center font-mono text-[11px] text-faint">当前会话还没有代理任务</p>
    );
  }

  return (
    <div className="space-y-2 p-3">
      {groups.map((group) => {
        const open = openGroups.has(group.id);
        return (
          <div key={group.id} className="overflow-hidden rounded-r2 border border-line bg-elevated">
            <button
              type="button"
              onClick={() =>
                setOpenGroups((previous) => {
                  const next = new Set(previous);
                  if (next.has(group.id)) next.delete(group.id);
                  else next.add(group.id);
                  return next;
                })
              }
              className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-hover"
            >
              <Bot
                size={13}
                className={cn(
                  "shrink-0",
                  group.status === "running" ? "text-success" : "text-muted",
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11.5px] text-foreground">
                  {group.tasks.length > 1
                    ? `${group.tasks.length} 个并行代理`
                    : group.tasks[0]?.description || group.tasks[0]?.agentType}
                </p>
                <p className="font-mono text-[9.5px] text-faint">
                  {STATUS_LABELS[group.status]} · {group.settledCount}/{group.tasks.length}
                </p>
              </div>
              <ChevronRight
                size={12}
                className={cn("text-faint transition-transform", open && "rotate-90")}
              />
            </button>
            {open && (
              <div className="space-y-1 border-t border-line p-2">
                {group.tasks.map((task) => (
                  <div
                    key={`${task.sessionId}:${task.id}`}
                    className="rounded-r1 bg-surface px-2 py-1.5"
                  >
                    <div className="flex gap-2 text-[10.5px]">
                      <span className="font-mono text-bright">{task.agentType || task.kind}</span>
                      <span className="ml-auto text-faint">{STATUS_LABELS[task.status]}</span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-[10.5px] leading-relaxed text-muted">
                      {task.currentStep || task.outputPreview || task.description}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
