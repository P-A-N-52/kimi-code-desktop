import {
  ArrowUp,
  FileText,
  Folder,
  LoaderCircle,
  Plus,
  Square,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import type { ConfigModel, UploadSessionFileResponse } from "@/lib/api/models";
import { useI18n } from "@/lib/i18n";
import { isTauri, pickFiles } from "@/lib/tauri-api";
import {
  type SlashCommandDef,
  shouldExecuteSlashCommandImmediately,
} from "@/lib/slash-command-catalog";
import { cn } from "@/lib/utils";
import {
  type FileMentionEntry,
  formatMentionToken,
  insertTokenAtCaret,
} from "./file-mentions";
import { ModelPicker } from "./model-picker";
import { useFileMentions } from "./use-file-mentions";

export type QueuedPrompt = {
  id: string;
  text: string;
  attachments?: UploadSessionFileResponse[];
};

type ComposerProps = {
  sessionId: string;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (text?: string, attachments?: UploadSessionFileResponse[]) => void;
  onCancel: () => void;
  busy: boolean;
  canCancel: boolean;
  /** When true, block sending (e.g. stream disconnected / error). */
  sendDisabled?: boolean;
  planMode: boolean;
  slashCommands: SlashCommandDef[];
  queue: QueuedPrompt[];
  onRemoveQueued: (id: string) => void;
  onClearQueue: () => void;
  onUploadFile: (file: File) => Promise<UploadSessionFileResponse>;
  onOpenContext: () => void;
  listDirectory?: (sessionId: string, path?: string) => Promise<FileMentionEntry[]>;
  models: ConfigModel[];
  selectedModel: string;
  thinkingEnabled: boolean;
  thinkingEffort: string;
  modelControlsDisabled?: boolean;
  modelUpdating?: boolean;
  onSelectModel: (name: string) => void;
  onToggleThinking: (enabled: boolean) => void;
  onSelectThinkingEffort: (effort: string) => void;
  onManageConfig?: () => void;
};

export function Composer({
  sessionId,
  draft,
  onDraftChange,
  onSend,
  onCancel,
  busy,
  canCancel,
  sendDisabled = false,
  planMode,
  slashCommands,
  queue,
  onRemoveQueued,
  onClearQueue,
  onUploadFile,
  onOpenContext,
  listDirectory,
  models,
  selectedModel,
  thinkingEnabled,
  thinkingEffort,
  modelControlsDisabled = false,
  modelUpdating = false,
  onSelectModel,
  onToggleThinking,
  onSelectThinkingEffort,
  onManageConfig,
}: ComposerProps) {
  const { resolvedLanguage, t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commandMenuRef = useRef<HTMLDivElement>(null);
  const mentionMenuRef = useRef<HTMLDivElement>(null);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [activeCommand, setActiveCommand] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileMentions = useFileMentions({
    text: draft,
    setText: onDraftChange,
    textareaRef,
    sessionId,
    listDirectory,
    disabled: commandMenuOpen,
  });

  const commandQuery = draft.startsWith("/") ? draft.slice(1).split(/\s/, 1)[0].toLowerCase() : "";
  // No result cap: the menu is scrollable, and a hard limit hid skill:* and
  // other later entries until the query happened to narrow the list.
  const visibleCommands = useMemo(
    () =>
      slashCommands.filter((command) => {
        if (!commandQuery) return true;
        return [command.name, ...command.aliases].some((name) =>
          name.toLowerCase().includes(commandQuery),
        );
      }),
    [commandQuery, slashCommands],
  );

  const closeCommandMenu = () => {
    setCommandMenuOpen(false);
  };

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
    if (sendDisabled) return;
    const message = (text ?? draft).trim();
    if (!message) return;
    onSend(text, []);
    setCommandMenuOpen(false);
  };

  // All file entries (paste / native picker / OS drag-drop) end up as
  // CLI-style @path text tokens inserted into the draft at the caret.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const insertPathTokens = (paths: string[]) => {
    if (paths.length === 0) return;
    let text = draftRef.current;
    let caret = textareaRef.current?.selectionStart ?? text.length;
    for (const rawPath of paths) {
      const token = formatMentionToken(rawPath.replace(/\\/g, "/"));
      const inserted = insertTokenAtCaret(text, caret, token);
      text = inserted.nextText;
      caret = inserted.nextCaret;
    }
    // Sync immediately so sequential inserts (multi-file paste) see prior tokens
    // before React re-renders and refreshes draftRef from props.
    draftRef.current = text;
    onDraftChange(text);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  };

  const onComposerPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    // Clipboard files have no path: upload to the pending dir first, then
    // insert the resulting absolute path as text.
    void (async () => {
      const failures: string[] = [];
      setUploading(true);
      try {
        for (const file of files) {
          try {
            const uploaded = await onUploadFile(file);
            insertPathTokens([uploaded.path]);
          } catch (error) {
            failures.push(
              `${file.name}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (failures.length > 0) {
          toast.error(
            resolvedLanguage === "zh-CN"
              ? `${failures.length} 个文件上传失败`
              : `${failures.length} file upload${failures.length === 1 ? "" : "s"} failed`,
            {
              description: failures.join("\n"),
            },
          );
        }
      } finally {
        setUploading(false);
      }
    })();
  };

  const onPickFiles = () => {
    void (async () => {
      setUploading(true);
      try {
        const paths = await pickFiles();
        insertPathTokens(paths);
      } catch (error) {
        toast.error(t("Failed to open file picker"), {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setUploading(false);
      }
    })();
  };

  // OS-level drag-drop comes through Tauri window events with real absolute
  // paths (webview dragDropEnabled is on; HTML5 drop is intentionally unused).
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    void (async () => {
      unlisteners.push(
        await listen("tauri://drag-enter", () => setDragActive(true)),
        await listen("tauri://drag-leave", () => setDragActive(false)),
        await listen<{ paths?: string[] }>("tauri://drag-drop", (event) => {
          setDragActive(false);
          if (sendDisabled || uploading) return;
          insertPathTokens(event.payload.paths ?? []);
        }),
      );
      if (cancelled) unlisteners.forEach((unlisten) => unlisten());
    })();
    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendDisabled, uploading]);

  useEffect(() => {
    if (!commandMenuOpen && !fileMentions.isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (commandMenuRef.current?.contains(target)) return;
      if (mentionMenuRef.current?.contains(target)) return;
      if (textareaRef.current?.contains(target)) return;
      closeCommandMenu();
      fileMentions.closeMenu();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [commandMenuOpen, fileMentions.isOpen, fileMentions.closeMenu]);

  return (
    <div
      className={cn(
        "relative rounded-r3 border bg-elevated px-3 pb-2 pt-3 shadow-pop transition-colors focus-within:border-line-strong",
        planMode ? "border-dashed border-bright/40" : "border-line-strong",
        dragActive && "border-bright bg-active/40",
      )}
    >
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-r3 bg-elevated/80 text-[13px] text-bright">
          松开以插入文件路径
        </div>
      )}
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

      {commandMenuOpen && (
        <div
          ref={commandMenuRef}
          className="absolute bottom-[3.1rem] left-3 right-3 z-30 max-h-64 overflow-y-auto rounded-r2 border border-line-strong bg-elevated p-1 shadow-pop"
        >
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

      {fileMentions.isOpen && (
        <div
          ref={mentionMenuRef}
          role="listbox"
          aria-label="文件引用"
          className="absolute bottom-[3.1rem] left-3 right-3 z-30 max-h-64 overflow-y-auto rounded-r2 border border-line-strong bg-elevated p-1 shadow-pop"
        >
          {fileMentions.status === "loading" && fileMentions.options.length === 0 ? (
            <p className="flex items-center justify-center gap-2 p-3 text-[11px] text-faint">
              <LoaderCircle size={12} className="animate-spin" /> 加载工作区文件…
            </p>
          ) : fileMentions.status === "error" ? (
            <p className="p-3 text-center text-[11px] text-danger">
              {fileMentions.error ?? "加载失败"}
            </p>
          ) : fileMentions.options.length === 0 ? (
            <p className="p-3 text-center text-[11px] text-faint">
              {fileMentions.query
                ? `没有匹配 @${fileMentions.query} 的文件`
                : listDirectory
                  ? "工作区暂无可引用文件"
                  : "请先选择工作目录后再 @ 引用文件"}
            </p>
          ) : (
            fileMentions.options.map((option, index) => (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={fileMentions.activeIndex === index}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => fileMentions.selectOption(option)}
                onMouseEnter={() => fileMentions.setActiveIndex(index)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-r1 px-2.5 py-2 text-left",
                  fileMentions.activeIndex === index && "bg-active",
                )}
              >
                {option.isDirectory ? (
                  <Folder size={13} className="shrink-0 text-muted" strokeWidth={1.5} />
                ) : (
                  <FileText size={13} className="shrink-0 text-muted" strokeWidth={1.5} />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                  {option.label}
                </span>
                {option.insertValue !== option.label && (
                  <span className="max-w-[45%] truncate font-mono text-[11px] text-faint">
                    {option.insertValue}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={draft}
        disabled={sendDisabled}
        onChange={(event) => {
          const value = event.target.value;
          onDraftChange(value);
          // Match CLI web: Escape only closes; further typing while still on "/…" reopens.
          const wantsMenu = value.startsWith("/") && !value.includes("\n");
          setCommandMenuOpen(wantsMenu);
          if (wantsMenu) {
            fileMentions.closeMenu();
            setActiveCommand(0);
          } else {
            fileMentions.syncRangeFromCaret(event.target.selectionStart);
          }
        }}
        onPaste={onComposerPaste}
        onSelect={(event) => {
          if (commandMenuOpen) return;
          fileMentions.syncRangeFromCaret(event.currentTarget.selectionStart);
        }}
        onClick={(event) => {
          if (commandMenuOpen) return;
          fileMentions.syncRangeFromCaret(event.currentTarget.selectionStart);
        }}
        onKeyUp={(event) => {
          if (commandMenuOpen) return;
          if (
            event.key === "ArrowLeft" ||
            event.key === "ArrowRight" ||
            event.key === "Home" ||
            event.key === "End"
          ) {
            fileMentions.syncRangeFromCaret(event.currentTarget.selectionStart);
          }
        }}
        onKeyDown={(event) => {
          if (fileMentions.isOpen && fileMentions.handleKeyDown(event)) return;
          if (commandMenuOpen) {
            if (
              visibleCommands.length > 0 &&
              (event.key === "ArrowDown" || event.key === "ArrowUp")
            ) {
              event.preventDefault();
              setActiveCommand((current) =>
                event.key === "ArrowDown"
                  ? (current + 1) % visibleCommands.length
                  : (current - 1 + visibleCommands.length) % visibleCommands.length,
              );
              return;
            }
            if (visibleCommands.length > 0 && event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              selectCommand(visibleCommands[activeCommand] ?? visibleCommands[0]);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              closeCommandMenu();
              return;
            }
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        rows={2}
        placeholder={
          sendDisabled
            ? "连接已断开，请先重新连接…"
            : busy
              ? "继续输入；发送后会加入队列…"
              : "给 Kimi 布置任务…（@ 文件 / 命令）"
        }
        className="max-h-40 w-full resize-none bg-transparent px-1 text-[14px] leading-[1.55] text-foreground outline-none placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-60"
      />
      <div className="mt-1.5 flex items-center gap-0.5">
        <button
          type="button"
          aria-label="上传附件"
          disabled={uploading || sendDisabled}
          onClick={onPickFiles}
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
          disabled={sendDisabled}
          onClick={() => {
            fileMentions.closeMenu();
            onDraftChange(draft.startsWith("/") ? draft : "/");
            setCommandMenuOpen(true);
            requestAnimationFrame(() => textareaRef.current?.focus());
          }}
          className="flex h-7 items-center gap-1 rounded-r1 px-1.5 font-mono text-[11px] text-muted transition-colors hover:bg-hover hover:text-foreground disabled:opacity-50"
        >
          <SquareTerminal size={13} strokeWidth={1.5} /> 命令
        </button>
        <button
          type="button"
          onClick={onOpenContext}
          className="flex h-7 items-center gap-1 rounded-r1 px-1.5 font-mono text-[11px] text-muted transition-colors hover:bg-hover hover:text-foreground"
        >
          <FileText size={13} strokeWidth={1.5} /> 文件
        </button>
        {planMode && (
          <span className="ml-1 rounded bg-bright px-1.5 py-0.5 font-mono text-[9.5px] font-semibold tracking-[0.12em] text-background">
            PLAN
          </span>
        )}
        <ModelPicker
          models={models}
          selectedModel={selectedModel}
          thinkingEnabled={thinkingEnabled}
          thinkingEffort={thinkingEffort}
          disabled={modelControlsDisabled || sendDisabled}
          updating={modelUpdating}
          onSelectModel={onSelectModel}
          onToggleThinking={onToggleThinking}
          onSelectThinkingEffort={onSelectThinkingEffort}
          onManageConfig={onManageConfig}
        />
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
          disabled={!draft.trim() || uploading || sendDisabled}
          className="flex size-7 items-center justify-center rounded-full bg-bright text-background transition-opacity hover:opacity-85 disabled:opacity-40"
        >
          <ArrowUp size={13} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
