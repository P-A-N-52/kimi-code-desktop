import {
  ArrowUp,
  ChevronDown,
  FileText,
  LoaderCircle,
  Paperclip,
  Plus,
  Square,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { UploadSessionFileResponse } from "@/lib/api/models";
import {
  type SlashCommandDef,
  shouldExecuteSlashCommandImmediately,
} from "@/lib/slash-command-catalog";
import { cn } from "@/lib/utils";

export type QueuedPrompt = { id: string; text: string };

type ComposerProps = {
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (text?: string) => void;
  onCancel: () => void;
  busy: boolean;
  canCancel: boolean;
  planMode: boolean;
  slashCommands: SlashCommandDef[];
  queue: QueuedPrompt[];
  onRemoveQueued: (id: string) => void;
  onClearQueue: () => void;
  onUploadFile: (file: File) => Promise<UploadSessionFileResponse>;
  onOpenContext: () => void;
  modelLabel: string;
  onOpenModelSettings: () => void;
};

export function Composer({
  draft,
  onDraftChange,
  onSend,
  onCancel,
  busy,
  canCancel,
  planMode,
  slashCommands,
  queue,
  onRemoveQueued,
  onClearQueue,
  onUploadFile,
  onOpenContext,
  modelLabel,
  onOpenModelSettings,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [activeCommand, setActiveCommand] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<UploadSessionFileResponse[]>([]);

  const commandQuery = draft.startsWith("/") ? draft.slice(1).split(/\s/, 1)[0].toLowerCase() : "";
  const visibleCommands = useMemo(
    () =>
      slashCommands
        .filter((command) => {
          if (!commandQuery) return true;
          return [command.name, ...command.aliases].some((name) =>
            name.toLowerCase().includes(commandQuery),
          );
        })
        .slice(0, 10),
    [commandQuery, slashCommands],
  );

  const selectCommand = (command: SlashCommandDef) => {
    setCommandMenuOpen(false);
    const commandText = `/${command.name}`;
    if (shouldExecuteSlashCommandImmediately(command)) {
      onDraftChange("");
      onSend(commandText);
      return;
    }
    onDraftChange(`${commandText}${command.inputHint ? " " : " "}`);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const submit = (text?: string) => {
    onSend(text);
    setCommandMenuOpen(false);
    setUploadedFiles([]);
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      const uploaded: UploadSessionFileResponse[] = [];
      for (const file of Array.from(files)) uploaded.push(await onUploadFile(file));
      setUploadedFiles((current) => [...current, ...uploaded]);
      toast.success(uploaded.length === 1 ? "文件已上传" : `${uploaded.length} 个文件已上传`);
    } catch (error) {
      toast.error("文件上传失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div
      className={cn(
        "relative rounded-r3 border bg-elevated px-3 pb-2 pt-3 shadow-pop transition-colors focus-within:border-line-strong",
        planMode ? "border-dashed border-bright/40" : "border-line-strong",
      )}
    >
      {queue.length > 0 && (
        <div className="mb-2 rounded-r2 border border-line bg-surface p-2">
          <div className="mb-1.5 flex items-center text-[10px] font-medium text-muted">
            <span>待发送队列 · {queue.length}</span>
            <button
              type="button"
              onClick={onClearQueue}
              className="ml-auto flex items-center gap-1 text-faint hover:text-danger"
            >
              <Trash2 size={11} /> 清空
            </button>
          </div>
          <div className="space-y-1">
            {queue.map((item, index) => (
              <div
                key={item.id}
                className="flex items-center gap-2 rounded-r1 bg-elevated px-2 py-1"
              >
                <span className="font-mono text-[9px] text-faint">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[10.5px] text-foreground">
                  {item.text}
                </span>
                <button
                  type="button"
                  aria-label={`移除队列项 ${index + 1}`}
                  onClick={() => onRemoveQueued(item.id)}
                  className="text-faint hover:text-danger"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {uploadedFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {uploadedFiles.map((file) => (
            <span
              key={file.path}
              className="flex items-center gap-1 rounded-r1 border border-line bg-surface px-2 py-1 font-mono text-[9.5px] text-muted"
            >
              <Paperclip size={10} /> {file.filename}
            </span>
          ))}
        </div>
      )}

      {commandMenuOpen && (
        <div className="absolute bottom-[3.1rem] left-3 right-3 z-30 max-h-64 overflow-y-auto rounded-r2 border border-line-strong bg-elevated p-1 shadow-pop">
          {visibleCommands.length === 0 ? (
            <p className="p-3 text-center text-[11px] text-faint">没有匹配的命令</p>
          ) : (
            visibleCommands.map((command, index) => (
              <button
                key={command.name}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectCommand(command)}
                onMouseEnter={() => setActiveCommand(index)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-r1 px-2.5 py-2 text-left",
                  activeCommand === index && "bg-active",
                )}
              >
                <span className="font-mono text-[11px] text-bright">/{command.name}</span>
                <span className="min-w-0 flex-1 text-[10.5px] text-muted">
                  {command.description || command.inputHint}
                </span>
              </button>
            ))
          )}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) => {
          const value = event.target.value;
          onDraftChange(value);
          setCommandMenuOpen(value.startsWith("/") && !value.includes("\n"));
          setActiveCommand(0);
        }}
        onKeyDown={(event) => {
          if (commandMenuOpen && visibleCommands.length > 0) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActiveCommand((current) =>
                event.key === "ArrowDown"
                  ? (current + 1) % visibleCommands.length
                  : (current - 1 + visibleCommands.length) % visibleCommands.length,
              );
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              selectCommand(visibleCommands[activeCommand] ?? visibleCommands[0]);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setCommandMenuOpen(false);
              return;
            }
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        rows={2}
        placeholder={busy ? "继续输入；发送后会加入队列…" : "给 Kimi 布置任务…（/ 命令）"}
        className="max-h-40 w-full resize-none bg-transparent px-1 text-[14px] leading-[1.55] text-foreground outline-none placeholder:text-faint"
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => void uploadFiles(event.target.files)}
      />
      <div className="mt-1.5 flex items-center gap-0.5">
        <button
          type="button"
          aria-label="上传附件"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
          className="flex h-7 w-7 items-center justify-center rounded-r1 text-muted transition-colors hover:bg-hover hover:text-foreground disabled:opacity-50"
        >
          {uploading ? (
            <LoaderCircle size={14} className="animate-spin" />
          ) : (
            <Plus size={14} strokeWidth={1.5} />
          )}
        </button>
        <button
          type="button"
          onClick={() => {
            onDraftChange(draft.startsWith("/") ? draft : "/");
            setCommandMenuOpen(true);
            requestAnimationFrame(() => textareaRef.current?.focus());
          }}
          className="flex h-7 items-center gap-1 rounded-r1 px-1.5 font-mono text-[11px] text-muted transition-colors hover:bg-hover hover:text-foreground"
        >
          <SquareTerminal size={13} strokeWidth={1.5} /> 命令
        </button>
        <button
          type="button"
          onClick={onOpenContext}
          className="flex h-7 items-center gap-1 rounded-r1 px-1.5 font-mono text-[11px] text-muted transition-colors hover:bg-hover hover:text-foreground"
        >
          <FileText size={13} strokeWidth={1.5} /> 上下文
        </button>
        {planMode && (
          <span className="ml-1 rounded bg-bright px-1.5 py-0.5 font-mono text-[9.5px] font-semibold tracking-[0.12em] text-background">
            PLAN
          </span>
        )}
        <button
          type="button"
          onClick={onOpenModelSettings}
          className="ml-auto flex h-7 max-w-40 items-center gap-1.5 rounded-full border border-line px-2.5 font-mono text-[11px] font-medium text-muted transition-colors hover:bg-hover hover:text-foreground"
        >
          <span className="truncate">{modelLabel}</span>
          <ChevronDown size={10} strokeWidth={1.5} />
        </button>
        {canCancel && (
          <button
            type="button"
            aria-label="停止生成"
            onClick={onCancel}
            className="flex size-7 items-center justify-center rounded-full border border-line-strong text-muted hover:text-foreground"
          >
            <Square size={11} strokeWidth={1.5} />
          </button>
        )}
        <button
          type="button"
          aria-label={busy ? "加入发送队列" : "发送"}
          onClick={() => submit()}
          disabled={!draft.trim() || uploading}
          className="flex size-7 items-center justify-center rounded-full bg-bright text-background transition-opacity hover:opacity-85 disabled:opacity-40"
        >
          <ArrowUp size={13} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
