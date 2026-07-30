import { Bot, Check, ChevronRight, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { LiveMessage, SubagentStep } from "@/hooks/types";
import { parseAgentInput, parseAgentResult } from "@/lib/agent/parseAgentResult";
import {
  getSwarmMembers,
  isActiveAgentStatus,
  useAgentMonitorStore,
  type AgentTask,
} from "@/lib/agent-monitor/store";
import {
  phaseForAgentTask,
  statusToDotKind,
  type SwarmPhase,
} from "@/lib/swarm/swarmCardRows";
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
  pending: "排队中",
  spawned: "排队中",
  suspended: "已暂停",
  paused: "已暂停",
  waiting: "等待中",
};

const PHASE_LABEL: Record<SwarmPhase, string> = {
  completed: "已完成",
  working: "运行中",
  suspended: "已暂停",
  failed: "失败",
  queued: "排队中",
};

type SubagentProgressRow = {
  id: string;
  name: string;
  agentType?: string;
  phase: SwarmPhase;
  activity: string;
  steps?: SubagentStep[];
  stepsRunning?: boolean;
};

function isToolRunning(state: ToolCall["state"]): boolean {
  return state === "input-streaming" || state === "input-available";
}

/** Result/meta statuses that mean the agent is still in flight — never treat as done. */
function isActiveResultStatus(status?: string): boolean {
  if (!status) return false;
  switch (status.trim().toLowerCase()) {
    case "running":
    case "working":
    case "in_progress":
    case "in-progress":
    case "queued":
    case "pending":
    case "started":
    case "spawned":
    case "suspended":
    case "paused":
    case "waiting":
      return true;
    default:
      return false;
  }
}

function isFailedResultStatus(status?: string): boolean {
  if (!status) return false;
  switch (status.trim().toLowerCase()) {
    case "failed":
    case "error":
    case "cancelled":
    case "canceled":
    case "aborted":
      return true;
    default:
      return false;
  }
}

function extrasInProgress(extras?: Record<string, unknown>): boolean {
  return extras?.in_progress === true;
}

function statusLabel(status?: string): string {
  if (!status) return "";
  return STATUS_LABEL[status.toLowerCase()] ?? status;
}

function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function phaseTextClass(phase: SwarmPhase): string {
  switch (phase) {
    case "completed":
      return "text-success";
    case "failed":
      return "text-danger";
    case "working":
      return "text-foreground";
    case "suspended":
      return "text-warn";
    default:
      return "text-faint";
  }
}

function phaseFromCardState(args: {
  running: boolean;
  failed: boolean;
  completed: boolean;
}): SwarmPhase {
  if (args.running) return "working";
  if (args.failed) return "failed";
  if (args.completed) return "completed";
  return "queued";
}

function resolveChildTasks(
  tasks: AgentTask[],
  toolCallId?: string,
  agentId?: string,
): AgentTask[] {
  if (toolCallId) {
    const byParent = getSwarmMembers(tasks, toolCallId);
    if (byParent.length > 0) return byParent;
  }
  if (agentId) {
    const byId = tasks.find((task) => task.id === agentId);
    if (byId) return [byId];
  }
  return [];
}

function taskActivity(task: AgentTask): string {
  return task.suspendedReason || task.currentStep || task.outputPreview || "";
}

function buildProgressRows(args: {
  childTasks: AgentTask[];
  toolCall: ToolCall;
  agentType?: string;
  agentId?: string;
  description: string;
  running: boolean;
  failed: boolean;
  completed: boolean;
  resultSummary?: string;
  progressHint?: string;
}): SubagentProgressRow[] {
  const {
    childTasks,
    toolCall,
    agentType,
    agentId,
    description,
    running,
    failed,
    completed,
    resultSummary,
    progressHint,
  } = args;

  const steps = toolCall.subagentSteps;
  const stepsRunning = Boolean(running && (toolCall.subagentRunning || steps?.length));

  if (childTasks.length > 0) {
    return childTasks.map((task) => {
      const matchSteps =
        childTasks.length === 1 ||
        (agentId != null && task.id === agentId) ||
        (toolCall.subagentAgentId != null && task.id === toolCall.subagentAgentId);
      const phase = phaseForAgentTask(task);
      const live =
        isActiveAgentStatus(task.status) || (matchSteps && stepsRunning);
      return {
        id: task.id,
        name: task.description || task.agentType || task.kind || task.id,
        agentType: task.agentType || agentType,
        phase: live && phase === "completed" ? "working" : phase,
        activity:
          (live ? taskActivity(task) : task.outputPreview || taskActivity(task)) ||
          (matchSteps ? progressHint : undefined) ||
          (!live ? resultSummary : undefined) ||
          "",
        steps: matchSteps ? steps : undefined,
        stepsRunning: matchSteps ? stepsRunning || isActiveAgentStatus(task.status) : false,
      };
    });
  }

  const hasSignal =
    Boolean(steps?.length) ||
    toolCall.subagentRunning === true ||
    Boolean(agentType) ||
    Boolean(agentId) ||
    running ||
    completed ||
    failed;

  if (!hasSignal) return [];

  return [
    {
      id: agentId ?? toolCall.toolCallId ?? "subagent",
      name: description || agentType || "子代理",
      agentType,
      phase: phaseFromCardState({ running, failed, completed }),
      // Keep summary in the structured body above; progress row shows live activity / steps.
      activity: running ? progressHint || "" : "",
      steps,
      stepsRunning,
    },
  ];
}

function SubagentProgressRowView({
  row,
  defaultOpen,
}: {
  row: SubagentProgressRow;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasDetail = Boolean(row.activity || row.steps?.length || row.stepsRunning);

  return (
    <div
      data-slot="agent-subagent-row"
      data-phase={row.phase}
      className={cn("border-b border-line/70 last:border-b-0", open && "bg-background/60")}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-h-8 items-center gap-2 px-2.5 text-left text-[12px] hover:bg-hover"
      >
        <StatusDot status={statusToDotKind(row.phase)} className="shrink-0" />
        {row.agentType ? (
          <span className="shrink-0 font-mono text-[10.5px] text-faint">{row.agentType}</span>
        ) : null}
        <span className="max-w-[42%] truncate font-medium text-foreground">{row.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted">
          {row.activity}
        </span>
        <span className={cn("shrink-0 font-mono text-[10.5px]", phaseTextClass(row.phase))}>
          {PHASE_LABEL[row.phase]}
        </span>
        {hasDetail ? (
          <ChevronRight
            size={11}
            strokeWidth={1.5}
            className={cn(
              "shrink-0 text-faint transition-transform duration-[160ms] ease-out motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
        ) : null}
      </button>
      {hasDetail ? (
        <Expandable open={open}>
          <div className="space-y-1.5 px-2.5 pb-2.5 pl-[31px]">
            {row.activity ? (
              <p className="whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-muted">
                {row.activity}
              </p>
            ) : null}
            <SubagentSteps
              steps={row.steps}
              running={row.stepsRunning}
              agentType={row.agentType}
              defaultOpen={
                row.stepsRunning ||
                row.phase === "working" ||
                Boolean(row.steps?.length)
              }
              compact
            />
          </div>
        </Expandable>
      ) : null}
    </div>
  );
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
  const agentType =
    result.subagentType ?? toolCall.subagentType ?? input.subagentType;
  const agentId = result.agentId ?? toolCall.subagentAgentId;

  // Parent Agent tool can reach output-available while the monitor task is still
  // queued/running (spawn ack / in_progress update). Keep the card live then.
  // Select the stable tasks array — never return a fresh filtered array from the
  // store selector (that breaks getSnapshot and infinite-loops React).
  const monitorTasks = useAgentMonitorStore((state) => state.tasks);
  const childTasks = useMemo(
    () => resolveChildTasks(monitorTasks, toolCall.toolCallId, agentId),
    [monitorTasks, toolCall.toolCallId, agentId],
  );
  const monitorStillActive = childTasks.some((task) => isActiveAgentStatus(task.status));

  const running =
    isToolRunning(toolCall.state) ||
    toolCall.subagentRunning === true ||
    extrasInProgress(toolCall.extras) ||
    isActiveResultStatus(result.status) ||
    monitorStillActive;
  const hasSubagentActivity =
    Boolean(toolCall.subagentSteps?.length) ||
    toolCall.subagentRunning === true ||
    monitorStillActive ||
    childTasks.length > 0;

  const failed =
    !running && (Boolean(toolCall.isError) || isFailedResultStatus(result.status));
  const completed = !running && !failed && toolCall.state === "output-available";

  const resolvedStatus = running
    ? isActiveResultStatus(result.status)
      ? result.status
      : monitorStillActive
        ? (childTasks.find((task) => isActiveAgentStatus(task.status))?.status ?? "running")
        : "running"
    : toolCall.isError
      ? (result.status ?? "failed")
      : (result.status ?? (toolCall.state === "output-available" ? "completed" : undefined));

  const description = input.description?.trim() || "";
  const headerSummary = description || (agentType ? agentType : "");
  const activeChild = childTasks.find((task) => isActiveAgentStatus(task.status));
  const progressHint =
    (running &&
      (activeChild?.currentStep ||
        activeChild?.outputPreview ||
        childTasks[0]?.currentStep ||
        (toolCall.subagentRunning ? "子代理运行中…" : "派发中…"))) ||
    (!running && result.summary) ||
    undefined;

  const progressRows = useMemo(
    () =>
      buildProgressRows({
        childTasks,
        toolCall,
        agentType,
        agentId,
        description,
        running,
        failed,
        completed,
        resultSummary: result.summary,
        progressHint,
      }),
    [
      childTasks,
      toolCall,
      agentType,
      agentId,
      description,
      running,
      failed,
      completed,
      result.summary,
      progressHint,
    ],
  );

  const settledCount = progressRows.filter(
    (row) => row.phase === "completed" || row.phase === "failed",
  ).length;
  const multi = progressRows.length > 1;

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
      data-agent-status={running ? "running" : failed ? "failed" : completed ? "completed" : "idle"}
      className={cn(
        "my-2.5 overflow-hidden rounded-r2 border border-line border-l-[3px] bg-elevated",
        running && "border-l-foreground/50",
        failed && "border-danger/30 border-l-danger",
        completed && "border-l-success/70",
        !running && !failed && !completed && "border-l-line-strong",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full min-h-9 items-center gap-2 px-2.5 py-2 text-left text-[12px] transition-colors hover:bg-hover",
          failed && "bg-danger-bg/40",
        )}
      >
        <Bot size={14} strokeWidth={1.5} className="shrink-0 text-muted" />
        <span className="shrink-0 font-mono text-[12px] font-semibold text-foreground">
          Agent
        </span>
        <span
          data-slot="agent-badge"
          className="shrink-0 rounded border border-line px-1.5 py-px font-mono text-[9.5px] tracking-[0.08em] text-muted"
        >
          AGENT
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
        {multi ? (
          <span
            data-slot="agent-progress-count"
            className="shrink-0 font-mono text-[11px] text-muted"
          >
            {settledCount}/{progressRows.length}
          </span>
        ) : null}
        {resolvedStatus ? (
          <span
            data-slot="agent-status-label"
            className={cn(
              "shrink-0 font-mono text-[10.5px]",
              running && "text-muted",
              failed && "text-danger",
              completed && "text-success",
              !running && !failed && !completed && "text-faint",
            )}
          >
            {statusLabel(resolvedStatus)}
          </span>
        ) : null}
        <span data-slot="agent-status-icon" className="inline-flex shrink-0 items-center">
          {running ? (
            <StatusDot status="running" />
          ) : failed ? (
            <X size={12} strokeWidth={1.75} className="text-danger" />
          ) : completed ? (
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
                          : failed
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

            {progressHint &&
            !(showStructured && result.summary === progressHint) &&
            progressRows.length === 0 ? (
              <p
                data-slot="agent-progress"
                className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted"
              >
                {truncate(progressHint, 200)}
              </p>
            ) : null}

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
            !progressHint &&
            !toolCall.mediaParts?.length &&
            !hasSubagentActivity &&
            progressRows.length === 0 ? (
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

          {progressRows.length > 0 ? (
            <div data-slot="agent-subagent-progress" className="border-t border-line">
              <div className="flex items-center gap-2 px-2.5 py-1.5 font-mono text-[10.5px] text-muted">
                <span>子代理进度</span>
                {multi ? (
                  <span className="text-faint">
                    {settledCount}/{progressRows.length} 已结束
                  </span>
                ) : (
                  <span className="text-faint">{PHASE_LABEL[progressRows[0]!.phase]}</span>
                )}
              </div>
              <div>
                {progressRows.map((row) => (
                  <SubagentProgressRowView
                    key={row.id}
                    row={row}
                    defaultOpen={
                      row.phase === "working" ||
                      row.phase === "suspended" ||
                      Boolean(row.stepsRunning) ||
                      Boolean(row.steps?.length)
                    }
                  />
                ))}
              </div>
            </div>
          ) : (
            <SubagentSteps
              steps={toolCall.subagentSteps}
              running={running && (toolCall.subagentRunning || hasSubagentActivity)}
              agentType={agentType}
            />
          )}
        </div>
      </Expandable>
    </div>
  );
}
