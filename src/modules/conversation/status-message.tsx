import { CircleAlert, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export function StatusMessage({
  children,
  streaming,
  tone = "default",
}: {
  children: string;
  streaming?: boolean;
  tone?: "default" | "error";
}) {
  return (
    <div
      data-slot="status-message"
      className={cn(
        "my-3 flex items-center gap-2 font-mono text-[10.5px]",
        tone === "error" ? "text-danger" : "text-faint",
      )}
    >
      {tone === "error" ? (
        <CircleAlert size={11} strokeWidth={1.5} />
      ) : streaming ? (
        <LoaderCircle size={11} strokeWidth={1.5} className="animate-spin" />
      ) : (
        <span className="size-1.5 rounded-full bg-faint" />
      )}
      <span>{children}</span>
    </div>
  );
}
