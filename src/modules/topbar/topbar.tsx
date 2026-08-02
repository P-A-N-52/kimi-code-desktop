import {
  Check,
  ChevronDown,
  Copy,
  Download,
  FolderOpen,
  PanelRight,
  Settings,
  SquareCode,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { isMacOS } from "@/hooks/utils";
import type { LiveMessage } from "@/hooks/types";
import { useI18n } from "@/lib/i18n";
import { findLastAiMessageText } from "@/lib/copy-last-ai-message";
import { defaultSessionExportFilename, messagesToSessionMarkdown } from "@/lib/session-export-md";
import { isTauri, openInEditor, openInExplorer, saveTextFileDialog } from "@/lib/tauri-api";
import { WindowControls } from "@/modules/topbar/window-controls";
import { IconButton } from "@/ui/icon-button";

export function Topbar({
  title,
  shortId,
  sessionId,
  workDir,
  messages = [],
  panelOpen,
  onTogglePanel,
  onOpenSettings,
}: {
  title: string;
  shortId?: string;
  sessionId?: string;
  workDir?: string | null;
  messages?: readonly LiveMessage[];
  panelOpen: boolean;
  onTogglePanel: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useI18n();
  const macOS = isMacOS();
  const [open, setOpen] = useState(false);
  const [copiedSessionId, setCopiedSessionId] = useState(false);
  const [copiedAiReply, setCopiedAiReply] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastAiReply = findLastAiMessageText(messages);

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
      toast(t("该入口仅在桌面应用中可用"));
      return;
    }
    try {
      if (operation === "explorer") await openInExplorer(workDir);
      else await openInEditor(workDir);
      setOpen(false);
    } catch (error) {
      toast.error(t("无法打开工作目录"), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const copyLastAiReply = useCallback(async () => {
    if (!lastAiReply) {
      toast("当前会话还没有可复制的 AI 回复");
      return;
    }
    try {
      await navigator.clipboard.writeText(lastAiReply);
      setCopiedAiReply(true);
      window.setTimeout(() => setCopiedAiReply(false), 1500);
      toast.success("已复制最后一条 AI 回复");
    } catch (error) {
      toast.error("复制失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [lastAiReply]);

  const exportMarkdown = useCallback(async () => {
    if (!isTauri()) {
      toast("导出 Markdown 仅在桌面应用中可用");
      return;
    }
    const markdown = messagesToSessionMarkdown({
      title,
      sessionId,
      workDir,
      messages,
    });
    try {
      const result = await saveTextFileDialog(
        defaultSessionExportFilename(title, sessionId),
        markdown,
      );
      if (result.saved) {
        toast.success("会话已导出", {
          description: result.path ?? undefined,
        });
        setOpen(false);
      }
    } catch (error) {
      toast.error("导出失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [messages, sessionId, title, workDir]);

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
                  setCopiedSessionId(true);
                  window.setTimeout(() => setCopiedSessionId(false), 1500);
                }}
                className="mt-1 flex w-full items-center gap-2 rounded-r1 px-2 py-2 text-left text-[11px] text-muted hover:bg-hover hover:text-foreground"
              >
                {copiedSessionId ? (
                  <Check size={13} className="text-success" />
                ) : (
                  <Copy size={13} />
                )}{" "}
                {copiedSessionId ? "已复制会话 ID" : "复制会话 ID"}
              </button>
            )}
            {sessionId && (
              <button
                type="button"
                disabled={!lastAiReply}
                onClick={() => void copyLastAiReply()}
                className="flex w-full items-center gap-2 rounded-r1 px-2 py-2 text-left text-[11px] text-muted hover:bg-hover hover:text-foreground disabled:opacity-40"
              >
                {copiedAiReply ? <Check size={13} className="text-success" /> : <Copy size={13} />}{" "}
                {copiedAiReply ? "已复制 AI 回复" : "复制最后一条 AI 回复"}
              </button>
            )}
            {sessionId && (
              <button
                type="button"
                disabled={messages.length === 0}
                onClick={() => void exportMarkdown()}
                className="flex w-full items-center gap-2 rounded-r1 px-2 py-2 text-left text-[11px] text-muted hover:bg-hover hover:text-foreground disabled:opacity-40"
              >
                <Download size={13} /> 导出 Markdown…
              </button>
            )}
            <button
              type="button"
              disabled={!workDir}
              onClick={() => void runNative("explorer")}
              className="flex w-full items-center gap-2 rounded-r1 px-2 py-2 text-left text-[11px] text-muted hover:bg-hover hover:text-foreground disabled:opacity-40"
            >
              <FolderOpen size={13} />{" "}
              {macOS ? t("在 Finder 中显示") : t("在资源管理器中打开")}
            </button>
            <button
              type="button"
              disabled={!workDir}
              onClick={() => void runNative("editor")}
              className="flex w-full items-center gap-2 rounded-r1 px-2 py-2 text-left text-[11px] text-muted hover:bg-hover hover:text-foreground disabled:opacity-40"
            >
              <SquareCode size={13} /> {t("在 VS Code 中打开")}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
              className="flex w-full items-center gap-2 rounded-r1 px-2 py-2 text-left text-[11px] text-muted hover:bg-hover hover:text-foreground"
            >
              <Settings size={13} /> {t("打开设置")}
            </button>
          </div>
        )}
      </div>
      <div className="absolute right-2.5 z-10 flex items-center gap-0.5">
        <IconButton label="工作区面板" active={panelOpen} onClick={onTogglePanel}>
          <PanelRight size={15} strokeWidth={1.5} />
        </IconButton>
        <WindowControls />
      </div>
    </>
  );
}
