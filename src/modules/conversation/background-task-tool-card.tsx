import { ChevronRight, Clock, ListTodo } from "lucide-react";
import { useState } from "react";
import type { LiveMessage } from "@/hooks/types";
import { getToolPresentation } from "@/lib/tool-events/tool-registry";
import { cn } from "@/lib/utils";
import { Expandable } from "@/ui/expandable";
import { StatusDot } from "@/ui/status-dot";

type ToolCall = NonNullable<LiveMessage["toolCall"]>;

function stateLabel(state: ToolCall["state"], inProgress: boolean): string {
  if (inProgress || state === "input-available" || state === "input-streaming") {
    return "运行中";
  }
  if (state === "output-error") return "失败";
  if (state === "output-available") return "已完成";
  return "未知";
}

function isRunning(toolCall: ToolCall): boolean {
  return (
    toolCall.extras?.in_progress === true ||
    toolCall.state === "input-available" ||
    toolCall.state === "input-streaming"
  );
}

export function BackgroundTaskToolCard({
  toolCall,
  defaultOpen,
}: {
  toolCall: ToolCall;
  defaultOpen?: boolean;
}) {
  const presentation = getToolPresentation(toolCall.title);
  const running = isRunning(toolCall);
  const [open, setOpen] = useState(defaultOpen ?? running);
  const input =
    typeof toolCall.input === "object" && toolCall.input !== null
      ? (toolCall.input as Record<string, unknown>)
      : {};
  const taskId =
    (typeof input.task_id === "string" && input.task_id) ||
    (typeof input.taskId === "string" && input.taskId) ||
    toolCall.toolCallId;
  const outputPath =
    typeof toolCall.output === "string" && toolCall.output.includes(".kimi/tasks/")
      ? toolCall.output.match(/(\.kimi\/tasks\/[^\s]+)/)?.[1]
      : undefined;

  return (
    <div
      className="my-2.5 overflow-hidden rounded-r2 border border-line bg-elevated"
      data-slot="background-task-tool-card"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-hover"
      >
        {presentation.canonicalName === "CronList" || presentation.canonicalName === "CronCreate" ? (
          <Clock size={13} strokeWidth={1.5} className="shrink-0 text-muted" />
        ) : (
          <ListTodo size={13} strokeWidth={1.5} className="shrink-0 text-muted" />
        )}
        <span className="font-mono text-[12px] font-semibold text-foreground">
          {presentation.displayName}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">
          {taskId}
        </span>
        {running ? (
          <StatusDot status="running" />
        ) : toolCall.isError ? (
          <span className="font-mono text-[11px] text-danger">失败</span>
        ) : (
          <span className="font-mono text-[11px] text-faint">{stateLabel(toolCall.state, running)}</span>
        )}
        <ChevronRight
          size={12}
          strokeWidth={1.5}
          className={cn(
            "shrink-0 text-faint transition-transform duration-[160ms] ease-out motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
      </button>
      <Expandable open={open} data-slot="background-task-body">
        <div className="space-y-2 border-t border-line p-3 font-mono text-[11px] text-muted">
          <p className="text-faint">只读观察：Desktop 不直接控制后台任务或 Cron。</p>
          {outputPath ? <p>输出路径：{outputPath}</p> : null}
          {toolCall.output ? (
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-r1 bg-surface px-2 py-1.5 text-[10.5px]">
              {toolCall.output}
            </pre>
          ) : (
            <p className="text-faint">（等待 Agent 返回快照或完成通知）</p>
          )}
        </div>
      </Expandable>
    </div>
  );
}
