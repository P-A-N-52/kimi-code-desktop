import { FileText, RefreshCw, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { SessionFileEntry } from "@/hooks/useSessions";
import { useAgentMonitorStore } from "@/lib/agent-monitor/store";
import { useToolEventsStore } from "@/lib/tool-events/store";
import { cn } from "@/lib/utils";
import { DiffView } from "@/modules/conversation/diff-view";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { AgentsTab } from "./agents-tab";
import type { ChangeEntry, PendingApproval } from "./derive-changes";
import { FilesTab } from "./files-tab";
import { TasksTab } from "./tasks-tab";

export type WorkspaceTab = "changes" | "files" | "agents" | "tasks";

const TABS: Array<{ id: WorkspaceTab; label: string }> = [
  { id: "changes", label: "更改" },
  { id: "files", label: "文件" },
  { id: "agents", label: "代理" },
  { id: "tasks", label: "任务" },
];

type ChangesPanelProps = {
  sessionId: string;
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  changes: ChangeEntry[];
  pendingApprovals: PendingApproval[];
  changesLoading?: boolean;
  changesError?: string | null;
  onRefreshChanges: () => void;
  listDirectory: (sessionId: string, path?: string) => Promise<SessionFileEntry[]>;
  getFile: (sessionId: string, path: string) => Promise<Blob>;
  onApproveAll: () => void;
  onRejectAll: () => void;
  onClose: () => void;
};

function ChangesTab({
  changes,
  loading,
  error,
  onRefresh,
}: {
  changes: ChangeEntry[];
  loading: boolean;
  error?: string | null;
  onRefresh: () => void;
}) {
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set());
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1 font-mono text-[10px] text-faint">
          {changes.length > 0 ? `${changes.length} 个文件发生变化` : "工作区状态"}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-r1 p-1 text-muted hover:bg-hover hover:text-foreground"
          aria-label="刷新更改"
        >
          <RefreshCw size={13} className={cn(loading && "animate-spin")} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error && (
          <p className="mb-2 rounded-r1 bg-danger-bg p-2 text-[10.5px] text-danger">{error}</p>
        )}
        {changes.length === 0 ? (
          <p className="py-10 text-center font-mono text-[11px] text-faint">
            当前会话还没有文件更改
          </p>
        ) : (
          changes.map((change) => {
            const open = openPaths.has(change.path);
            return (
              <div
                key={change.path}
                className="mb-2 overflow-hidden rounded-r2 border border-line bg-elevated"
              >
                <button
                  type="button"
                  onClick={() =>
                    setOpenPaths((previous) => {
                      const next = new Set(previous);
                      if (next.has(change.path)) next.delete(change.path);
                      else next.add(change.path);
                      return next;
                    })
                  }
                  className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-hover"
                >
                  <FileText size={12} strokeWidth={1.5} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">
                    {change.path}
                  </span>
                  {change.status && (
                    <span className="font-mono text-[8.5px] uppercase text-faint">
                      {change.status}
                    </span>
                  )}
                  <span className="font-mono text-[10.5px] text-success tabular-nums">
                    +{change.adds}
                  </span>
                  <span className="font-mono text-[10.5px] text-danger tabular-nums">
                    −{change.dels}
                  </span>
                </button>
                {open && (
                  <div className="border-t border-line">
                    {change.display ? (
                      <DiffView data={change.display} maxLines={12} />
                    ) : (
                      <p className="p-3 font-mono text-[10px] text-faint">
                        已从 Git 读取统计；本轮事件没有可用的行级预览。
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export function ChangesPanel({
  sessionId,
  activeTab,
  onTabChange,
  changes,
  pendingApprovals,
  changesLoading = false,
  changesError,
  onRefreshChanges,
  listDirectory,
  getFile,
  onApproveAll,
  onRejectAll,
  onClose,
}: ChangesPanelProps) {
  const agentCount = useAgentMonitorStore(
    (state) => state.tasks.filter((task) => task.sessionId === sessionId).length,
  );
  const todoCount = useToolEventsStore((state) => state.todoItems.length);
  const newFileCount = useToolEventsStore((state) => state.newFiles.length);
  const counts = useMemo<Record<WorkspaceTab, number>>(
    () => ({
      changes: changes.length,
      files: newFileCount,
      agents: agentCount,
      tasks: todoCount,
    }),
    [agentCount, changes.length, newFileCount, todoCount],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-line px-3">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            className={cn(
              "rounded-r1 px-2 py-1 text-[12px] font-medium transition-colors",
              activeTab === tab.id ? "bg-active text-bright" : "text-muted hover:text-foreground",
            )}
          >
            {tab.label}
            {counts[tab.id] > 0 && (
              <span className="ml-1 font-mono text-[9.5px] text-faint tabular-nums">
                {counts[tab.id]}
              </span>
            )}
          </button>
        ))}
        <div className="flex-1" />
        <IconButton label="关闭面板" onClick={onClose}>
          <X size={14} strokeWidth={1.5} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === "changes" && (
          <ChangesTab
            changes={changes}
            loading={changesLoading}
            error={changesError}
            onRefresh={onRefreshChanges}
          />
        )}
        {activeTab === "files" && (
          <FilesTab sessionId={sessionId} listDirectory={listDirectory} getFile={getFile} />
        )}
        {activeTab === "agents" && (
          <div className="h-full overflow-y-auto">
            <AgentsTab sessionId={sessionId} />
          </div>
        )}
        {activeTab === "tasks" && (
          <div className="h-full overflow-y-auto">
            <TasksTab />
          </div>
        )}
      </div>
      {activeTab === "changes" && (
        <div className="flex shrink-0 gap-2 border-t border-line p-3">
          <Button
            variant="primary"
            className="flex-1"
            disabled={pendingApprovals.length === 0}
            onClick={onApproveAll}
          >
            批准待执行{pendingApprovals.length > 0 ? ` (${pendingApprovals.length})` : ""}
          </Button>
          <Button
            variant="ghost"
            className="flex-1"
            disabled={pendingApprovals.length === 0}
            onClick={onRejectAll}
          >
            拒绝待执行
          </Button>
        </div>
      )}
    </div>
  );
}
