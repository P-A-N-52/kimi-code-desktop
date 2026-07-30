import { Target } from "lucide-react";
import type { PermissionMode } from "@/hooks/wireTypes";
import { Button } from "@/ui/button";

export function GoalStartConfirmation({
  objective,
  permissionMode,
  replace,
  pending,
  onConfirm,
  onCancel,
}: {
  objective: string;
  permissionMode: Exclude<PermissionMode, "auto">;
  replace: boolean;
  pending: boolean;
  onConfirm: (mode: PermissionMode) => void;
  onCancel: () => void;
}) {
  return (
    <section
      role="dialog"
      aria-label="启动 Goal"
      aria-modal="false"
      className="mb-2 rounded-r2 border border-bright/30 bg-elevated px-3 py-3 shadow-pop"
    >
      <div className="flex items-start gap-2.5">
        <Target size={15} className="mt-0.5 shrink-0 text-bright" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-medium text-foreground">
            {replace ? "替换并启动 Goal？" : "启动 Goal？"}
          </h3>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
            Kimi Code 会围绕这个目标跨轮执行、检查进度，并在完成、暂停、阻塞或达到预算时停止。
          </p>
          <div className="mt-2 rounded-r1 border border-line bg-surface px-2.5 py-2 text-[12px] leading-relaxed text-foreground">
            {objective}
          </div>
          <p className="mt-2 text-[10.5px] text-faint">
            当前为 {permissionMode === "manual" ? "Manual" : "YOLO"}；请选择 Goal 运行时的权限模式。
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button disabled={pending} onClick={() => onConfirm("auto")}>
          切换 Auto 并开始
        </Button>
        <Button variant="ghost" disabled={pending} onClick={() => onConfirm("yolo")}>
          {permissionMode === "yolo" ? "保持 YOLO 并开始" : "切换 YOLO 并开始"}
        </Button>
        {permissionMode === "manual" && (
          <Button variant="ghost" disabled={pending} onClick={() => onConfirm("manual")}>
            保持 Manual 并开始
          </Button>
        )}
        <Button variant="ghost" disabled={pending} onClick={onCancel}>
          不开始
        </Button>
      </div>
    </section>
  );
}
