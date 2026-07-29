import { Goal, LoaderCircle, Pause, Play, X } from "lucide-react";
import { useState } from "react";
import type { GoalItem } from "@/lib/goal";

const STATUS_LABELS: Record<GoalItem["status"], string> = {
  active: "运行中",
  paused: "已暂停",
  blocked: "已阻塞",
  complete: "已完成",
};

export function GoalCard({
  goal,
  onControl,
}: {
  goal: GoalItem;
  onControl?: (action: "pause" | "resume" | "cancel") => Promise<unknown>;
}) {
  const [pending, setPending] = useState<"pause" | "resume" | "cancel" | null>(null);
  const run = (action: "pause" | "resume" | "cancel") => {
    if (!onControl || pending) return;
    setPending(action);
    void onControl(action).finally(() => setPending(null));
  };

  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
        <Goal size={12} /> 当前目标
      </h3>
      <div className="rounded-r2 border border-line bg-elevated p-2.5">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-foreground">
            {goal.objective}
          </p>
          <span className="shrink-0 rounded-r1 bg-hover px-1.5 py-0.5 font-mono text-[9px] text-muted">
            {STATUS_LABELS[goal.status]}
          </span>
        </div>
        {goal.completionCriterion && (
          <p className="mt-1.5 text-[10px] leading-relaxed text-muted">
            完成条件：{goal.completionCriterion}
          </p>
        )}
        {goal.terminalReason && (
          <p className="mt-1.5 text-[10px] leading-relaxed text-warning">{goal.terminalReason}</p>
        )}
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[9.5px] text-faint">
          <span>
            turn {goal.turnsUsed}
            {goal.budget.turnBudget === undefined ? "" : `/${goal.budget.turnBudget}`}
          </span>
          <span>
            token {goal.tokensUsed.toLocaleString()}
            {goal.budget.tokenBudget === undefined
              ? ""
              : `/${goal.budget.tokenBudget.toLocaleString()}`}
          </span>
          {goal.wallClockMs > 0 && <span>{Math.round(goal.wallClockMs / 1000)}s</span>}
        </div>
        {onControl && goal.status !== "complete" && (
          <div className="mt-2.5 flex gap-1.5 border-t border-line pt-2">
            {goal.status === "active" ? (
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => run("pause")}
                className="flex items-center gap-1 rounded-r1 px-2 py-1 text-[10px] text-muted hover:bg-hover hover:text-foreground disabled:opacity-50"
              >
                {pending === "pause" ? (
                  <LoaderCircle size={11} className="animate-spin" />
                ) : (
                  <Pause size={11} />
                )}
                暂停
              </button>
            ) : goal.status === "paused" || goal.status === "blocked" ? (
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => run("resume")}
                className="flex items-center gap-1 rounded-r1 px-2 py-1 text-[10px] text-muted hover:bg-hover hover:text-foreground disabled:opacity-50"
              >
                {pending === "resume" ? (
                  <LoaderCircle size={11} className="animate-spin" />
                ) : (
                  <Play size={11} />
                )}
                恢复
              </button>
            ) : null}
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => run("cancel")}
              className="ml-auto flex items-center gap-1 rounded-r1 px-2 py-1 text-[10px] text-danger hover:bg-danger/10 disabled:opacity-50"
            >
              {pending === "cancel" ? (
                <LoaderCircle size={11} className="animate-spin" />
              ) : (
                <X size={11} />
              )}
              取消
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
