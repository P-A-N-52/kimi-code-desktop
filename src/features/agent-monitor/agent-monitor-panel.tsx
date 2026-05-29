import { ActivityIcon, XCircleIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAgentMonitorStore } from "./agent-monitor-store";
import { AgentMonitorItem } from "./agent-monitor-item";

interface AgentMonitorPanelProps {
  className?: string;
  onClose?: () => void;
}

export function AgentMonitorPanel({ className, onClose }: AgentMonitorPanelProps) {
  const tasks = useAgentMonitorStore((s) => s.tasks);
  const cancelTask = useAgentMonitorStore((s) => s.cancelTask);
  const cancelAll = useAgentMonitorStore((s) => s.cancelAll);

  const runningCount = tasks.filter((t) => t.status === "running").length;

  return (
    <aside
      className={cn(
        "flex h-full min-h-0 flex-col bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/85",
        className,
      )}
    >
      <div className="border-b px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <ActivityIcon className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">Agent Monitor</h2>
            {runningCount > 0 ? (
              <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                {runningCount}
              </span>
            ) : null}
          </div>
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={onClose}
              aria-label="Collapse agent monitor"
            >
              <XCircleIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>

        {runningCount > 0 ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="mt-3 w-full text-xs"
            onClick={() => {
              console.log("Cancel all tasks");
              cancelAll();
            }}
          >
            Cancel All
          </Button>
        ) : null}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-3">
          {tasks.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-center text-muted-foreground">
              <ActivityIcon className="size-6 opacity-50" />
              <p className="text-sm font-medium">No active agents</p>
              <p className="max-w-48 text-xs">
                Running subagents will appear here when spawned by the Agent tool.
              </p>
            </div>
          ) : (
            tasks.map((task) => (
              <AgentMonitorItem key={task.id} task={task} onCancel={cancelTask} />
            ))
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
