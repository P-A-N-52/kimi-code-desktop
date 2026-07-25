import { Check, ChevronRight, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { SubagentStep } from "@/hooks/types";
import { cn } from "@/lib/utils";
import { Expandable } from "@/ui/expandable";
import { StatusDot } from "@/ui/status-dot";

function titleCase(value?: string): string {
  if (!value) return "Agent";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)} agent`;
}

function Step({ step }: { step: SubagentStep }) {
  if (step.kind === "thinking") {
    return <div className="line-clamp-3 italic text-faint">{step.text}</div>;
  }
  if (step.kind === "text") {
    return <div className="line-clamp-4 text-muted">{step.text}</div>;
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
}: {
  steps?: SubagentStep[];
  running?: boolean;
  agentType?: string;
}) {
  const [open, setOpen] = useState(Boolean(running));
  const toolCount = useMemo(
    () => steps?.filter((step) => step.kind === "tool-call").length ?? 0,
    [steps],
  );
  if (!steps?.length && !running) return null;
  const label = `${titleCase(agentType)} ${running ? "working" : "completed"}${toolCount ? ` · ${toolCount} tool call${toolCount === 1 ? "" : "s"}` : ""}`;

  return (
    <div data-slot="subagent-steps" className="border-t border-line p-3">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 text-left font-mono text-[10.5px] text-muted"
      >
        <StatusDot status={running ? "running" : "ok"} />
        <span>{label}</span>
        <ChevronRight
          size={11}
          strokeWidth={1.5}
          className={cn(
            "ml-auto transition-transform duration-[160ms] ease-out motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
      </button>
      <Expandable open={open}>
        <div className="mt-2 space-y-1.5 border-l border-line pl-3 text-[11px] leading-relaxed">
          {steps?.map((step, index) => (
            <Step key={`${step.kind}-${index}`} step={step} />
          ))}
        </div>
      </Expandable>
    </div>
  );
}
