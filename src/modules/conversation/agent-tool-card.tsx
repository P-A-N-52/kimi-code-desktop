import { Check, ChevronRight, Sparkles, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { LiveMessage } from "@/hooks/types";
import { parseAgentInput, parseAgentResult } from "@/lib/agent/parseAgentResult";
import { cn } from "@/lib/utils";
import { Expandable } from "@/ui/expandable";
import { StatusDot } from "@/ui/status-dot";
import { Attachments } from "./attachments";
import { SubagentSteps } from "./subagent-steps";
import { TermView } from "./term-view";
import { ToolDisplayContent } from "./tool-display-content";

type ToolCall = NonNullable<LiveMessage["toolCall"]>;

const STATUS_LABEL: Record<string, string> = {
  completed: "已完成",
  success: "已完成",
  ok: "已完成",
  done: "已完成",
  failed: "失败",
  error: "失败",
  cancelled: "已取消",
  canceled: "已取消",
  aborted: "已中止",
  running: "运行中",
  working: "运行中",
  in_progress: "运行中",
  queued: "排队中",
  suspended: "已暂停",
};

function isToolRunning(state: ToolCall["state"]): boolean {
  return state === "input-streaming" || state === "input-available";
}

function statusLabel(status?: string): string {
  if (!status) return "";
  return STATUS_LABEL[status.toLowerCase()] ?? status;
}

function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function AgentToolCard({
  toolCall,
  defaultOpen,
}: {
  toolCall: ToolCall;
  defaultOpen?: boolean;
}) {
  const input = useMemo(() => parseAgentInput(toolCall.input), [toolCall.input]);
  const result = useMemo(() => parseAgentResult(toolCall.output), [toolCall.output]);

  const running =
    isToolRunning(toolCall.state) || toolCall.subagentRunning === true;
  const hasSubagentActivity =
    Boolean(toolCall.subagentSteps?.length) || toolCall.subagentRunning === true;

  const agentType =
    result.subagentType ?? toolCall.subagentType ?? input.subagentType;
  const agentId = result.agentId ?? toolCall.subagentAgentId;
  const resolvedStatus = running
    ? "running"
    : toolCall.isError
      ? (result.status ?? "failed")
      : (result.status ?? (toolCall.state === "output-available" ? "completed" : undefined));
  const description = input.description?.trim() || "";
  const headerSummary = description || (agentType ? agentType : "");

  const [open, setOpen] = useState(
    defaultOpen ?? (running || hasSubagentActivity),
  );

  const showStructured = result.structured;
  const showDisplay = Boolean(toolCall.display?.length);
  const showRawFallback =
    !showStructured && !showDisplay && Boolean(toolCall.output?.trim());

  return (
    <div
      data-slot="agent-tool-card"
      className={cn(
        "my-2.5 overflow-hidden rounded-r2 border border-line bg-elevated",
        toolCall.isError && "border-danger/30",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full min-h-8 items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-hover",
          toolCall.isError && "bg-danger-bg/40",
        )}
      >
        <Sparkles size={13} strokeWidth={1.5} className="shrink-0 text-muted" />
        <span className="shrink-0 font-mono text-[12px] font-semibold text-foreground">
          Agent
        </span>
        {headerSummary ? (
          <>
            <span className="shrink-0 text-faint">·</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">
              {truncate(headerSummary)}
            </span>
          </>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        <span className="inline-flex shrink-0 items-center">
          {running ? (
            <StatusDot status="running" />
          ) : toolCall.isError || resolvedStatus === "failed" || resolvedStatus === "error" ? (
            <X size={12} strokeWidth={1.75} className="text-danger" />
          ) : toolCall.state === "output-available" || resolvedStatus === "completed" ? (
            <Check size={12} strokeWidth={1.75} className="text-success" />
          ) : (
            <StatusDot status="idle" />
          )}
        </span>
        <ChevronRight
          size={12}
          strokeWidth={1.5}
          className={cn(
            "shrink-0 text-faint transition-transform duration-[160ms] ease-out motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
      </button>

      <Expandable open={open} data-slot="agent-body">
        <div className="border-t border-line bg-secondary/40">
          {toolCall.isError && toolCall.errorText ? (
            <div className="border-b border-line/70 px-2.5 py-2.5 font-mono text-[11.5px] text-danger">
              {toolCall.errorText}
            </div>
          ) : null}

          <div className="space-y-2.5 px-2.5 py-2.5">
            {(agentType || resolvedStatus || agentId) && (
              <div className="flex flex-wrap items-center gap-1.5">
                {agentType ? (
                  <span
                    data-slot="agent-type-chip"
                    className="inline-flex items-center rounded-r1 border border-line bg-background px-1.5 py-0.5 font-mono text-[10.5px] text-muted"
                  >
                    {agentType}
                  </span>
                ) : null}
                {resolvedStatus ? (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-muted">
                    <StatusDot
                      status={
                        running
                          ? "running"
                          : toolCall.isError ||
                              resolvedStatus === "failed" ||
                              resolvedStatus === "error"
                            ? "error"
                            : "ok"
                      }
                    />
                    {statusLabel(resolvedStatus)}
                  </span>
                ) : null}
                {agentId ? (
                  <span className="font-mono text-[10.5px] text-faint">{agentId}</span>
                ) : null}
              </div>
            )}

            {input.prompt ? (
              <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground">
                {input.prompt}
              </p>
            ) : null}

            {showStructured && result.summary ? (
              <div
                data-slot="agent-summary"
                className="whitespace-pre-wrap break-words rounded-r1 border border-line bg-background px-2.5 py-2 text-[12px] leading-relaxed text-foreground"
              >
                {result.summary}
              </div>
            ) : null}

            {showDisplay ? <ToolDisplayContent display={toolCall.display!} /> : null}

            {showRawFallback ? <TermView output={toolCall.output!} /> : null}

            {!showStructured &&
            !showDisplay &&
            !showRawFallback &&
            !input.prompt &&
            !toolCall.mediaParts?.length &&
            !hasSubagentActivity ? (
              <p className="font-mono text-[11px] text-muted">
                {running ? "子代理运行中…" : "（无输出）"}
              </p>
            ) : null}
          </div>

          {toolCall.mediaParts?.length ? (
            <div className="border-t border-line p-3">
              <Attachments
                parts={toolCall.mediaParts.map((part) => ({
                  type: "file" as const,
                  mediaType: part.type === "image_url" ? "image/*" : "video/*",
                  filename: (() => {
                    try {
                      return new URL(part.url).pathname.split("/").pop() || "media";
                    } catch {
                      return "media";
                    }
                  })(),
                  url: part.url,
                }))}
              />
            </div>
          ) : null}

          <SubagentSteps
            steps={toolCall.subagentSteps}
            running={toolCall.subagentRunning}
            agentType={agentType}
          />
        </div>
      </Expandable>
    </div>
  );
}
