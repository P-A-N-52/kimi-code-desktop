import {
  Archive,
  ArchiveRestore,
  Check,
  CheckSquare2,
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { formatRelativeTime } from "@/hooks/utils";
import type { Session } from "@/lib/api/models";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog";
import { Kbd } from "@/ui/kbd";
import {
  groupSessionsByDay,
  groupSessionsByWorkDir,
  readExpandedGroupKeys,
  readSessionGroupMode,
  type SessionGroup,
  type SessionGroupMode,
  workDirGroupLabel,
  writeExpandedGroupKeys,
  writeSessionGroupMode,
} from "./session-groups";
import { STALE_ARCHIVE_DAY_OPTIONS, type StaleArchiveDays } from "./stale-sessions";

const SESSION_SKELETON_KEYS = ["one", "two", "three", "four", "five", "six"] as const;

function workDirName(workDir?: string | null): string {
  return workDirGroupLabel(workDir);
}

type SidebarMode = "active" | "archived";

type SessionContextMenu = {
  kind: "session";
  mode: SidebarMode;
  session: Session;
  startRename: () => void;
  x: number;
  y: number;
};

type ProjectContextMenu = {
  kind: "project";
  archived: boolean;
  label: string;
  sessions: Session[];
  x: number;
  y: number;
};

type SidebarContextMenu = SessionContextMenu | ProjectContextMenu;

type ProjectArchiveRequest = {
  archived: boolean;
  label: string;
  sessions: Session[];
};

function SessionItem({
  session,
  selected,
  mode,
  multiSelect,
  checked,
  groupMode,
  onToggleChecked,
  onSelect,
  onDelete,
  onRename,
  onArchive,
  onContextMenu,
}: {
  session: Session;
  selected: boolean;
  mode: SidebarMode;
  multiSelect: boolean;
  checked: boolean;
  groupMode: SessionGroupMode;
  onToggleChecked: () => void;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  onArchive: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>, startRename: () => void) => void;
}) {
  const { resolvedLanguage } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title ?? "");
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    const frame = requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  const commitRename = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== session.title) onRename(next);
  };

  const startRename = () => {
    setDraft(session.title ?? "");
    setEditing(true);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: The whole session row is a context-menu target, not a keyboard control.
    <div
      onContextMenu={(event) => {
        if (editing) {
          event.preventDefault();
          return;
        }
        onContextMenu(event, startRename);
      }}
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
            ref={renameInputRef}
            aria-label="会话标题"
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
              <span className="min-w-0 flex-1 truncate">{session.title || "未命名会话"}</span>
              {groupMode === "project" && (
                <span className="shrink-0 text-[10.5px] font-normal text-faint">
                  {formatRelativeTime(new Date(session.lastUpdated), resolvedLanguage)}
                </span>
              )}
            </span>
            {groupMode === "day" && (
              <span className="mt-px block truncate font-mono text-[10.5px] text-faint">
                {workDirName(session.workDir)} ·{" "}
                {formatRelativeTime(new Date(session.lastUpdated), resolvedLanguage)}
              </span>
            )}
          </button>
        </div>
      )}
      {!editing && !multiSelect && (
        <div className="absolute right-1.5 top-1.5 hidden gap-0.5 rounded-r1 bg-elevated/95 pl-1 group-focus-within:flex group-hover:flex">
          {mode === "active" && (
            <>
              <button
                type="button"
                aria-label="重命名"
                onClick={startRename}
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
  onArchive: (sessionId: string) => void;
  onUnarchive: (sessionId: string) => void;
  onArchiveProject: (sessionIds: string[], archived: boolean, workDir?: string) => Promise<number>;
  onBulkArchive: (sessionIds: string[]) => Promise<void>;
  onBulkUnarchive: (sessionIds: string[]) => Promise<void>;
  onBulkDelete: (sessionIds: string[]) => Promise<void>;
  onArchiveOlderThan: (days: number) => Promise<void>;
  /** Create a new session in the given project workDir (project-group hover +). */
  onCreateInWorkDir?: (workDir: string) => void;
  onLoadArchived: () => Promise<void>;
  onLoadMore: (mode: SidebarMode) => Promise<void>;
  hasLoadedArchived: boolean;
  hasMoreActive: boolean;
  hasMoreArchived: boolean;
  isLoadingMoreActive: boolean;
  isLoadingMoreArchived: boolean;
  /** Initial / empty-list loading for the active or archived pane. */
  isLoadingActive?: boolean;
  isLoadingArchived?: boolean;
  headerAction?: ReactNode;
};

export function SessionsSidebar(props: SessionsSidebarProps) {
  const { resolvedLanguage, t } = useI18n();
  const [mode, setMode] = useState<SidebarMode>("active");
  const [groupMode, setGroupMode] = useState<SessionGroupMode>(() => readSessionGroupMode());
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(
    () => readExpandedGroupKeys() ?? new Set(),
  );
  const [expandInitialized, setExpandInitialized] = useState(
    () => readExpandedGroupKeys() !== null,
  );
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [projectActionBusy, setProjectActionBusy] = useState(false);
  const [projectArchiveConfirmation, setProjectArchiveConfirmation] =
    useState<ProjectArchiveRequest | null>(null);
  const [staleMenuOpen, setStaleMenuOpen] = useState(false);
  const staleMenuRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<SidebarContextMenu | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState({ left: 0, top: 0 });
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mode === "archived" && !props.hasLoadedArchived) void props.onLoadArchived();
  }, [mode, props.hasLoadedArchived, props.onLoadArchived]);

  useEffect(() => {
    writeSessionGroupMode(groupMode);
  }, [groupMode]);

  useEffect(() => {
    if (!expandInitialized) return;
    writeExpandedGroupKeys(expandedKeys);
  }, [expandedKeys, expandInitialized]);

  useEffect(() => {
    void mode;
    setSelectedIds(new Set());
    setMultiSelect(false);
    setStaleMenuOpen(false);
    setContextMenu(null);
    setProjectArchiveConfirmation(null);
  }, [mode]);

  useEffect(() => {
    if (!staleMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!staleMenuRef.current?.contains(event.target as Node)) {
        setStaleMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setStaleMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [staleMenuOpen]);

  useEffect(() => {
    if (!contextMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  useLayoutEffect(() => {
    if (!contextMenu) return;
    const menu = contextMenuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    const gutter = 8;
    const left = Math.max(
      gutter,
      Math.min(contextMenu.x, window.innerWidth - bounds.width - gutter),
    );
    const top = Math.max(
      gutter,
      Math.min(contextMenu.y, window.innerHeight - bounds.height - gutter),
    );
    setContextMenuPosition((previous) =>
      previous.left === left && previous.top === top ? previous : { left, top },
    );
  }, [contextMenu]);

  const sourceSessions = useMemo(
    () => (mode === "active" ? props.sessions : props.archivedSessions),
    [mode, props.archivedSessions, props.sessions],
  );
  const visibleSessions = useMemo(() => {
    const query = props.searchQuery.trim().toLowerCase();
    if (!query) return sourceSessions;
    return sourceSessions.filter((session) =>
      [session.title, session.workDir, session.sessionId].some((value) =>
        value?.toLowerCase().includes(query),
      ),
    );
  }, [props.searchQuery, sourceSessions]);
  const groups = useMemo(
    () =>
      groupMode === "project"
        ? groupSessionsByWorkDir(visibleSessions)
        : groupSessionsByDay(visibleSessions),
    [groupMode, visibleSessions],
  );
  const completeProjectGroups = useMemo(
    () => (groupMode === "project" ? groupSessionsByWorkDir(sourceSessions) : []),
    [groupMode, sourceSessions],
  );
  const completeProjectGroupByKey = useMemo(
    () => new Map(completeProjectGroups.map((group) => [group.key, group])),
    [completeProjectGroups],
  );

  useEffect(() => {
    if (expandInitialized || groups.length === 0) return;
    setExpandedKeys(new Set(groups.map((group) => group.key)));
    setExpandInitialized(true);
  }, [expandInitialized, groups]);

  useEffect(() => {
    if (groupMode !== "project") return;
    const selected = visibleSessions.find((session) => session.sessionId === props.selectedId);
    if (!selected) return;
    const key = groupSessionsByWorkDir([selected])[0]?.key;
    if (!key) return;
    setExpandedKeys((previous) => {
      if (previous.has(key)) return previous;
      const next = new Set(previous);
      next.add(key);
      return next;
    });
  }, [groupMode, props.selectedId, visibleSessions]);

  const openSessionContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    session: Session,
    startRename: () => void,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      kind: "session",
      mode,
      session,
      startRename,
      x: event.clientX,
      y: event.clientY,
    });
    setContextMenuPosition({ left: event.clientX, top: event.clientY });
  };

  const openProjectContextMenu = (event: ReactMouseEvent<HTMLElement>, group: SessionGroup) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      kind: "project",
      archived: mode === "archived",
      label: group.label,
      sessions: group.items,
      x: event.clientX,
      y: event.clientY,
    });
    setContextMenuPosition({ left: event.clientX, top: event.clientY });
  };

  const copySessionId = async (value: string, target: "sessionId" | "shortId") => {
    setContextMenu(null);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand?.("copy") ?? false;
        textarea.remove();
        if (!copied) throw new Error(t("Clipboard unavailable"));
      }
      toast.success(t(target === "sessionId" ? "Session ID copied" : "Short ID copied"));
    } catch (error) {
      toast.error(t("Copy failed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const confirmDeleteSession = (session: Session) => {
    const title = session.title || (resolvedLanguage === "zh-CN" ? "未命名会话" : "Untitled");
    if (
      window.confirm(
        resolvedLanguage === "zh-CN"
          ? `确定永久删除“${title}”吗？`
          : `Permanently delete "${title}"?`,
      )
    ) {
      props.onDelete(session.sessionId);
    }
  };

  const toggleGroup = (key: string) => {
    setExpandInitialized(true);
    setExpandedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const hasMore = mode === "active" ? props.hasMoreActive : props.hasMoreArchived;
  const loadingMore = mode === "active" ? props.isLoadingMoreActive : props.isLoadingMoreArchived;
  const listLoading =
    mode === "active"
      ? Boolean(props.isLoadingActive) && props.sessions.length === 0
      : Boolean(props.isLoadingArchived) && props.archivedSessions.length === 0;
  const actionsBusy = bulkBusy || projectActionBusy;

  const executeProjectArchive = async ({
    archived,
    label,
    sessions: projectSessions,
  }: ProjectArchiveRequest) => {
    const ids = projectSessions.map((session) => session.sessionId);
    if (ids.length === 0) return;
    const workDir = projectSessions.find((session) => session.workDir?.trim())?.workDir?.trim();

    setContextMenu(null);
    setProjectActionBusy(true);
    try {
      const updatedCount = await props.onArchiveProject(ids, archived, workDir);
      if (updatedCount === 0) {
        toast.error(
          resolvedLanguage === "zh-CN"
            ? archived
              ? `项目「${label}」没有归档任何会话。`
              : `项目「${label}」没有恢复任何会话。`
            : archived
              ? `No sessions in "${label}" were archived.`
              : `No sessions in "${label}" were restored.`,
        );
      }
    } catch (error) {
      toast.error(
        resolvedLanguage === "zh-CN"
          ? archived
            ? `归档项目「${label}」失败`
            : `恢复项目「${label}」失败`
          : archived
            ? `Failed to archive project "${label}"`
            : `Failed to restore project "${label}"`,
        {
          description: error instanceof Error ? error.message : String(error),
        },
      );
    } finally {
      setProjectActionBusy(false);
      setProjectArchiveConfirmation(null);
    }
  };

  const runProjectArchive = (projectSessions: Session[], label: string, archived: boolean) => {
    const ids = projectSessions.map((session) => session.sessionId);
    if (ids.length === 0) return;
    if (actionsBusy) return;

    const request = { archived, label, sessions: projectSessions };
    if (archived) {
      setContextMenu(null);
      setProjectArchiveConfirmation(request);
      return;
    }
    void executeProjectArchive(request);
  };

  const confirmProjectArchive = () => {
    if (!projectArchiveConfirmation || projectActionBusy) return;
    void executeProjectArchive(projectArchiveConfirmation);
  };

  const runBulk = async (action: "archive" | "restore" | "delete") => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (actionsBusy) return;
    if (
      action === "delete" &&
      !window.confirm(
        resolvedLanguage === "zh-CN"
          ? `确定永久删除选中的 ${ids.length} 个会话吗？`
          : `Permanently delete the ${ids.length} selected sessions?`,
      )
    )
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

  const runArchiveOlderThan = async (days: StaleArchiveDays) => {
    setStaleMenuOpen(false);
    if (actionsBusy) return;
    if (
      !window.confirm(
        resolvedLanguage === "zh-CN"
          ? `确定归档所有超过 ${days} 天未活跃的会话吗？可在「已归档」中恢复。`
          : `Archive every session inactive for more than ${days} days? You can restore them from Archived.`,
      )
    ) {
      return;
    }
    setBulkBusy(true);
    try {
      await props.onArchiveOlderThan(days);
    } finally {
      setBulkBusy(false);
    }
  };

  const contextMenuView = contextMenu ? (
    <div
      ref={contextMenuRef}
      role="menu"
      aria-label={contextMenu.kind === "session" ? t("Session actions") : t("Project actions")}
      style={{ left: contextMenuPosition.left, top: contextMenuPosition.top }}
      className="fixed z-50 min-w-[170px] rounded-r2 border border-line-strong bg-elevated p-1 shadow-pop"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {contextMenu.kind === "session" ? (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => void copySessionId(contextMenu.session.sessionId, "sessionId")}
            className="flex w-full items-center gap-2 rounded-r1 px-2 py-1.5 text-left text-[11px] text-muted hover:bg-hover hover:text-foreground"
          >
            <Copy size={13} /> {t("Copy session ID")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void copySessionId(contextMenu.session.sessionId.slice(0, 6), "shortId")}
            className="flex w-full items-center gap-2 rounded-r1 px-2 py-1.5 text-left text-[11px] text-muted hover:bg-hover hover:text-foreground"
          >
            <Copy size={13} /> {t("Copy short ID")}
          </button>
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setContextMenu(null);
              contextMenu.startRename();
            }}
            className="flex w-full items-center gap-2 rounded-r1 px-2 py-1.5 text-left text-[11px] text-muted hover:bg-hover hover:text-foreground"
          >
            <Pencil size={13} /> {t("Rename")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setContextMenu(null);
              if (contextMenu.mode === "active") props.onArchive(contextMenu.session.sessionId);
              else props.onUnarchive(contextMenu.session.sessionId);
            }}
            className="flex w-full items-center gap-2 rounded-r1 px-2 py-1.5 text-left text-[11px] text-muted hover:bg-hover hover:text-foreground"
          >
            {contextMenu.mode === "active" ? <Archive size={13} /> : <ArchiveRestore size={13} />}
            {contextMenu.mode === "active" ? t("Archive session") : t("Restore session")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setContextMenu(null);
              confirmDeleteSession(contextMenu.session);
            }}
            className="flex w-full items-center gap-2 rounded-r1 px-2 py-1.5 text-left text-[11px] text-danger hover:bg-danger-bg"
          >
            <Trash2 size={13} /> {t("Delete session")}
          </button>
        </>
      ) : (
        <button
          type="button"
          role="menuitem"
          disabled={actionsBusy}
          onClick={() =>
            runProjectArchive(contextMenu.sessions, contextMenu.label, !contextMenu.archived)
          }
          className="flex w-full items-center gap-2 rounded-r1 px-2 py-1.5 text-left text-[11px] text-muted hover:bg-hover hover:text-foreground"
        >
          {contextMenu.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
          {contextMenu.archived
            ? t("Restore all project sessions")
            : t("Archive all project sessions")}
        </button>
      )}
    </div>
  ) : null;

  return (
    <>
      <div className="flex h-full flex-col px-2 pb-2 pt-2.5">
        <div className="mx-1 mb-2 flex items-center gap-1">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-r2 border border-line px-2 py-1.5 text-faint transition-colors focus-within:border-line-strong">
            <Search size={12} className="shrink-0" />
            <input
              id="sessions-search-input"
              value={props.searchQuery}
              onChange={(event) => props.onSearchQueryChange(event.target.value)}
              placeholder="搜索会话"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-faint"
            />
            <Kbd className="shrink-0">⌘K</Kbd>
          </div>
          {props.headerAction}
        </div>
        <div className="mx-1 mb-2 flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1">
            {(["active", "archived"] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-r1 px-2 py-1 text-[11px]",
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
                "ml-auto shrink-0 rounded-r1 p-1.5 text-muted hover:bg-hover",
                multiSelect && "bg-active text-bright",
              )}
            >
              <CheckSquare2 size={13} />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-0.5">
            {(["day", "project"] as const).map((item) => (
              <button
                key={item}
                type="button"
                aria-label={item === "day" ? "按天分组" : "按项目分组"}
                onClick={() => setGroupMode(item)}
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-r1 px-2 py-1 text-[11px]",
                  groupMode === item ? "bg-active text-bright" : "text-muted hover:text-foreground",
                )}
              >
                {item === "day" ? "按天" : "按项目"}
              </button>
            ))}
            {mode === "active" && (
              <div className="relative ml-auto" ref={staleMenuRef}>
                <button
                  type="button"
                  aria-label="一键归档"
                  aria-expanded={staleMenuOpen}
                  aria-haspopup="menu"
                  title="一键归档"
                  disabled={actionsBusy}
                  onClick={() => setStaleMenuOpen((open) => !open)}
                  className={cn(
                    "shrink-0 whitespace-nowrap rounded-r1 px-2 py-1 text-[11px] text-muted hover:bg-hover hover:text-foreground disabled:opacity-50",
                    staleMenuOpen && "bg-active text-bright",
                  )}
                >
                  一键归档
                </button>
                {staleMenuOpen && (
                  <div
                    role="menu"
                    className="absolute right-0 top-full z-20 mt-1 min-w-[108px] rounded-r2 border border-line bg-elevated py-1 shadow-sm"
                  >
                    {STALE_ARCHIVE_DAY_OPTIONS.map((days) => (
                      <button
                        key={days}
                        type="button"
                        role="menuitem"
                        disabled={actionsBusy}
                        onClick={() => void runArchiveOlderThan(days)}
                        className="flex w-full px-3 py-1.5 text-left text-[11px] text-muted hover:bg-hover hover:text-foreground disabled:opacity-50"
                      >
                        {days}d 以前
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {listLoading ? (
            <output
              className="flex flex-col gap-2 px-2 py-3"
              aria-busy="true"
              aria-label="加载会话中"
            >
              {SESSION_SKELETON_KEYS.map((key) => (
                <div
                  key={`session-skeleton-${key}`}
                  className="h-10 animate-pulse rounded-r2 bg-hover/80"
                />
              ))}
              <p className="px-1 pt-1 text-center font-mono text-[10.5px] text-faint">
                正在加载会话…
              </p>
            </output>
          ) : groups.length === 0 ? (
            <p className="px-2.5 py-6 text-center font-mono text-[11px] text-faint">
              {props.searchQuery
                ? "没有匹配的会话"
                : mode === "archived"
                  ? "还没有归档会话"
                  : "还没有会话"}
            </p>
          ) : null}
          {groupMode === "project" && groups.length > 0 && (
            <div className="mb-1 px-2.5 text-[10px] font-medium uppercase tracking-[0.09em] text-faint">
              项目
            </div>
          )}
          {groups.map((group) => {
            const expanded = groupMode !== "project" || expandedKeys.has(group.key);
            const projectGroup =
              groupMode === "project" ? (completeProjectGroupByKey.get(group.key) ?? group) : group;
            const groupWorkDir =
              projectGroup.items.find((session) => session.workDir?.trim())?.workDir?.trim() ??
              null;
            return (
              <div key={group.key} className="mb-3">
                {groupMode === "project" ? (
                  <div className="group/folder relative mb-0.5">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onContextMenu={(event) => openProjectContextMenu(event, projectGroup)}
                      onClick={() => toggleGroup(group.key)}
                      className="flex w-full items-center gap-1.5 rounded-r1 px-2 py-1 text-left text-muted hover:bg-hover hover:text-foreground"
                    >
                      {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      <Folder size={12} strokeWidth={1.5} />
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                        {group.label}
                      </span>
                      <span className="font-mono text-[10.5px] text-faint group-hover/folder:opacity-0">
                        {projectGroup.items.length}
                      </span>
                    </button>
                    <div className="pointer-events-auto absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-r1 bg-elevated/95 pl-1">
                      <button
                        type="button"
                        aria-label={mode === "active" ? "归档该项目全部会话" : "恢复该项目全部会话"}
                        disabled={
                          actionsBusy ||
                          projectArchiveConfirmation !== null ||
                          projectGroup.items.length === 0
                        }
                        onPointerDown={(event) => {
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          runProjectArchive(
                            projectGroup.items,
                            projectGroup.label,
                            mode === "active",
                          );
                        }}
                        className="shrink-0 whitespace-nowrap rounded-r1 px-1.5 py-0.5 text-[11px] text-muted hover:bg-active hover:text-foreground disabled:opacity-40"
                      >
                        {mode === "active" ? "归档" : "恢复"}
                      </button>
                      {groupWorkDir && props.onCreateInWorkDir && (
                        <button
                          type="button"
                          aria-label={`在 ${group.label} 新建会话`}
                          onClick={(event) => {
                            event.stopPropagation();
                            props.onCreateInWorkDir?.(groupWorkDir);
                          }}
                          className="flex size-[22px] shrink-0 items-center justify-center rounded-r1 text-muted opacity-0 hover:bg-active hover:text-foreground focus-visible:opacity-100 group-hover/folder:opacity-100"
                        >
                          <Plus size={12} strokeWidth={1.75} />
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="mb-1 px-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-faint">
                    {group.label}
                  </div>
                )}
                {expanded &&
                  group.items.map((session) => (
                    <SessionItem
                      key={session.sessionId}
                      session={session}
                      selected={session.sessionId === props.selectedId}
                      mode={mode}
                      multiSelect={multiSelect}
                      checked={selectedIds.has(session.sessionId)}
                      groupMode={groupMode}
                      onToggleChecked={() =>
                        setSelectedIds((previous) => {
                          const next = new Set(previous);
                          if (next.has(session.sessionId)) next.delete(session.sessionId);
                          else next.add(session.sessionId);
                          return next;
                        })
                      }
                      onSelect={() => props.onSelect(session.sessionId)}
                      onDelete={() => confirmDeleteSession(session)}
                      onRename={(title) => props.onRename(session.sessionId, title)}
                      onArchive={() =>
                        mode === "active"
                          ? props.onArchive(session.sessionId)
                          : props.onUnarchive(session.sessionId)
                      }
                      onContextMenu={(event, startRename) =>
                        openSessionContextMenu(event, session, startRename)
                      }
                    />
                  ))}
              </div>
            );
          })}
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
            <p className="mb-2 font-mono text-[10px] text-faint">
              已选择 {selectedIds.size} 个会话
            </p>
            <div className="flex gap-1.5">
              <Button
                className="flex-1"
                disabled={selectedIds.size === 0 || actionsBusy}
                onClick={() => void runBulk(mode === "active" ? "archive" : "restore")}
              >
                {mode === "active" ? "归档" : "恢复"}
              </Button>
              <Button
                variant="danger"
                className="flex-1"
                disabled={selectedIds.size === 0 || actionsBusy}
                onClick={() => void runBulk("delete")}
              >
                删除
              </Button>
            </div>
          </div>
        )}
      </div>
      <Dialog
        open={projectArchiveConfirmation !== null}
        onOpenChange={(open) => {
          if (!open && !projectActionBusy) setProjectArchiveConfirmation(null);
        }}
      >
        {projectArchiveConfirmation && (
          <DialogContent aria-busy={projectActionBusy}>
            <DialogTitle>
              {t("Archive project")}「{projectArchiveConfirmation.label}」{t("?")}
            </DialogTitle>
            <DialogDescription>
              {t("Archive all")} {projectArchiveConfirmation.sessions.length} {t("sessions")}
              {t("project archive description")}
            </DialogDescription>
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="ghost"
                disabled={projectActionBusy}
                onClick={() => setProjectArchiveConfirmation(null)}
              >
                {t("Cancel")}
              </Button>
              <Button disabled={projectActionBusy} onClick={confirmProjectArchive}>
                {projectActionBusy && <LoaderCircle size={13} className="animate-spin" />}
                {projectActionBusy ? t("Archiving…") : t("Confirm archive")}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
      {contextMenuView && typeof document !== "undefined"
        ? createPortal(contextMenuView, document.body)
        : null}
    </>
  );
}
