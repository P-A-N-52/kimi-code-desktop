import { describe, expect, it } from "vitest";
import {
  normalizeGitAction,
  normalizeGitComparison,
  normalizeGitEnvironment,
} from "./git-workspace";

describe("git workspace normalizers", () => {
  it("normalizes backend snake_case without trusting missing values", () => {
    const environment = normalizeGitEnvironment({
      is_git_repo: true,
      gh_authenticated: false,
      auth_message: "Github CLI未登录",
      current_branch: "feature/sidebar",
      head_sha: "abc123",
      local_branches: ["main", "feature/sidebar"],
      status: [{ path: "-odd name.txt", index_status: "?", worktree_status: "?", untracked: true }],
      changes: [{ path: "src/a.ts", additions: 3, deletions: 1, status: "modified" }],
    });

    expect(environment).toMatchObject({
      isGitRepo: true,
      ghAuthenticated: false,
      authMessage: "Github CLI未登录",
      currentBranch: "feature/sidebar",
      dirty: false,
    });
    expect(environment.status[0]).toMatchObject({ path: "-odd name.txt", untracked: true });
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
