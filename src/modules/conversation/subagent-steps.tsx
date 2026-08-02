import { Check, ChevronRight, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { SubagentStep } from "@/hooks/types";
import { cn } from "@/lib/utils";
import { Expandable } from "@/ui/expandable";
import { StatusDot } from "@/ui/status-dot";

function titleCase(value?: string): string {
  if (!value) return "子代理";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)} 代理`;
}

function latestStepPreview(steps?: SubagentStep[]): string {
  if (!steps?.length) return "";
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.kind === "tool-call") {
      const verb =
        step.status === "success" ? "完成" : step.status === "error" ? "失败" : "调用";
      return `${verb} ${step.toolName}`;
    }
    if (step.kind === "subagent") {
      const nested = latestStepPreview(step.steps);
      if (nested) return `${titleCase(step.agentType)} · ${nested}`;
    }
    if (step.kind === "text" || step.kind === "thinking") {
      const text = step.text.trim();
      if (text) return text.length > 72 ? `${text.slice(0, 72)}…` : text;
    }
  }
  return "";
}

function Step({ step }: { step: SubagentStep }) {
  if (step.kind === "thinking") {
    return <div className="line-clamp-3 italic text-faint">{step.text}</div>;
  }
  if (step.kind === "text") {
    return <div className="line-clamp-4 text-muted">{step.text}</div>;
  }
  if (step.kind === "subagent") {
    const done = step.status === "success" || step.status === "error";
    return (
      <div className="rounded-r1 border border-line/70 bg-elevated/50 px-2 py-1.5">
        <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-foreground">
          <StatusDot status={done ? (step.status === "error" ? "error" : "ok") : "running"} />
          <span>{titleCase(step.agentType)}</span>
          <span className="ml-auto text-faint">
            {step.status === "success"
              ? "完成"
              : step.status === "error"
                ? "失败"
                : step.status === "cancelled"
                  ? "已取消"
                  : "运行中"}
          </span>
        </div>
        {step.steps.length > 0 && (
          <SubagentSteps steps={step.steps} running={!done} agentType={step.agentType} compact />
        )}
      </div>
    );
  }
  return (
    <div className="rounded-r1 border border-line bg-background px-2 py-1.5">
      <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-foreground">
        {step.status === "success" ? (
          <Check size={11} strokeWidth={1.5} className="text-success" />
        ) : step.status === "error" ? (
          <X size={11} strokeWidth={1.5} className="text-danger" />
        ) : (
          <StatusDot status="running" />
        )}
        <span>{step.toolName}</span>
        <span className="ml-auto text-faint">
          {step.status === "success" ? "完成" : step.status === "error" ? "失败" : "运行中"}
        </span>
      </div>
      {step.errorText || step.output ? (
        <pre
          className={cn(
            "mt-1 max-h-36 overflow-auto whitespace-pre-wrap font-mono text-[10.5px]",
            step.errorText ? "text-danger" : "text-faint",
          )}
        >
          {step.errorText ?? step.output}
        </pre>
      ) : null}
    </div>
  );
}

export function SubagentSteps({
  steps,
  running,
  agentType,
  defaultOpen,
  compact,
}: {
  steps?: SubagentStep[];
  running?: boolean;
  agentType?: string;
  /** Override initial expand; defaults to open while running. */
  defaultOpen?: boolean;
  /** Hide the outer chrome when nested inside a progress row. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? Boolean(running));
  const toolCount = useMemo(
    () => steps?.filter((step) => step.kind === "tool-call").length ?? 0,
    [steps],
  );
  const doneTools = useMemo(
    () =>
      steps?.filter(
        (step) => step.kind === "tool-call" && (step.status === "success" || step.status === "error"),
      ).length ?? 0,
    [steps],
  );
  const preview = useMemo(() => latestStepPreview(steps), [steps]);

  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

  if (!steps?.length && !running) return null;

  const label = compact
    ? `步骤${toolCount ? ` · ${doneTools}/${toolCount}` : ""}${running ? " · 进行中" : ""}`
    : `${titleCase(agentType)} ${running ? "工作中" : "已完成"}${
        toolCount ? ` · ${doneTools}/${toolCount} 工具调用` : ""
      }`;

  return (
    <div
      data-slot="subagent-steps"
      className={cn(compact ? "pt-1.5" : "border-t border-line p-3")}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 text-left font-mono text-[10.5px] text-muted"
      >
        <StatusDot status={running ? "running" : "ok"} />
        <span className="min-w-0 flex-1 truncate">
          {label}
          {!open && preview ? <span className="text-faint"> · {preview}</span> : null}
        </span>
        <ChevronRight
          size={11}
          strokeWidth={1.5}
          className={cn(
            "shrink-0 transition-transform duration-[160ms] ease-out motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
      </button>
      <Expandable open={open}>
        <div className="mt-2 space-y-1.5 border-l border-line pl-3 text-[11px] leading-relaxed">
          {steps?.length ? (
            steps.map((step, index) => <Step key={`${step.kind}-${index}`} step={step} />)
          ) : (
            <div className="font-mono text-[10.5px] text-faint">等待子代理步骤…</div>
          )}
        </div>
      </Expandable>
    </div>
  );
}
