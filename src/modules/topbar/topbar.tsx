import {
  Check,
  ChevronDown,
  Copy,
  FolderOpen,
  PanelRight,
  Settings,
  SquareCode,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { isTauri, openInEditor, openInExplorer } from "@/lib/tauri-api";
import { IconButton } from "@/ui/icon-button";

export function Topbar({
  title,
  shortId,
  sessionId,
  workDir,
  panelOpen,
  onTogglePanel,
  onOpenSettings,
}: {
  title: string;
  shortId?: string;
  sessionId?: string;
  workDir?: string | null;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const runNative = async (operation: "explorer" | "editor") => {
    if (!workDir) return;
    if (!isTauri()) {
      toast("该入口仅在桌面应用中可用");
      return;
    }
    try {
      if (operation === "explorer") await openInExplorer(workDir);
      else await openInEditor(workDir);
      setOpen(false);
    } catch (error) {
      toast.error("无法打开工作目录", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <>
      <div ref={rootRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex max-w-[min(34rem,50vw)] items-center gap-1.5 rounded-r1 px-2.5 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-hover"
        >
          <span className="truncate">{title || "Kimi Code"}</span>
          {shortId && <span className="font-mono text-[10.5px] text-faint">#{shortId}</span>}
          <ChevronDown size={12} strokeWidth={1.5} className="shrink-0 text-faint" />
        </button>
        {open && (
          <div className="absolute left-1/2 top-9 z-40 w-80 -translate-x-1/2 rounded-r2 border border-line-strong bg-elevated p-1.5 shadow-pop">
            <div className="border-b border-line px-2 py-2">
              <p className="truncate text-[12px] font-medium text-foreground">
                {title || "Kimi Code"}
              </p>
              {workDir && (
                <p className="mt-1 truncate font-mono text-[9.5px] text-faint" title={workDir}>
                  {workDir}
                </p>
              )}
            </div>
            {sessionId && (
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(sessionId);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
                className="mt-1 flex w-full items-center gap-2 rounded-r1 px-2 py-2 text-left text-[11px] text-muted hover:bg-hover hover:text-foreground"
              >
                {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}{" "}
                {copied ? "已复制会话 ID" : "复制会话 ID"}
              </button>
            )}
            <button
              type="button"
              disabled={!workDir}
              onClick={() => void runNative("explorer")}
              className="flex w-full items-center gap-2 rounded-r1 px-2 py-2 text-left text-[11px] text-muted hover:bg-hover hover:text-foreground disabled:opacity-40"
            >
              <FolderOpen size={13} /> 在资源管理器中打开
            </button>
            <button
              type="button"
              disabled={!workDir}
              onClick={() => void runNative("editor")}
              className="flex w-full items-center gap-2 rounded-r1 px-2 py-2 text-left text-[11px] text-muted hover:bg-hover hover:text-foreground disabled:opacity-40"
            >
              <SquareCode size={13} /> 在 VS Code 中打开
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
              className="flex w-full items-center gap-2 rounded-r1 px-2 py-2 text-left text-[11px] text-muted hover:bg-hover hover:text-foreground"
            >
              <Settings size={13} /> 打开设置
            </button>
          </div>
        )}
      </div>
      <div className="absolute right-2.5 flex gap-0.5">
        <IconButton label="工作区面板" active={panelOpen} onClick={onTogglePanel}>
          <PanelRight size={15} strokeWidth={1.5} />
        </IconButton>
      </div>
    </>
  );
}
