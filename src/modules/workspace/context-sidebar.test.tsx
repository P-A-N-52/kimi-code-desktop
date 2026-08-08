import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitEnvironment } from "@/lib/git-workspace";
import { ContextSidebar } from "./context-sidebar";

const gitHook = vi.hoisted(() => vi.fn());
const plansHook = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useGitWorkspace", () => ({ useGitWorkspace: gitHook }));
vi.mock("@/hooks/useSessionPlans", () => ({ useSessionPlans: plansHook }));
vi.mock("@/lib/agent-monitor/store", () => ({ useAgentMonitorStore: () => 0 }));
vi.mock("@/lib/tool-events/store", () => ({
  useToolEventsStore: (selector: (state: object) => unknown) =>
    selector({ sessions: {} }),
}));
vi.mock("./files-tab", () => ({ FilesTab: () => <div>Files detail</div> }));
vi.mock("./agents-tab", () => ({ AgentsTab: () => <div>Agents detail</div> }));
vi.mock("./tasks-tab", () => ({ TasksTab: () => <div>Tasks detail</div> }));

const environment: GitEnvironment = {
  isGitRepo: true,
  workDir: "C:\\repo",
  currentBranch: "topic",
  headSha: "abc",
  defaultBranch: "main",
  baseRef: "main",
  localBranches: ["main", "topic"],
  remoteBranches: ["origin/main"],
  remotes: ["origin"],
  ahead: 0,
  behind: 0,
  dirty: true,
  status: [{ path: "src/a.ts", indexStatus: " ", worktreeStatus: "M", untracked: false }],
  changes: [{ path: "src/a.ts", additions: 2, deletions: 1, status: "modified" }],
  totalAdditions: 2,
  totalDeletions: 1,
};

function renderSidebar(sessionId = "session-1") {
  return render(
    <ContextSidebar
      sessionId={sessionId}
      workDir="C:\\repo"
      messages={[]}
      activeTab="changes"
      onTabChange={vi.fn()}
      changes={[]}
      pendingApprovals={[]}
      listDirectory={vi.fn().mockResolvedValue([])}
      getFile={vi.fn().mockResolvedValue(new Blob())}
      onApproveAll={vi.fn()}
      onRejectAll={vi.fn()}
      onGoalControl={vi.fn().mockResolvedValue(undefined)}
      onClose={vi.fn()}
    />,
  );
}

describe("ContextSidebar", () => {
  beforeEach(() => {
    gitHook.mockReturnValue({
      environment,
      githubEnvironment: {
        ghInstalled: true,
        ghAuthenticated: false,
        authMessage: "GitHub CLI认证检查 failed",
      },
      gitLoading: false,
      githubLoading: false,
      gitError: null,
      githubError: null,
      loading: false,
      error: null,
      refresh: vi.fn(),
      setBaseRef: vi.fn(),
      compare: vi.fn(),
      getFileDiff: vi.fn(),
      switchBranch: vi.fn(),
      commit: vi.fn(),
      push: vi.fn(),
      createPullRequest: vi.fn(),
    });
    plansHook.mockReturnValue({
      plans: [{ id: "plan.md", title: "修复 PR", modifiedMs: 10, size: 20 }],
      selected: null,
      loading: false,
      error: null,
      refresh: vi.fn(),
      open: vi.fn(),
      close: vi.fn(),
    });
  });

  it("keeps local Git controls enabled when GitHub CLI is not authenticated", () => {
    renderSidebar();

    expect(screen.getByText("GitHub CLI认证检查 failed")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "变更" }).disabled).toBe(false);
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "切换分支" }).disabled).toBe(
      false,
    );
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "提交或推送" }).disabled).toBe(
      false,
    );
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "创建拉取请求" }).disabled).toBe(
      true,
    );
    expect(screen.getByText("修复 PR")).toBeTruthy();
  });

  it("returns to the home page when the session changes", async () => {
    gitHook.mockReturnValue({
      ...gitHook(),
      githubEnvironment: { ghInstalled: true, ghAuthenticated: true, authMessage: "" },
    });
    const user = userEvent.setup();
    const view = renderSidebar();
    await user.click(screen.getByRole("button", { name: "比较分支" }));
    expect(screen.getByRole("heading", { name: "比较分支" })).toBeTruthy();

    view.rerender(
      <ContextSidebar
        sessionId="session-2"
        workDir="C:\\repo"
        messages={[]}
        activeTab="changes"
        onTabChange={vi.fn()}
        changes={[]}
        pendingApprovals={[]}
        listDirectory={vi.fn().mockResolvedValue([])}
        getFile={vi.fn().mockResolvedValue(new Blob())}
        onApproveAll={vi.fn()}
        onRejectAll={vi.fn()}
        onGoalControl={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "上下文" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "比较分支" })).toBeNull();
  });

  it("loads a comparison file diff only after the file is selected", async () => {
    const compare = vi.fn().mockResolvedValue({
      left: "main",
      right: "topic",
      leftAhead: 1,
      rightAhead: 2,
      files: [{ path: "src/a.ts", additions: 4, deletions: 2, status: "modified" }],
      totalAdditions: 4,
      totalDeletions: 2,
    });
    const getFileDiff = vi.fn().mockResolvedValue("@@ -1 +1 @@");
    gitHook.mockReturnValue({
      ...gitHook(),
      compare,
      getFileDiff,
    });
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByRole("button", { name: "比较分支" }));
    await user.click(screen.getByRole("button", { name: "比较" }));
    await waitFor(() => expect(compare).toHaveBeenCalledWith("main", "topic"));
    expect(getFileDiff).not.toHaveBeenCalled();
    await user.click(screen.getByText("src/a.ts"));
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledWith("main", "topic", "src/a.ts"));
    expect(await screen.findByText("@@ -1 +1 @@")).toBeTruthy();
  });

  it("commits only the checked files after explicit confirmation", async () => {
    const commit = vi.fn().mockResolvedValue({ success: true });
    gitHook.mockReturnValue({
      ...gitHook(),
      commit,
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByRole("button", { name: "提交或推送" }));
    await user.type(screen.getByLabelText("提交信息"), "feat: add context sidebar");
    await user.click(screen.getByRole("button", { name: "提交 1 个文件" }));

    await waitFor(() =>
      expect(commit).toHaveBeenCalledWith(["src/a.ts"], "feat: add context sidebar"),
    );
  });
});
