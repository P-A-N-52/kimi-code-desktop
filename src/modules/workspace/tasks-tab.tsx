import { Check, Circle, FilePlus2, Goal, LoaderCircle } from "lucide-react";
import { useToolEventsStore } from "@/lib/tool-events/store";

export function TasksTab() {
  const goal = useToolEventsStore((state) => state.currentGoal);
  const todoItems = useToolEventsStore((state) => state.todoItems);
  const newFiles = useToolEventsStore((state) => state.newFiles);
  const uniqueNewFiles = [...new Set(newFiles)];

  if (!goal && todoItems.length === 0 && newFiles.length === 0) {
    return (
      <p className="py-10 text-center font-mono text-[11px] text-faint">当前会话还没有任务摘要</p>
    );
  }

  return (
    <div className="space-y-4 p-3">
      {goal && (
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
            <Goal size={12} /> 当前目标
          </h3>
          <div className="rounded-r2 border border-line bg-elevated p-2.5">
            <p className="text-[11.5px] leading-relaxed text-foreground">{goal.objective}</p>
            <p className="mt-1 font-mono text-[9.5px] uppercase text-faint">{goal.status}</p>
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
