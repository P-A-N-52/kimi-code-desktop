import {
  ArrowLeft,
  ArrowRightLeft,
  Bot,
  ChevronRight,
  FileArchive,
  FileInput,
  FileText,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  Github,
  ImageIcon,
  Lightbulb,
  LoaderCircle,
  Monitor,
  RefreshCw,
  UploadCloud,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { LiveMessage } from "@/hooks/types";
import { useGitWorkspace } from "@/hooks/useGitWorkspace";
import { useSessionPlans } from "@/hooks/useSessionPlans";
import type { SessionFileEntry } from "@/hooks/useSessions";
import { useAgentMonitorStore } from "@/lib/agent-monitor/store";
import type { GitChange, GitComparison } from "@/lib/git-workspace";
import { isSafeBrowserUrl } from "@/lib/safe-url";
import { deriveSessionSources, type SessionSource } from "@/lib/session-sources";
import { getSessionUploadFile, openExternal } from "@/lib/tauri-api";
import { useToolEventsStore } from "@/lib/tool-events/store";
import { cn } from "@/lib/utils";
import { Markdown } from "@/modules/conversation/markdown";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { AgentsTab } from "./agents-tab";
import type { WorkspaceTab } from "./changes-panel";
import type { ChangeEntry, PendingApproval } from "./derive-changes";
import { FilesTab } from "./files-tab";
import { TasksTab } from "./tasks-tab";

type Detail =
  | "home"
  | "changes"
  | "files"
  | "agents"
  | "tasks"
  | "compare"
  | "commit"
  | "pr"
  | "plan"
  | "sources";

type ContextSidebarProps = {
  sessionId: string;
  workDir?: string;
  messages: LiveMessage[];
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  changes: ChangeEntry[];
  pendingApprovals: PendingApproval[];
  listDirectory: (sessionId: string, path?: string) => Promise<SessionFileEntry[]>;
  getFile: (sessionId: string, path: string) => Promise<Blob>;
  onApproveAll: () => void;
  onRejectAll: () => void;
  onGoalControl: (action: "pause" | "resume" | "cancel") => Promise<unknown>;
  onClose: () => void;
};

const focusClass = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bright/40";
const fieldClass =
  "h-8 w-full rounded-r1 border border-line-strong bg-background px-2.5 text-[11.5px] text-foreground outline-none focus:border-bright";

function SectionTitle({
  id,
  children,
  action,
}: {
  id?: string;
  children: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center px-1 pb-2 pt-1">
      <h3
        id={id}
        className="min-w-0 flex-1 text-[11px] font-medium uppercase tracking-[0.12em] text-faint"
      >
        {children}
      </h3>
      {action}
    </div>
  );
}

function NavigationRow({
  icon,
  label,
  value,
  disabled,
  onClick,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value?: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  tone?: "success" | "danger";
}) {
  return (
    <button
      type="button"
      disabled={disabled || !onClick}
      aria-label={label}
      aria-disabled={disabled || !onClick}
      onClick={onClick}
      className={cn(
        "group flex min-h-10 w-full items-center gap-3 rounded-r2 px-2.5 text-left text-[13px] transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-45",
        focusClass,
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-muted">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-foreground">{label}</span>
      {value !== undefined ? (
        <span
          className={cn(
            "max-w-[150px] truncate font-mono text-[11px] text-faint",
            tone === "success" && "text-success",
            tone === "danger" && "text-danger",
          )}
        >
          {value}
        </span>
      ) : null}
      {onClick ? (
        <ChevronRight size={13} className="shrink-0 text-faint group-hover:text-muted" />
      ) : null}
    </button>
  );
}

function DetailHeader({
  title,
  onBack,
  onClose,
}: {
  title: string;
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
      <IconButton label="返回导航" onClick={onBack}>
        <ArrowLeft size={14} />
      </IconButton>
      <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{title}</h2>
      <IconButton label="关闭面板" onClick={onClose}>
        <X size={14} />
      </IconButton>
    </div>
  );
}

function ChangeList({
  changes,
  onSelect,
  selectedPath,
}: {
  changes: Array<GitChange | ChangeEntry>;
  onSelect?: (path: string) => void;
  selectedPath?: string;
}) {
  if (changes.length === 0) {
    return <p className="py-12 text-center font-mono text-[11px] text-faint">没有变更</p>;
  }
  return (
    <div className="space-y-1.5 p-3">
      {changes.map((change) => {
        const additions = "additions" in change ? change.additions : change.adds;
        const deletions = "deletions" in change ? change.deletions : change.dels;
        return (
          <button
            key={change.path}
            type="button"
            disabled={!onSelect}
            aria-expanded={onSelect ? selectedPath === change.path : undefined}
            onClick={() => onSelect?.(change.path)}
            className={cn(
              "flex w-full items-center gap-2 rounded-r2 border border-line bg-elevated px-2.5 py-2 text-left disabled:cursor-default",
              onSelect && "hover:bg-hover",
              onSelect && focusClass,
            )}
          >
            <FileText size={13} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{change.path}</span>
            <span className="font-mono text-[10px] text-success">+{additions}</span>
            <span className="font-mono text-[10px] text-danger">−{deletions}</span>
          </button>
        );
      })}
    </div>
  );
}

function SourcePreview({ sessionId, source }: { sessionId: string; source: SessionSource }) {
  const [url, setUrl] = useState(source.url);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setUrl(source.url);
    setError(null);
    if (source.url) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    void getSessionUploadFile(sessionId, source.label)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sessionId, source.label, source.url]);

  return (
    <div className="overflow-hidden rounded-r2 border border-line bg-elevated">
      {url && isSafeBrowserUrl(url) && source.mediaType.startsWith("image/") ? (
        <img
          src={url}
          alt={source.label}
          loading="lazy"
          className="h-32 w-full bg-secondary object-contain"
        />
      ) : url && isSafeBrowserUrl(url) && source.mediaType.startsWith("video/") ? (
        <video
          controls
          preload="metadata"
          aria-label={source.label}
          className="h-32 w-full bg-black"
        >
          <source src={url} type={source.mediaType} />
          <track kind="captions" />
        </video>
      ) : url && isSafeBrowserUrl(url) && source.mediaType.startsWith("audio/") ? (
        <audio controls preload="metadata" aria-label={source.label} className="w-full px-2 py-5">
          <source src={url} type={source.mediaType} />
          <track kind="captions" />
        </audio>
      ) : (
        <div className="flex h-20 items-center justify-center bg-secondary text-muted">
          <FileArchive size={22} strokeWidth={1.3} />
        </div>
      )}
      <div className="p-2">
        <p className="truncate font-mono text-[10.5px] text-foreground">{source.label}</p>
        <p className="mt-1 text-[9.5px] text-faint">
          {source.origin === "user-input" ? "用户输入" : "模型输出"}
          {source.turnIndex !== undefined ? ` · Turn ${source.turnIndex + 1}` : ""}
        </p>
        {error ? <p className="mt-1 text-[9.5px] text-danger">{error}</p> : null}
      </div>
    </div>
  );
}

export function ContextSidebar({
  sessionId,
  workDir,
  messages,
  activeTab,
  onTabChange,
  changes,
  pendingApprovals,
  listDirectory,
  getFile,
  onApproveAll,
  onRejectAll,
  onGoalControl,
  onClose,
}: ContextSidebarProps) {
  const git = useGitWorkspace(sessionId);
  const plans = useSessionPlans(sessionId);
  const sources = useMemo(() => deriveSessionSources(messages), [messages]);
  const [detail, setDetail] = useState<Detail>("home");
  const [branchTarget, setBranchTarget] = useState("");
  const [comparison, setComparison] = useState<GitComparison | null>(null);
  const [leftRef, setLeftRef] = useState("");
  const [rightRef, setRightRef] = useState("");
  const [compareError, setCompareError] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<{ path: string; content: string } | null>(null);
  const [fileDiffLoading, setFileDiffLoading] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prBase, setPrBase] = useState("");
  const [prDraft, setPrDraft] = useState(false);
  const [liveMessage, setLiveMessage] = useState("");
  const agentCount = useAgentMonitorStore(
    (state) => state.tasks.filter((task) => task.sessionId === sessionId).length,
  );
  const todoCount = useToolEventsStore(
    (state) => state.sessions[sessionId]?.todoItems.length ?? 0,
  );
  const goalCount = useToolEventsStore(
    (state) => (state.sessions[sessionId]?.currentGoal ? 1 : 0),
  );
  const environment = git.environment;
  const githubEnvironment = git.githubEnvironment;
  const allRefs = useMemo(
    () => [...(environment?.localBranches ?? []), ...(environment?.remoteBranches ?? [])],
    [environment?.localBranches, environment?.remoteBranches],
  );
  const gitUnavailable = !environment?.isGitRepo;
  const pullRequestUnavailable = gitUnavailable || !githubEnvironment?.ghAuthenticated;

  // biome-ignore lint/correctness/useExhaustiveDependencies: session identity must reset transient detail state
  useEffect(() => {
    setDetail("home");
    setComparison(null);
    setFileDiff(null);
    setSelectedPaths(new Set());
    setLiveMessage("");
  }, [sessionId]);

  useEffect(() => {
    if (!environment) return;
    setBranchTarget(environment.currentBranch);
    setLeftRef(environment.baseRef || allRefs[0] || "");
    setRightRef(environment.currentBranch || allRefs[1] || "");
    const preferredDefaultBranch = githubEnvironment?.defaultBranch ?? environment.defaultBranch;
    setPrBase(
      preferredDefaultBranch && environment.localBranches.includes(preferredDefaultBranch)
        ? preferredDefaultBranch
        : environment.localBranches.find((branch) => branch !== environment.currentBranch) || "",
    );
    setSelectedPaths(new Set(environment.status.map((entry) => entry.path)));
  }, [allRefs, environment, githubEnvironment?.defaultBranch]);

  useEffect(() => {
    if (activeTab !== "changes") setDetail(activeTab);
  }, [activeTab]);

  const showWorkspace = (tab: WorkspaceTab) => {
    onTabChange(tab);
    setDetail(tab);
  };

  const runBranchSwitch = async () => {
    if (!environment || !branchTarget || branchTarget === environment.currentBranch) return;
    const confirmed =
      !environment.dirty ||
      window.confirm(`当前工作区有 ${environment.status.length} 个变更。确认尝试切换分支？`);
    if (!confirmed) return;
    try {
      const result = await git.switchBranch(branchTarget, environment.dirty);
      setLiveMessage(`已切换到 ${result.branch || branchTarget}`);
      toast.success("分支切换完成");
    } catch (err) {
      toast.error("无法切换分支", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const runCompare = async () => {
    setCompareError(null);
    setComparison(null);
    setFileDiff(null);
    try {
      setComparison(await git.compare(leftRef, rightRef));
    } catch (err) {
      setCompareError(err instanceof Error ? err.message : String(err));
    }
  };

  const loadComparisonFile = async (path: string) => {
    setFileDiffLoading(true);
    setCompareError(null);
    try {
      setFileDiff({ path, content: await git.getFileDiff(leftRef, rightRef, path) });
    } catch (err) {
      setCompareError(err instanceof Error ? err.message : String(err));
    } finally {
      setFileDiffLoading(false);
    }
  };

  const runCommit = async () => {
    const paths = [...selectedPaths];
    if (!window.confirm(`确认提交选中的 ${paths.length} 个文件？`)) return;
    try {
      await git.commit(paths, commitMessage);
      setCommitMessage("");
      setLiveMessage("提交已创建");
      toast.success("提交已创建");
    } catch (err) {
      toast.error("提交失败", { description: err instanceof Error ? err.message : String(err) });
    }
  };

  const runPush = async () => {
    const remote = environment?.remotes.includes("origin") ? "origin" : environment?.remotes[0];
    if (!remote || !environment) return;
    if (!window.confirm(`确认推送 ${environment.currentBranch} 到 ${remote}？`)) return;
    try {
      await git.push(remote);
      setLiveMessage("推送完成");
      toast.success("推送完成");
    } catch (err) {
      toast.error("推送失败", { description: err instanceof Error ? err.message : String(err) });
    }
  };

  const runCreatePr = async () => {
    if (!window.confirm(`确认创建从 ${environment?.currentBranch} 到 ${prBase} 的拉取请求？`))
      return;
    try {
      const result = await git.createPullRequest({
        baseRef: prBase,
        title: prTitle,
        body: prBody,
        draft: prDraft,
      });
      setLiveMessage("拉取请求已创建");
      toast.success("拉取请求已创建");
      if (result.url) await openExternal(result.url);
    } catch (err) {
      toast.error("创建拉取请求失败", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const back = () => {
    if (detail === "plan" && plans.selected) {
      plans.close();
      return;
    }
    setDetail("home");
  };

  const blockedGitDetail =
    detail !== "home" &&
    (["changes", "compare", "commit", "pr"] as Detail[]).includes(detail) &&
    (gitUnavailable || (detail === "pr" && pullRequestUnavailable));
  if (blockedGitDetail) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <DetailHeader title="Git" onBack={back} onClose={onClose} />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          {gitUnavailable ? <GitBranch size={24} className="text-muted" /> : <Github size={24} className="text-muted" />}
          <output className="text-[12px] text-danger">
            {gitUnavailable
              ? "当前目录不是 Git 仓库"
              : githubEnvironment?.authMessage || git.githubError || "GitHub 信息尚未就绪"}
          </output>
          {!gitUnavailable ? <p className="text-[10.5px] text-faint">gh auth login</p> : null}
          <Button variant="ghost" disabled={git.loading} onClick={() => void git.refresh()}>
            <RefreshCw size={13} className={cn(git.loading && "animate-spin")} />
            重新检测
          </Button>
        </div>
      </div>
    );
  }

  if (detail !== "home") {
    const titles: Record<Exclude<Detail, "home">, string> = {
      changes: "相对分支的变更",
      files: "文件",
      agents: "代理",
      tasks: "任务",
      compare: "比较分支",
      commit: "提交或推送",
      pr: "创建拉取请求",
      plan: plans.selected?.title || "计划",
      sources: "来源",
    };
    return (
      <div className="flex h-full min-h-0 flex-col">
        <DetailHeader title={titles[detail]} onBack={back} onClose={onClose} />
        <div className="min-h-0 flex-1 overflow-hidden">
          {detail === "changes" ? (
            <div className="h-full overflow-y-auto">
              <div className="flex items-center gap-2 border-b border-line p-3">
                <label htmlFor="base-ref" className="text-[10.5px] text-faint">
                  基线
                </label>
                <select
                  id="base-ref"
                  value={environment?.baseRef || ""}
                  disabled={git.gitLoading}
                  onChange={(event) => void git.setBaseRef(event.target.value)}
                  className={cn(fieldClass, "min-w-0 flex-1")}
                >
                  {allRefs.map((branch) => (
                    <option key={branch}>{branch}</option>
                  ))}
                </select>
              </div>
              <ChangeList changes={environment?.changes ?? changes} />
              {pendingApprovals.length > 0 ? (
                <div className="flex gap-2 border-t border-line p-3">
                  <Button className="flex-1" onClick={onApproveAll}>
                    批准 ({pendingApprovals.length})
                  </Button>
                  <Button className="flex-1" variant="ghost" onClick={onRejectAll}>
                    拒绝
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {detail === "files" ? (
            <FilesTab sessionId={sessionId} listDirectory={listDirectory} getFile={getFile} />
          ) : null}
          {detail === "agents" ? (
            <div className="h-full overflow-y-auto">
              <AgentsTab sessionId={sessionId} />
            </div>
          ) : null}
          {detail === "tasks" ? (
            <div className="h-full overflow-y-auto">
              <TasksTab sessionId={sessionId} onGoalControl={onGoalControl} />
            </div>
          ) : null}
          {detail === "compare" ? (
            <div className="h-full overflow-y-auto p-3">
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                <select
                  value={leftRef}
                  onChange={(event) => setLeftRef(event.target.value)}
                  className={fieldClass}
                >
                  {allRefs.map((branch) => (
                    <option key={`left:${branch}`}>{branch}</option>
                  ))}
                </select>
                <ArrowRightLeft size={14} className="text-faint" />
                <select
                  value={rightRef}
                  onChange={(event) => setRightRef(event.target.value)}
                  className={fieldClass}
                >
                  {allRefs.map((branch) => (
                    <option key={`right:${branch}`}>{branch}</option>
                  ))}
                </select>
              </div>
              <Button
                className="mt-3 w-full"
                disabled={git.gitLoading || leftRef === rightRef}
                onClick={() => void runCompare()}
              >
                比较
              </Button>
              {compareError ? (
                <p className="mt-3 rounded-r1 bg-danger-bg p-2 text-[11px] text-danger">
                  {compareError}
                </p>
              ) : null}
              {comparison ? (
                <>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div className="rounded-r2 bg-secondary p-2 text-center text-[11px]">
                      {comparison.leftAhead} commits 仅左侧
                    </div>
                    <div className="rounded-r2 bg-secondary p-2 text-center text-[11px]">
                      {comparison.rightAhead} commits 仅右侧
                    </div>
                  </div>
                  <ChangeList
                    changes={comparison.files}
                    selectedPath={fileDiff?.path}
                    onSelect={(path) => void loadComparisonFile(path)}
                  />
                  {fileDiffLoading ? (
                    <div className="flex justify-center py-4">
                      <LoaderCircle size={16} className="animate-spin text-muted" />
                    </div>
                  ) : fileDiff ? (
                    <pre className="mx-3 mb-3 max-h-80 overflow-auto rounded-r2 border border-line bg-secondary p-3 font-mono text-[10px] leading-5 text-muted">
                      {fileDiff.content || "该文件没有可显示的文本差异"}
                    </pre>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
          {detail === "commit" ? (
            <div className="h-full overflow-y-auto p-3">
              <div className="space-y-1.5">
                {environment?.status.map((entry) => (
                  <label
                    key={entry.path}
                    className="flex items-center gap-2 rounded-r2 border border-line px-2.5 py-2 text-[11px]"
                  >
                    <input
                      type="checkbox"
                      checked={selectedPaths.has(entry.path)}
                      onChange={(event) => {
                        setSelectedPaths((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(entry.path);
                          else next.delete(entry.path);
                          return next;
                        });
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono">{entry.path}</span>
                    <span className="text-faint">
                      {entry.indexStatus}
                      {entry.worktreeStatus}
                    </span>
                  </label>
                ))}
              </div>
              <label className="mt-3 block text-[10.5px] text-faint" htmlFor="commit-message">
                提交信息
              </label>
              <textarea
                id="commit-message"
                value={commitMessage}
                maxLength={1000}
                onChange={(event) => setCommitMessage(event.target.value)}
                className={cn(fieldClass, "mt-1 h-20 resize-none py-2")}
              />
              <Button
                className="mt-3 w-full"
                disabled={git.gitLoading || selectedPaths.size === 0 || !commitMessage.trim()}
                onClick={() => void runCommit()}
              >
                提交 {selectedPaths.size} 个文件
              </Button>
              <div className="my-4 border-t border-line" />
              <p className="text-[11px] text-muted">
                {environment?.ahead
                  ? `${environment.ahead} 个提交尚未推送`
                  : "当前分支没有待推送提交"}
              </p>
              <Button
                variant="ghost"
                className="mt-2 w-full"
                disabled={
                  git.gitLoading || !environment?.currentBranch || environment.remotes.length === 0
                }
                onClick={() => void runPush()}
              >
                <UploadCloud size={13} /> 推送当前分支
              </Button>
            </div>
          ) : null}
          {detail === "pr" ? (
            <div className="h-full overflow-y-auto space-y-3 p-3">
              <label className="block text-[10.5px] text-faint" htmlFor="pr-base">
                目标分支
              </label>
              <select
                id="pr-base"
                value={prBase}
                onChange={(event) => setPrBase(event.target.value)}
                className={fieldClass}
              >
                {environment?.localBranches
                  .filter((branch) => branch !== environment.currentBranch)
                  .map((branch) => (
                    <option key={branch}>{branch}</option>
                  ))}
              </select>
              <label className="block text-[10.5px] text-faint" htmlFor="pr-title">
                标题
              </label>
              <input
                id="pr-title"
                value={prTitle}
                maxLength={256}
                onChange={(event) => setPrTitle(event.target.value)}
                className={fieldClass}
              />
              <label className="block text-[10.5px] text-faint" htmlFor="pr-body">
                说明
              </label>
              <textarea
                id="pr-body"
                value={prBody}
                onChange={(event) => setPrBody(event.target.value)}
                className={cn(fieldClass, "h-36 resize-y py-2")}
              />
              <label className="flex items-center gap-2 text-[11px] text-muted">
                <input
                  type="checkbox"
                  checked={prDraft}
                  onChange={(event) => setPrDraft(event.target.checked)}
                />
                创建为 Draft
              </label>
              <Button
                className="w-full"
                disabled={
                  git.gitLoading ||
                  git.githubLoading ||
                  !githubEnvironment?.ghAuthenticated ||
                  !prBase ||
                  !prTitle.trim() ||
                  !environment?.upstream ||
                  Boolean(environment.ahead)
                }
                onClick={() => void runCreatePr()}
              >
                创建拉取请求
              </Button>
              {environment && (!environment.upstream || environment.ahead > 0) ? (
                <p className="text-[10.5px] text-danger">请先推送最新提交。</p>
              ) : null}
            </div>
          ) : null}
          {detail === "plan" ? (
            <div className="h-full overflow-y-auto p-4">
              {plans.error ? (
                <p className="rounded-r1 bg-danger-bg p-3 text-[11px] text-danger">{plans.error}</p>
              ) : plans.selected?.content ? (
                <Markdown content={plans.selected.content} />
              ) : (
                <LoaderCircle className="mx-auto mt-12 animate-spin text-muted" size={18} />
              )}
            </div>
          ) : null}
          {detail === "sources" ? (
            <div className="grid h-full grid-cols-2 content-start gap-2 overflow-y-auto p-3">
              {sources.length ? (
                sources.map((source) => (
                  <SourcePreview key={source.id} sessionId={sessionId} source={source} />
                ))
              ) : (
                <p className="col-span-2 py-12 text-center text-[11px] text-faint">
                  当前会话没有文件或媒体来源
                </p>
              )}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center border-b border-line px-4">
        <h2 className="min-w-0 flex-1 text-[13px] font-semibold">上下文</h2>
        <IconButton
          label="刷新上下文"
          disabled={git.loading || plans.loading}
          onClick={() => {
            void git.refresh(environment?.baseRef);
            void plans.refresh();
          }}
        >
          <RefreshCw size={14} className={cn((git.loading || plans.loading) && "animate-spin")} />
        </IconButton>
        <IconButton label="关闭面板" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <section aria-labelledby="environment-heading">
          <SectionTitle id="environment-heading">环境信息</SectionTitle>
          {!environment && git.gitLoading ? (
            <div className="flex h-24 items-center justify-center">
              <LoaderCircle size={18} className="animate-spin text-muted" />
            </div>
          ) : null}
          {git.gitError ? (
            <p className="mb-2 rounded-r1 bg-danger-bg p-2 text-[10.5px] text-danger">
              {git.gitError}
            </p>
          ) : null}
          {git.githubError ? (
            <p className="mb-2 rounded-r1 bg-danger-bg p-2 text-[10.5px] text-danger">
              {git.githubError}
            </p>
          ) : null}
          {environment && !environment.isGitRepo ? (
            <p className="rounded-r2 border border-line bg-secondary p-3 text-[11px] text-muted">
              当前目录不是 Git 仓库
            </p>
          ) : null}
          {environment?.isGitRepo ? (
            <fieldset className="space-y-0.5">
              {githubEnvironment?.authMessage && !git.githubLoading ? (
                <output
                  id="github-lock-message"
                  className="mb-2 block rounded-r2 border border-line bg-secondary px-3 py-2 text-[11px] text-muted"
                >
                  {githubEnvironment.authMessage}
                </output>
              ) : null}
              <NavigationRow
                icon={<FileInput size={16} />}
                label="变更"
                value={
                  <>
                    <span className="text-success">+{environment.totalAdditions}</span>{" "}
                    <span className="text-danger">−{environment.totalDeletions}</span>
                  </>
                }
                onClick={() => showWorkspace("changes")}
              />
              <NavigationRow
                icon={<Monitor size={16} />}
                label="本地"
                value={githubEnvironment?.repository || workDir?.split(/[\\/]/).pop() || "工作区"}
              />
              <div className="flex items-center gap-2 rounded-r2 px-2.5 py-1.5">
                <GitBranch size={16} className="ml-0.5 shrink-0 text-muted" />
                <select
                  aria-label="切换分支"
                  value={branchTarget}
                  disabled={git.gitLoading}
                  onChange={(event) => setBranchTarget(event.target.value)}
                  className={cn(fieldClass, "min-w-0 flex-1 border-0 bg-transparent")}
                >
                  <optgroup label="本地分支">
                    {environment.localBranches.map((branch) => (
                      <option key={branch}>{branch}</option>
                    ))}
                  </optgroup>
                  <optgroup label="远程分支">
                    {environment.remoteBranches.map((branch) => (
                      <option key={branch}>{branch}</option>
                    ))}
                  </optgroup>
                </select>
                <Button
                  variant="ghost"
                  disabled={git.gitLoading || branchTarget === environment.currentBranch}
                  onClick={() => void runBranchSwitch()}
                >
                  切换
                </Button>
              </div>
              <NavigationRow
                icon={<GitCommitHorizontal size={16} />}
                label="提交或推送"
                value={environment.ahead ? `${environment.ahead} 待推送` : undefined}
                onClick={() => setDetail("commit")}
              />
              <NavigationRow
                icon={<Github size={16} />}
                label="创建拉取请求"
                disabled={pullRequestUnavailable || git.githubLoading}
                onClick={() => setDetail("pr")}
              />
              <NavigationRow
                icon={<ArrowRightLeft size={16} />}
                label="比较分支"
                onClick={() => setDetail("compare")}
              />
            </fieldset>
          ) : null}
        </section>

        <div className="my-4 border-t border-line" />
        <section aria-labelledby="plans-heading">
          <SectionTitle
            id="plans-heading"
            action={<span className="font-mono text-[9.5px] text-faint">{plans.plans.length}</span>}
          >
            计划
          </SectionTitle>
          {plans.error ? (
            <p className="rounded-r1 bg-danger-bg p-2 text-[10.5px] text-danger">{plans.error}</p>
          ) : null}
          {plans.plans.length ? (
            plans.plans.map((plan) => (
              <NavigationRow
                key={plan.id}
                icon={<Lightbulb size={16} />}
                label={plan.title}
                value={new Date(plan.modifiedMs).toLocaleDateString()}
                onClick={() => {
                  setDetail("plan");
                  void plans.open(plan.id);
                }}
              />
            ))
          ) : (
            <p className="px-2.5 py-3 text-[11px] text-faint">当前会话还没有计划</p>
          )}
        </section>

        <div className="my-4 border-t border-line" />
        <section aria-labelledby="sources-heading">
          <SectionTitle
            id="sources-heading"
            action={<span className="font-mono text-[9.5px] text-faint">{sources.length}</span>}
          >
            来源
          </SectionTitle>
          {sources.slice(0, 3).map((source) => (
            <NavigationRow
              key={source.id}
              icon={
                source.mediaType.startsWith("image/") ? (
                  <ImageIcon size={16} />
                ) : (
                  <FileArchive size={16} />
                )
              }
              label={source.label}
              value={source.origin === "user-input" ? "输入" : "模型"}
              onClick={() => setDetail("sources")}
            />
          ))}
          {sources.length === 0 ? (
            <p className="px-2.5 py-3 text-[11px] text-faint">当前会话还没有来源</p>
          ) : null}
          {sources.length > 3 ? (
            <NavigationRow
              icon={<ChevronRight size={16} />}
              label="查看全部"
              value={sources.length}
              onClick={() => setDetail("sources")}
            />
          ) : null}
        </section>

        <div className="my-4 border-t border-line" />
        <section aria-labelledby="workspace-heading">
          <SectionTitle id="workspace-heading">Workspace</SectionTitle>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ["files", "文件", <FolderTree key="files" size={15} />, undefined],
                ["agents", "代理", <Bot key="agents" size={15} />, agentCount],
                ["tasks", "任务", <FileText key="tasks" size={15} />, todoCount + goalCount],
              ] as const
            ).map(([tab, label, icon, count]) => (
              <button
                key={tab}
                type="button"
                onClick={() => showWorkspace(tab)}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-r2 border border-line bg-elevated px-2 py-3 text-[11px] text-muted transition-colors hover:bg-hover hover:text-foreground",
                  focusClass,
                )}
              >
                {icon}
                <span>
                  {label}
                  {count ? ` ${count}` : ""}
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
      <div aria-live="polite" className="sr-only">
        {liveMessage}
      </div>
    </div>
  );
}
