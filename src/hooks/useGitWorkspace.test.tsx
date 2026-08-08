import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitEnvironment, GitHubEnvironment } from "@/lib/git-workspace";
import { useGitWorkspace } from "./useGitWorkspace";

const mocks = vi.hoisted(() => ({
  getGitEnvironment: vi.fn(),
  getGithubEnvironment: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
  commitGitChanges: vi.fn(),
  compareGitBranches: vi.fn(),
  createGithubPullRequest: vi.fn(),
  getGitComparisonFileDiff: vi.fn(),
  getGitEnvironment: mocks.getGitEnvironment,
  getGithubEnvironment: mocks.getGithubEnvironment,
  pushGitBranch: vi.fn(),
  switchGitBranch: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function gitEnvironment(branch: string): GitEnvironment {
  return {
    isGitRepo: true,
    workDir: `C:\\${branch}`,
    currentBranch: branch,
    headSha: `${branch}-sha`,
    defaultBranch: "main",
    baseRef: "main",
    localBranches: ["main", branch],
    remoteBranches: ["origin/main"],
    remotes: ["origin"],
    ahead: 0,
    behind: 0,
    dirty: false,
    status: [],
    changes: [],
    totalAdditions: 0,
    totalDeletions: 0,
  };
}

function githubEnvironment(repository: string): GitHubEnvironment {
  return {
    ghInstalled: true,
    ghAuthenticated: true,
    authMessage: "",
    hostname: "github.com",
    repository,
    defaultBranch: "main",
  };
}

describe("useGitWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes local Git without waiting for GitHub enrichment", async () => {
    const local = deferred<GitEnvironment>();
    const github = deferred<GitHubEnvironment>();
    mocks.getGitEnvironment.mockReturnValue(local.promise);
    mocks.getGithubEnvironment.mockReturnValue(github.promise);

    const { result } = renderHook(() => useGitWorkspace("session-1"));
    expect(mocks.getGitEnvironment).toHaveBeenCalledWith("session-1", undefined);
    expect(mocks.getGithubEnvironment).toHaveBeenCalledWith("session-1");

    await act(async () => local.resolve(gitEnvironment("topic")));
    await waitFor(() => expect(result.current.environment?.currentBranch).toBe("topic"));
    expect(result.current.gitLoading).toBe(false);
    expect(result.current.githubLoading).toBe(true);
    expect(result.current.githubEnvironment).toBeNull();

    await act(async () => github.resolve(githubEnvironment("owner/repo")));
    await waitFor(() => expect(result.current.githubEnvironment?.repository).toBe("owner/repo"));
  });

  it("ignores late local and GitHub responses after a session switch", async () => {
    const localOne = deferred<GitEnvironment>();
    const localTwo = deferred<GitEnvironment>();
    const githubOne = deferred<GitHubEnvironment>();
    const githubTwo = deferred<GitHubEnvironment>();
    mocks.getGitEnvironment
      .mockReturnValueOnce(localOne.promise)
      .mockReturnValueOnce(localTwo.promise);
    mocks.getGithubEnvironment
      .mockReturnValueOnce(githubOne.promise)
      .mockReturnValueOnce(githubTwo.promise);

    const { result, rerender } = renderHook(
      ({ sessionId }) => useGitWorkspace(sessionId),
      { initialProps: { sessionId: "session-1" } },
    );
    rerender({ sessionId: "session-2" });

    await act(async () => {
      localOne.resolve(gitEnvironment("stale"));
      githubOne.resolve(githubEnvironment("owner/stale"));
    });
    expect(result.current.environment).toBeNull();
    expect(result.current.githubEnvironment).toBeNull();

    await act(async () => {
      localTwo.resolve(gitEnvironment("current"));
      githubTwo.resolve(githubEnvironment("owner/current"));
    });
    await waitFor(() => expect(result.current.environment?.currentBranch).toBe("current"));
    expect(result.current.githubEnvironment?.repository).toBe("owner/current");
  });
});
