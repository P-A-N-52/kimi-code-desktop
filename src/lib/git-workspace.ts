export type GitChange = {
  path: string;
  additions: number;
  deletions: number;
  status: string;
};

export type GitStatusEntry = {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  untracked: boolean;
};

export type GitEnvironment = {
  isGitRepo: boolean;
  workDir?: string;
  currentBranch: string;
  headSha: string;
  defaultBranch?: string;
  baseRef: string;
  localBranches: string[];
  remoteBranches: string[];
  remotes: string[];
  upstream?: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  status: GitStatusEntry[];
  changes: GitChange[];
  totalAdditions: number;
  totalDeletions: number;
};

export type GitHubEnvironment = {
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  authMessage: string;
  hostname?: string;
  repository?: string;
  defaultBranch?: string;
};

export type GitComparison = {
  left: string;
  right: string;
  leftAhead: number;
  rightAhead: number;
  files: GitChange[];
  totalAdditions: number;
  totalDeletions: number;
};

export type GitActionResult = {
  success: boolean;
  headSha?: string;
  branch?: string;
  summary?: string;
  url?: string;
};

export type SessionPlan = {
  id: string;
  title: string;
  modifiedMs: number;
  size: number;
  content?: string;
};

function change(raw: Record<string, unknown>): GitChange {
  return {
    path: String(raw.path ?? ""),
    additions: Number(raw.additions ?? 0),
    deletions: Number(raw.deletions ?? 0),
    status: String(raw.status ?? "modified"),
  };
}

export function normalizeGitEnvironment(raw: Record<string, unknown>): GitEnvironment {
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.map((item) => String(item)) : [];
  const optionalString = (value: unknown) =>
    typeof value === "string" && value ? value : undefined;
  return {
    isGitRepo: Boolean(raw.is_git_repo),
    workDir: optionalString(raw.work_dir),
    currentBranch: String(raw.current_branch ?? ""),
    headSha: String(raw.head_sha ?? ""),
    defaultBranch: optionalString(raw.default_branch),
    baseRef: String(raw.base_ref ?? ""),
    localBranches: strings(raw.local_branches),
    remoteBranches: strings(raw.remote_branches),
    remotes: strings(raw.remotes),
    upstream: optionalString(raw.upstream),
    ahead: Number(raw.ahead ?? 0),
    behind: Number(raw.behind ?? 0),
    dirty: Boolean(raw.dirty),
    status: Array.isArray(raw.status)
      ? raw.status.map((item) => {
          const entry = item as Record<string, unknown>;
          return {
            path: String(entry.path ?? ""),
            indexStatus: String(entry.index_status ?? " "),
            worktreeStatus: String(entry.worktree_status ?? " "),
            untracked: Boolean(entry.untracked),
          };
        })
      : [],
    changes: Array.isArray(raw.changes)
      ? raw.changes.map((item) => change(item as Record<string, unknown>))
      : [],
    totalAdditions: Number(raw.total_additions ?? 0),
    totalDeletions: Number(raw.total_deletions ?? 0),
  };
}

export function normalizeGitHubEnvironment(raw: Record<string, unknown>): GitHubEnvironment {
  const optionalString = (value: unknown) =>
    typeof value === "string" && value ? value : undefined;
  return {
    ghInstalled: Boolean(raw.gh_installed),
    ghAuthenticated: Boolean(raw.gh_authenticated),
    authMessage: String(raw.auth_message ?? ""),
    hostname: optionalString(raw.hostname),
    repository: optionalString(raw.repository),
    defaultBranch: optionalString(raw.default_branch),
  };
}

export function normalizeGitComparison(raw: Record<string, unknown>): GitComparison {
  return {
    left: String(raw.left ?? ""),
    right: String(raw.right ?? ""),
    leftAhead: Number(raw.left_ahead ?? 0),
    rightAhead: Number(raw.right_ahead ?? 0),
    files: Array.isArray(raw.files)
      ? raw.files.map((item) => change(item as Record<string, unknown>))
      : [],
    totalAdditions: Number(raw.total_additions ?? 0),
    totalDeletions: Number(raw.total_deletions ?? 0),
  };
}

export function normalizeGitAction(raw: Record<string, unknown>): GitActionResult {
  return {
    success: Boolean(raw.success),
    headSha: typeof raw.head_sha === "string" ? raw.head_sha : undefined,
    branch: typeof raw.branch === "string" ? raw.branch : undefined,
    summary: typeof raw.summary === "string" ? raw.summary : undefined,
    url: typeof raw.url === "string" ? raw.url : undefined,
  };
}
