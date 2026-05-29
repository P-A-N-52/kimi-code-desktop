import {
  CheckCircle2Icon,
  Loader2Icon,
  TerminalIcon,
  XCircleIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { AgentTask, AgentTaskStatus } from "./agent-monitor-store";

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function getStatusIcon(status: AgentTaskStatus) {
  switch (status) {
    case "running":
      return <Loader2Icon className="size-4 animate-spin text-primary" />;
    case "success":
      return <CheckCircle2Icon className="size-4 text-emerald-600 dark:text-emerald-400" />;
    case "error":
      return <XCircleIcon className="size-4 text-destructive" />;
  }
}

function getStatusBadgeVariant(status: AgentTaskStatus) {
  switch (status) {
    case "running":
      return "default";
    case "success":
      return "secondary";
    case "error":
      return "destructive";
  }
}

interface AgentMonitorItemProps {
  task: AgentTask;
  onCancel?: (id: string) => void;
}

export function AgentMonitorItem({ task, onCancel }: AgentMonitorItemProps) {
  const elapsed = task.endTime
    ? task.endTime - task.startTime
    : Date.now() - task.startTime;

  return (
    <div className="rounded-lg border bg-card/60 p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <TerminalIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium capitalize">{task.agentType}</span>
          <Badge variant={getStatusBadgeVariant(task.status)} className="text-[10px]">
            {task.status}
          </Badge>
        </div>
        {task.status === "running" && onCancel ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              console.log("Cancel task:", task.id);
              onCancel(task.id);
            }}
            aria-label="Cancel task"
          >
            <XCircleIcon className="size-3.5 text-muted-foreground hover:text-destructive" />
          </Button>
        ) : null}
      </div>

      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        {getStatusIcon(task.status)}
        <span className="min-w-0 flex-1 truncate">{task.currentStep}</span>
      </div>

      {typeof task.progress === "number" ? (
        <div className="mt-2">
          <Progress value={task.progress} className="h-1.5" />
        </div>
      ) : null}

      <div className="mt-2 text-right text-[10px] text-muted-foreground">
        {formatDuration(elapsed)}
      </div>
    </div>
  );
}
