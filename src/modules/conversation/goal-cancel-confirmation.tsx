import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog";

export function GoalCancelConfirmation({
  open,
  objective,
  pending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  objective?: string;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent>
        <DialogTitle>取消当前 Goal？</DialogTitle>
        <DialogDescription>取消后会清除当前 Goal，之后不能再恢复。</DialogDescription>
        {objective && (
          <p className="mt-4 rounded-r2 border border-line bg-background px-3 py-2 text-[12px] text-foreground">
            {objective}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            保留 Goal
          </Button>
          <Button variant="danger" disabled={pending} onClick={onConfirm}>
            {pending ? "正在取消…" : "确认取消"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
