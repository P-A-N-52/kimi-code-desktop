import { X } from "lucide-react";
import { useEffect } from "react";
import { cn } from "@/lib/utils";

export type CommandResultPanelState = {
  command: "usage" | "status";
  content: string;
  loading: boolean;
};

type CommandResultPanelProps = {
  result: CommandResultPanelState;
  onClose: () => void;
};

const TITLES: Record<CommandResultPanelState["command"], string> = {
  usage: "/usage",
  status: "/status",
};

export function CommandResultPanel({ result, onClose }: CommandResultPanelProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-label={TITLES[result.command]}
      className={cn(
        "mb-2 overflow-hidden rounded-r3 border border-line-strong bg-elevated shadow-pop",
      )}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="font-mono text-[11px] text-bright">{TITLES[result.command]}</span>
        <button
          type="button"
          aria-label="关闭"
          onClick={onClose}
          className="ml-auto text-faint transition-colors hover:text-foreground"
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
      <div className="max-h-56 overflow-y-auto px-3 py-2.5">
        {result.loading ? (
          <p className="font-mono text-[11px] text-muted">查询中…</p>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.55] text-muted">
            {result.content}
          </pre>
        )}
      </div>
    </div>
  );
}
