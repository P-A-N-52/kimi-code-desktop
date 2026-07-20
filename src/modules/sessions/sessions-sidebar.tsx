import {
  Archive,
  ArchiveRestore,
  Check,
  CheckSquare2,
  LoaderCircle,
  Pencil,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatRelativeTime } from "@/hooks/utils";
import type { Session } from "@/lib/api/models";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Kbd } from "@/ui/kbd";
import { groupSessionsByDay } from "./session-groups";

function workDirName(workDir?: string | null): string {
  if (!workDir) return "默认目录";
  const parts = workDir.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || workDir;
}

type SidebarMode = "active" | "archived";

function SessionItem({
  session,
  selected,
  mode,
  multiSelect,
  checked,
  onToggleChecked,
  onSelect,
  onDelete,
  onRename,
  onArchive,
  onGenerateTitle,
}: {
  session: Session;
  selected: boolean;
  mode: SidebarMode;
  multiSelect: boolean;
  checked: boolean;
  onToggleChecked: () => void;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  onArchive: () => void;
  onGenerateTitle: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title ?? "");
  const [generatingTitle, setGeneratingTitle] = useState(false);

  const commitRename = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== session.title) onRename(next);
  };

  return (
    <div
      className={cn(
        "group relative w-full rounded-r1 px-2.5 py-1.5 text-left transition-colors",
        selected ? "bg-active" : "hover:bg-hover",
      )}
    >
      {selected && (
        <span className="absolute bottom-[7px] left-0 top-[7px] w-[2px] rounded-full bg-bright" />
      )}
      {editing ? (
        <div className="flex items-center gap-1">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitRename();
              if (event.key === "Escape") setEditing(false);
            }}
            className="h-6 min-w-0 flex-1 rounded-r1 border border-line-strong bg-elevated px-1.5 text-[13px] outline-none"
          />
          <button
            type="button"
            aria-label="确认重命名"
            onClick={commitRename}
            className="text-muted hover:text-success"
          >
            <Check size={13} />
          </button>
          <button
            type="button"
            aria-label="取消重命名"
            onClick={() => setEditing(false)}
            className="text-muted hover:text-foreground"
          >
            <X size={13} />
          </button>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          {multiSelect && (
            <button
              type="button"
              aria-label={checked ? "取消选择会话" : "选择会话"}
              onClick={onToggleChecked}
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
                checked
                  ? "border-bright bg-bright text-background"
                  : "border-line-strong text-transparent",
              )}
            >
              <Check size={10} />
            </button>
          )}
          <button
            type="button"
            onClick={multiSelect ? onToggleChecked : onSelect}
            className="min-w-0 flex-1 text-left"
          >
            <span className="flex items-center gap-1.5 truncate text-[13px] font-medium text-foreground">
              {session.isRunning && (
                <span className="size-[5px] shrink-0 animate-breathe rounded-full bg-success" />
              )}
              {session.title || "未命名会话"}
            </span>
            <span className="mt-px block truncate font-mono text-[10.5px] text-faint">
              {workDirName(session.workDir)} · {formatRelativeTime(new Date(session.lastUpdated))}
            </span>
          </button>
        </div>
      )}
      {!editing && !multiSelect && (
        <div className="absolute right-1.5 top-1.5 hidden gap-0.5 rounded-r1 bg-elevated/95 pl-1 group-hover:flex">
          {mode === "active" && (
            <>
              <button
                type="button"
                aria-label="智能生成标题"
                disabled={generatingTitle}
                onClick={() => {
                  setGeneratingTitle(true);
                  void onGenerateTitle().finally(() => setGeneratingTitle(false));
                }}
                className="flex size-[22px] items-center justify-center rounded-r1 text-muted hover:bg-active hover:text-foreground"
              >
                {generatingTitle ? (
                  <LoaderCircle size={11} className="animate-spin" />
                ) : (
                  <Sparkles size={11} />
                )}
              </button>
              <button
                type="button"
                aria-label="重命名"
                onClick={() => {
                  setDraft(session.title ?? "");
                  setEditing(true);
                }}
                className="flex size-[22px] items-center justify-center rounded-r1 text-muted hover:bg-active hover:text-foreground"
              >
                <Pencil size={11} />
              </button>
              <button
                type="button"
                aria-label="归档会话"
                onClick={onArchive}
                className="flex size-[22px] items-center justify-center rounded-r1 text-muted hover:bg-active hover:text-foreground"
              >
                <Archive size={11} />
              </button>
            </>
          )}
          {mode === "archived" && (
            <button
              type="button"
              aria-label="恢复会话"
              onClick={onArchive}
              className="flex size-[22px] items-center justify-center rounded-r1 text-muted hover:bg-active hover:text-foreground"
            >
              <ArchiveRestore size={11} />
            </button>
          )}
          <button
            type="button"
            aria-label="删除会话"
            onClick={onDelete}
            className="flex size-[22px] items-center justify-center rounded-r1 text-muted hover:bg-danger-bg hover:text-danger"
          >
            <Trash2 size={11} />
          </button>
        </div>
      )}
    </div>
  );
}

export type SessionsSidebarProps = {
  sessions: Session[];
  archivedSessions: Session[];
  selectedId: string;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onGenerateTitle: (sessionId: string) => Promise<void>;
  onArchive: (sessionId: string) => void;
  onUnarchive: (sessionId: string) => void;
  onBulkArchive: (sessionIds: string[]) => Promise<void>;
  onBulkUnarchive: (sessionIds: string[]) => Promise<void>;
  onBulkDelete: (sessionIds: string[]) => Promise<void>;
  onLoadArchived: () => Promise<void>;
  onLoadMore: (mode: SidebarMode) => Promise<void>;
  hasLoadedArchived: boolean;
  hasMoreActive: boolean;
  hasMoreArchived: boolean;
  isLoadingMoreActive: boolean;
  isLoadingMoreArchived: boolean;
};

export function SessionsSidebar(props: SessionsSidebarProps) {
  const [mode, setMode] = useState<SidebarMode>("active");
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    if (mode === "archived" && !props.hasLoadedArchived) void props.onLoadArchived();
  }, [mode, props.hasLoadedArchived, props.onLoadArchived]);

  useEffect(() => {
    void mode;
    setSelectedIds(new Set());
    setMultiSelect(false);
  }, [mode]);

  const visibleSessions = useMemo(() => {
    const source = mode === "active" ? props.sessions : props.archivedSessions;
    const query = props.searchQuery.trim().toLowerCase();
    if (!query) return source;
    return source.filter((session) =>
      [session.title, session.workDir, session.sessionId].some((value) =>
        value?.toLowerCase().includes(query),
      ),
    );
  }, [mode, props.archivedSessions, props.searchQuery, props.sessions]);
  const groups = groupSessionsByDay(visibleSessions);
  const hasMore = mode === "active" ? props.hasMoreActive : props.hasMoreArchived;
  const loadingMore = mode === "active" ? props.isLoadingMoreActive : props.isLoadingMoreArchived;

  const runBulk = async (action: "archive" | "restore" | "delete") => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (action === "delete" && !window.confirm(`确定永久删除选中的 ${ids.length} 个会话吗？`))
      return;
    setBulkBusy(true);
    try {
      if (action === "archive") await props.onBulkArchive(ids);
      else if (action === "restore") await props.onBulkUnarchive(ids);
      else await props.onBulkDelete(ids);
      setSelectedIds(new Set());
      setMultiSelect(false);
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col px-2 pb-2 pt-3">
      <div className="mx-1 mb-2 flex items-center gap-2 rounded-r2 border border-line px-2.5 py-1.5 text-faint transition-colors focus-within:border-line-strong">
        <Search size={12} />
        <input
          id="sessions-search-input"
          value={props.searchQuery}
          onChange={(event) => props.onSearchQueryChange(event.target.value)}
          placeholder="搜索会话"
          className="w-full bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-faint"
        />
        <Kbd>⌘K</Kbd>
      </div>
      <div className="mx-1 mb-2 flex items-center gap-1">
        {(["active", "archived"] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setMode(item)}
            className={cn(
              "rounded-r1 px-2 py-1 text-[11px]",
              mode === item ? "bg-active text-bright" : "text-muted hover:text-foreground",
            )}
          >
            {item === "active" ? "进行中" : "已归档"}
          </button>
        ))}
        <button
          type="button"
          aria-label="批量管理"
          onClick={() => setMultiSelect((value) => !value)}
          className={cn(
            "ml-auto rounded-r1 p-1.5 text-muted hover:bg-hover",
            multiSelect && "bg-active text-bright",
          )}
        >
          <CheckSquare2 size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 && (
          <p className="px-2.5 py-6 text-center font-mono text-[11px] text-faint">
            {props.searchQuery
              ? "没有匹配的会话"
              : mode === "archived"
                ? "还没有归档会话"
                : "还没有会话"}
          </p>
        )}
        {groups.map((group) => (
          <div key={group.label} className="mb-4">
            <div className="mb-1 px-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-faint">
              {group.label}
            </div>
            {group.items.map((session) => (
              <SessionItem
                key={session.sessionId}
                session={session}
                selected={session.sessionId === props.selectedId}
                mode={mode}
                multiSelect={multiSelect}
                checked={selectedIds.has(session.sessionId)}
                onToggleChecked={() =>
                  setSelectedIds((previous) => {
                    const next = new Set(previous);
                    if (next.has(session.sessionId)) next.delete(session.sessionId);
                    else next.add(session.sessionId);
                    return next;
                  })
                }
                onSelect={() => props.onSelect(session.sessionId)}
                onDelete={() => {
                  if (window.confirm(`确定永久删除“${session.title || "未命名会话"}”吗？`))
                    props.onDelete(session.sessionId);
                }}
                onRename={(title) => props.onRename(session.sessionId, title)}
                onArchive={() =>
                  mode === "active"
                    ? props.onArchive(session.sessionId)
                    : props.onUnarchive(session.sessionId)
                }
                onGenerateTitle={() => props.onGenerateTitle(session.sessionId)}
              />
            ))}
          </div>
        ))}
        {hasMore && (
          <Button
            variant="ghost"
            className="mx-auto mb-2 flex"
            disabled={loadingMore}
            onClick={() => void props.onLoadMore(mode)}
          >
            {loadingMore ? "加载中…" : "加载更多"}
          </Button>
        )}
      </div>
      {multiSelect && (
        <div className="mt-2 rounded-r2 border border-line bg-elevated p-2">
          <p className="mb-2 font-mono text-[10px] text-faint">已选择 {selectedIds.size} 个会话</p>
          <div className="flex gap-1.5">
            <Button
              className="flex-1"
              disabled={selectedIds.size === 0 || bulkBusy}
              onClick={() => void runBulk(mode === "active" ? "archive" : "restore")}
            >
              {mode === "active" ? "归档" : "恢复"}
            </Button>
            <Button
              variant="danger"
              className="flex-1"
              disabled={selectedIds.size === 0 || bulkBusy}
              onClick={() => void runBulk("delete")}
            >
              删除
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
