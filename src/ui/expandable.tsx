import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Height expand/collapse via grid-template-rows (matches kimi-web ToolRow). */
export function Expandable({
  open,
  children,
  className,
  "data-slot": dataSlot,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
  "data-slot"?: string;
}) {
  return (
    <div
      data-slot={dataSlot}
      data-open={open ? "true" : "false"}
      className={cn(
        "grid transition-[grid-template-rows] duration-[160ms] ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
