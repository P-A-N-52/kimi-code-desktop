import { describe, expect, it } from "vitest";
import {
  normalizeGitAction,
  normalizeGitComparison,
  normalizeGitEnvironment,
  normalizeGitHubEnvironment,
} from "./git-workspace";

describe("git workspace normalizers", () => {
  it("normalizes backend snake_case without trusting missing values", () => {
    const environment = normalizeGitEnvironment({
      is_git_repo: true,
      current_branch: "feature/sidebar",
      head_sha: "abc123",
      local_branches: ["main", "feature/sidebar"],
      status: [{ path: "-odd name.txt", index_status: "?", worktree_status: "?", untracked: true }],
      changes: [{ path: "src/a.ts", additions: 3, deletions: 1, status: "modified" }],
    });

    expect(environment).toMatchObject({
      isGitRepo: true,
      currentBranch: "feature/sidebar",
      dirty: false,
    });
    expect(environment.status[0]).toMatchObject({ path: "-odd name.txt", untracked: true });

    expect(
      normalizeGitHubEnvironment({
        gh_installed: true,
        gh_authenticated: false,
        auth_message: "GitHub CLI认证检查 failed",
        hostname: "github.com",
      }),
    ).toEqual({
      ghInstalled: true,
      ghAuthenticated: false,
      authMessage: "GitHub CLI认证检查 failed",
      hostname: "github.com",
      repository: undefined,
      defaultBranch: undefined,
    });
  });

  it("normalizes comparisons and mutation results", () => {
    expect(
      normalizeGitComparison({ left: "main", right: "topic", left_ahead: 1, right_ahead: 2 }),
    ).toMatchObject({ left: "main", right: "topic", leftAhead: 1, rightAhead: 2, files: [] });
    expect(
      normalizeGitAction({
        success: true,
        head_sha: "def456",
        url: "https://github.com/o/r/pull/1",
      }),
    ).toEqual({
      success: true,
      headSha: "def456",
      branch: undefined,
      summary: undefined,
      url: "https://github.com/o/r/pull/1",
    });
  });
});
