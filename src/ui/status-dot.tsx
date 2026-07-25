import { cn } from "@/lib/utils";

export type StatusDotKind = "ok" | "error" | "running" | "suspended" | "idle";

function normalize(status?: string): StatusDotKind {
  switch (status) {
    case "ok":
    case "done":
    case "completed":
    case "success":
      return "ok";
    case "error":
    case "failed":
    case "cancelled":
    case "danger":
      return "error";
    case "running":
    case "working":
    case "in_progress":
    case "active":
      return "running";
    case "suspended":
      return "suspended";
    default:
      return "idle";
  }
}

const KIND_CLASS: Record<StatusDotKind, string> = {
  ok: "bg-success",
  error: "bg-danger",
  suspended: "bg-warn",
  idle: "bg-faint",
  running: "bg-success animate-dot-pulse motion-reduce:animate-none",
};

/** Compact status indicator with a soft pulse while running/working. */
export function StatusDot({
  status,
  className,
  title,
}: {
  status?: string;
  className?: string;
  title?: string;
}) {
  const kind = normalize(status);
  return (
    <span
      role="img"
      aria-label={title ?? kind}
      title={title}
      data-status={kind}
      className={cn("inline-block size-[7px] shrink-0 rounded-full", KIND_CLASS[kind], className)}
    />
  );
}
