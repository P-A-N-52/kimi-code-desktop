import { ArrowDown, ArrowUp, LoaderCircle, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog";

export type GoalQueueItem = {
  id: string;
  objective: string;
  createdAt: string;
  updatedAt: string;
};

export function GoalQueueManager({
  open,
  goals,
  pendingGoalId,
  onOpenChange,
  onMove,
  onDelete,
  onEdit,
}: {
  open: boolean;
  goals: GoalQueueItem[];
  pendingGoalId?: string;
  onOpenChange: (open: boolean) => void;
  onMove: (id: string, direction: "up" | "down") => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, objective: string) => void;
}) {
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null);
  const [draftObjective, setDraftObjective] = useState("");
  const queuePending = Boolean(pendingGoalId);

  useEffect(() => {
    if (!open || (editingGoalId && !goals.some((goal) => goal.id === editingGoalId))) {
      setEditingGoalId(null);
      setDraftObjective("");
    }
  }, [editingGoalId, goals, open]);

  const beginEditing = (goal: GoalQueueItem) => {
    setEditingGoalId(goal.id);
    setDraftObjective(goal.objective);
  };

  const cancelEditing = () => {
    setEditingGoalId(null);
    setDraftObjective("");
  };

  const saveEditing = (goal: GoalQueueItem) => {
    const objective = draftObjective.trim();
    if (!objective || queuePending) return;
    onEdit(goal.id, objective);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && queuePending) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        aria-busy={queuePending}
        className="flex max-h-[min(680px,85vh)] max-w-[640px] flex-col overflow-hidden"
      >
        <DialogTitle>管理 Goal 队列</DialogTitle>
        <DialogDescription>
          调整后续 Goal 的顺序、目标内容，或移除不再需要的 Goal。
        </DialogDescription>

        {goals.length === 0 ? (
          <div className="mt-5 rounded-r2 border border-dashed border-line px-4 py-8 text-center text-[12px] text-muted">
            当前没有排队的 Goal。
          </div>
        ) : (
          <ol aria-label="Goal 队列" className="mt-4 min-h-0 space-y-2 overflow-y-auto pr-1">
            {goals.map((goal, index) => {
              const pending = pendingGoalId === goal.id;
              const editing = editingGoalId === goal.id;
              return (
                <li
                  key={goal.id}
                  aria-busy={pending}
                  className="rounded-r2 border border-line bg-surface p-3"
                >
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-elevated font-mono text-[10px] text-muted">
                      {index + 1}
                    </span>

                    <div className="min-w-0 flex-1">
                      {editing ? (
                        <div className="space-y-2">
                          <textarea
                            autoFocus
                            value={draftObjective}
                            disabled={queuePending}
                            aria-label={`编辑 Goal：${goal.objective}`}
                            onChange={(event) => setDraftObjective(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                cancelEditing();
                              }
                              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                                event.preventDefault();
                                saveEditing(goal);
                              }
                            }}
                            className="min-h-20 w-full resize-y rounded-r2 border border-line-strong bg-background px-2.5 py-2 text-[12px] leading-relaxed text-foreground outline-none placeholder:text-faint focus:border-bright disabled:opacity-50"
                          />
                          <div className="flex items-center justify-end gap-2">
                            <Button variant="ghost" disabled={queuePending} onClick={cancelEditing}>
                              取消
                            </Button>
                            <Button
                              disabled={queuePending || !draftObjective.trim()}
                              onClick={() => saveEditing(goal)}
                            >
                              保存
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-foreground">
                            {goal.objective}
                          </p>
                          <p className="mt-1.5 font-mono text-[9.5px] text-faint">
                            创建 {formatGoalTime(goal.createdAt)} · 更新{" "}
                            {formatGoalTime(goal.updatedAt)}
                          </p>
                        </>
                      )}
                    </div>

                    {!editing && (
                      <div className="flex shrink-0 items-center gap-1">
                        {pending ? (
                          <output
                            aria-label={`正在处理 ${goal.objective}`}
                            className="flex size-7 items-center justify-center text-muted"
                          >
                            <LoaderCircle size={13} className="animate-spin" />
                          </output>
                        ) : null}
                        <Button
                          variant="ghost"
                          className="size-7 px-0"
                          disabled={queuePending || index === 0}
                          aria-label={`上移 ${goal.objective}`}
                          onClick={() => onMove(goal.id, "up")}
                        >
                          <ArrowUp size={12} />
                        </Button>
                        <Button
                          variant="ghost"
                          className="size-7 px-0"
                          disabled={queuePending || index === goals.length - 1}
                          aria-label={`下移 ${goal.objective}`}
                          onClick={() => onMove(goal.id, "down")}
                        >
                          <ArrowDown size={12} />
                        </Button>
                        <Button
                          variant="ghost"
                          className="size-7 px-0"
                          disabled={queuePending}
                          aria-label={`编辑 ${goal.objective}`}
                          onClick={() => beginEditing(goal)}
                        >
                          <Pencil size={12} />
                        </Button>
                        <Button
                          variant="danger"
                          className="size-7 px-0"
                          disabled={queuePending}
                          aria-label={`删除 ${goal.objective}`}
                          onClick={() => onDelete(goal.id)}
                        >
                          <Trash2 size={12} />
                        </Button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}

function formatGoalTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(timestamp);
}
