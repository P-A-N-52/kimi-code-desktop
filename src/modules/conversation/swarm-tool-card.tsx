import { Check, ChevronRight, Layers, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { LiveMessage } from "@/hooks/types";
import { useAgentMonitorStore } from "@/lib/agent-monitor/store";
import {
  formatAgentModelDisplay,
  resolveAgentModelDisplay,
} from "@/lib/agent-model-display";
import { parseSwarmResult } from "@/lib/swarm/parseSwarmResult";
import {
  buildSwarmCardRows,
  resolveSwarmMembers,
  type SwarmCardRow,
  type SwarmMember,
  type SwarmPhase,
  statusToDotKind,
} from "@/lib/swarm/swarmCardRows";
import { cn } from "@/lib/utils";
import { Expandable } from "@/ui/expandable";
import { StatusDot } from "@/ui/status-dot";

type ToolCall = NonNullable<LiveMessage["toolCall"]>;

const PHASE_ORDER: readonly { phase: SwarmPhase; barClass: string; legendClass: string }[] = [
  { phase: "completed", barClass: "bg-success", legendClass: "bg-success" },
  { phase: "working", barClass: "bg-foreground/55", legendClass: "bg-foreground/55" },
  { phase: "suspended", barClass: "bg-warn", legendClass: "bg-warn" },
  { phase: "failed", barClass: "bg-danger", legendClass: "bg-danger" },
  { phase: "queued", barClass: "bg-line-strong", legendClass: "bg-line-strong" },
];

const PHASE_LABEL: Record<SwarmPhase, string> = {
  completed: "已完成",
  working: "运行中",
  suspended: "已暂停",
  failed: "失败",
  queued: "排队中",
};

function parseSwarmInput(input: unknown): { description?: string; itemCount?: number } {
  if (typeof input !== "object" || input === null) return {};
  const r = input as Record<string, unknown>;
  const items = Array.isArray(r.items) ? r.items : undefined;
  return {
    description: typeof r.description === "string" ? r.description : undefined,
    itemCount: items?.length,
  };
}

function isToolRunning(state: ToolCall["state"]): boolean {
  return state === "input-streaming" || state === "input-available";
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

function MemberRow({ row, member }: { row: SwarmCardRow; member?: SwarmMember }) {
  const live = row.phase === "working" || row.phase === "suspended" || row.phase === "queued";
  const [open, setOpen] = useState(live && Boolean(row.activity || row.body));
  const modelDisplay = member
    ? resolveAgentModelDisplay({
        boundModel: member.boundModel,
        modelPreference: member.modelPreference,
      })
    : null;
  return (
    <div
      data-slot="swarm-member-row"
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
        <span className="max-w-[46%] truncate font-medium text-foreground">{row.name}</span>
        {modelDisplay ? (
          <span
            data-slot="swarm-member-model"
            className="shrink-0 truncate font-mono text-[10px] text-faint"
          >
            {formatAgentModelDisplay(modelDisplay)}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted">
          {row.activity}
        </span>
        <span className={cn("shrink-0 font-mono text-[10.5px]", phaseTextClass(row.phase))}>
          {PHASE_LABEL[row.phase]}
        </span>
        <ChevronRight
          size={11}
          strokeWidth={1.5}
          className={cn(
            "shrink-0 text-faint transition-transform duration-[160ms] ease-out motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
      </button>
      <Expandable open={open}>
        <div className="whitespace-pre-wrap break-words px-2.5 pb-2.5 pl-[31px] font-mono text-[10.5px] leading-relaxed text-muted">
          {row.body || row.activity || "（无输出）"}
        </div>
      </Expandable>
    </div>
  );
}

export function SwarmToolCard({ toolCall }: { toolCall: ToolCall }) {
  const tasks = useAgentMonitorStore((state) => state.tasks);
  const input = useMemo(() => parseSwarmInput(toolCall.input), [toolCall.input]);
  const result = useMemo(() => parseSwarmResult(toolCall.output), [toolCall.output]);
  const members = useMemo(
    () => resolveSwarmMembers(tasks, toolCall.toolCallId),
    [tasks, toolCall.toolCallId],
  );
  const rows = useMemo(() => buildSwarmCardRows(members, result), [members, result]);
  const memberById = useMemo(
    () => new Map(members.map((member) => [member.id, member])),
    [members],
  );

  const running = isToolRunning(toolCall.state);
  const denied = toolCall.state === "output-denied";
  const counts = useMemo(() => {
    const c: Record<SwarmPhase, number> = {
      completed: 0,
      working: 0,
      suspended: 0,
      queued: 0,
      failed: 0,
    };
    for (const row of rows) c[row.phase] += 1;
    return c;
  }, [rows]);

  const total = rows.length || input.itemCount || 0;
  const done = counts.completed + counts.failed;
  const inProgress = counts.working + counts.suspended + counts.queued;
  // ToolResult can arrive before TaskCreated members are linked. Do not treat an
  // empty swarm as "all done" — that flashes a checkmark at spawn time.
  const settled =
    !running &&
    inProgress === 0 &&
    (result != null || (rows.length > 0 && done === rows.length));
  const aggregateError =
    !running &&
    (denied ||
      Boolean(toolCall.isError) ||
      (settled && ((result?.failed ?? 0) > 0 || (result?.aborted ?? 0) > 0)));
  const aggregateOk = settled && !aggregateError && !denied;
  const waitingForMembers = !running && !settled && !denied && !toolCall.isError;

  const [open, setOpen] = useState(running || inProgress > 0 || denied || waitingForMembers);

  const segments = PHASE_ORDER.map(({ phase, barClass, legendClass }) => ({
    phase,
    count: counts[phase],
    barClass,
    legendClass,
  })).filter((s) => s.count > 0);

  const denialText =
    denied || toolCall.isError
      ? (toolCall.errorText ?? (Array.isArray(toolCall.output) ? toolCall.output.join("\n") : toolCall.output) ?? "")
          .toString()
          .trim()
      : "";

  const fallbackOutput =
    rows.length === 0 && !result && !running && !denied
      ? (toolCall.output ?? "").trim()
      : "";

  return (
    <div
      data-slot="swarm-tool-card"
      className={cn(
        "my-2.5 overflow-hidden rounded-r2 border border-line bg-elevated",
        aggregateError && "border-danger/30",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full min-h-8 items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-hover",
          aggregateError && "bg-danger-bg/40",
        )}
      >
        <Layers size={13} strokeWidth={1.5} className="shrink-0 text-muted" />
        <span className="shrink-0 font-mono text-[12px] font-semibold text-foreground">Swarm</span>
        {input.description ? (
          <>
            <span className="shrink-0 text-faint">·</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">
              {input.description}
            </span>
          </>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        <span className="shrink-0 font-mono text-[11px] text-muted">
          {done} / {total}
        </span>
        <span className="inline-flex shrink-0 items-center">
          {running || inProgress > 0 || waitingForMembers ? (
            <StatusDot status="running" />
          ) : aggregateError ? (
            <X size={12} strokeWidth={1.75} className="text-danger" />
          ) : aggregateOk ? (
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

      <Expandable open={open} data-slot="swarm-body">
        <div className="border-t border-line bg-secondary/40">
          <div className="border-b border-line/70 px-2.5 pb-2 pt-2">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[15px] font-medium text-foreground">
                {done} / {total}
              </span>
              <span className="font-mono text-[10.5px] text-muted">
                {denied
                  ? "已拒绝 / 未执行"
                  : running || inProgress > 0 || waitingForMembers
                    ? inProgress > 0
                      ? `${inProgress} 个进行中`
                      : "进行中"
                    : result
                      ? `完成 ${result.completed}，失败 ${result.failed + result.aborted}`
                      : rows.length === 0
                        ? "等待子代理启动…"
                        : "已完成"}
              </span>
            </div>
            {segments.length > 0 ? (
              <>
                <div className="mt-2 flex h-[5px] gap-0.5 overflow-hidden rounded-full">
                  {segments.map((s) => (
                    <span
                      key={s.phase}
                      className={cn("h-full min-w-[3px] rounded-full", s.barClass)}
                      style={{ flex: s.count }}
                    />
                  ))}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-1">
                  {segments.map((s) => (
                    <span
                      key={`lg-${s.phase}`}
                      className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-muted"
                    >
                      <span className={cn("size-1.5 rounded-full", s.legendClass)} />
                      {PHASE_LABEL[s.phase]} {s.count}
                    </span>
                  ))}
                </div>
              </>
            ) : null}
          </div>

          {rows.length > 0 ? (
            <div>
              {rows.map((row) => (
                <MemberRow key={row.id} row={row} member={memberById.get(row.id)} />
              ))}
            </div>
          ) : denialText ? (
            <pre className="whitespace-pre-wrap break-words px-2.5 py-2.5 font-mono text-[11px] leading-relaxed text-danger">
              {denialText}
            </pre>
          ) : fallbackOutput ? (
            <pre className="whitespace-pre-wrap break-words px-2.5 py-2.5 font-mono text-[11px] leading-relaxed text-foreground">
              {fallbackOutput}
            </pre>
          ) : (
            <p className="px-2.5 py-2.5 font-mono text-[11px] text-muted">等待子代理启动…</p>
          )}
        </div>
      </Expandable>
    </div>
  );
}
