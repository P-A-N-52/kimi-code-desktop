/** Check desktop + Kimi Code CLI against their GitHub latest releases. */

export const DESKTOP_RELEASES_API =
  "https://api.github.com/repos/P-A-N-52/kimi-code-desktop/releases/latest";
export const DESKTOP_DOWNLOAD_FALLBACK =
  "https://github.com/P-A-N-52/kimi-code-desktop/releases/latest";

export const CLI_RELEASES_API =
  "https://api.github.com/repos/MoonshotAI/kimi-code/releases/latest";
export const CLI_DOWNLOAD_FALLBACK =
  "https://github.com/MoonshotAI/kimi-code/releases/latest";

export type UpdateCheckStatus =
  | "unknown"
  | "checking"
  | "up-to-date"
  | "update-available"
  | "error";

export type ComponentUpdateResult = {
  label: string;
  current: string;
  latest: string | null;
  status: UpdateCheckStatus;
  downloadUrl: string;
  message: string;
};

export type UpdatesCheckResult = {
  desktop: ComponentUpdateResult;
  cli: ComponentUpdateResult;
};

/** Strip `v` / package-name prefixes; keep trailing semver-ish core. */
export function normalizeVersion(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "—" || trimmed === "dev") return null;

  // `@moonshot-ai/kimi-code@0.29.1` or `v0.1.11`
  const at = trimmed.lastIndexOf("@");
  const candidate =
    at >= 0 && at < trimmed.length - 1 ? trimmed.slice(at + 1) : trimmed;
  const withoutV = candidate.replace(/^v/i, "").trim();
  const match = withoutV.match(/^(\d+(?:\.\d+){0,3})/);
  return match?.[1] ?? null;
}

/** Compare dotted numeric versions. Returns >0 if a>b, <0 if a<b, 0 if equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

type GithubLatestRelease = {
  tag_name?: string;
  html_url?: string;
  prerelease?: boolean;
  draft?: boolean;
};

async function fetchGithubLatest(
  apiUrl: string,
): Promise<{ tag: string; htmlUrl: string }> {
  const response = await fetch(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      // GitHub rejects anonymous requests without a UA in some environments.
      "User-Agent": "kimi-code-desktop-update-check",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub ${response.status}`);
  }
  const data = (await response.json()) as GithubLatestRelease;
  if (data.draft || data.prerelease) {
    throw new Error("Latest release is draft/prerelease");
  }
  const tag = typeof data.tag_name === "string" ? data.tag_name.trim() : "";
  if (!tag) throw new Error("Missing tag_name");
  const htmlUrl =
    typeof data.html_url === "string" && data.html_url.trim()
      ? data.html_url.trim()
      : "";
  return { tag, htmlUrl };
}

function buildResult(args: {
  label: string;
  currentRaw: string;
  latestTag: string | null;
  downloadUrl: string;
  fallbackUrl: string;
  error?: string;
}): ComponentUpdateResult {
  const currentNorm = normalizeVersion(args.currentRaw);
  const latestNorm = args.latestTag ? normalizeVersion(args.latestTag) : null;
  const downloadUrl = args.downloadUrl || args.fallbackUrl;

  if (args.error) {
    return {
      label: args.label,
      current: args.currentRaw,
      latest: null,
      status: "error",
      downloadUrl,
      message: args.error,
    };
  }
  if (!currentNorm) {
    return {
      label: args.label,
      current: args.currentRaw,
      latest: latestNorm,
      status: "unknown",
      downloadUrl,
      message: "无法解析当前版本",
    };
  }
  if (!latestNorm) {
    return {
      label: args.label,
      current: args.currentRaw,
      latest: null,
      status: "error",
      downloadUrl,
      message: "无法解析最新版本",
    };
  }
  if (compareVersions(latestNorm, currentNorm) > 0) {
    return {
      label: args.label,
      current: args.currentRaw,
      latest: latestNorm,
      status: "update-available",
      downloadUrl,
      message: `发现新版本 ${latestNorm}`,
    };
  }
  return {
    label: args.label,
    current: args.currentRaw,
    latest: latestNorm,
    status: "up-to-date",
    downloadUrl,
    message: "已是最新",
  };
}

export async function checkDesktopUpdate(
  currentVersion: string,
): Promise<ComponentUpdateResult> {
  try {
    const latest = await fetchGithubLatest(DESKTOP_RELEASES_API);
    return buildResult({
      label: "桌面版",
      currentRaw: currentVersion,
      latestTag: latest.tag,
      downloadUrl: latest.htmlUrl || DESKTOP_DOWNLOAD_FALLBACK,
      fallbackUrl: DESKTOP_DOWNLOAD_FALLBACK,
    });
  } catch (error) {
    return buildResult({
      label: "桌面版",
      currentRaw: currentVersion,
      latestTag: null,
      downloadUrl: DESKTOP_DOWNLOAD_FALLBACK,
      fallbackUrl: DESKTOP_DOWNLOAD_FALLBACK,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function checkCliUpdate(
  currentVersion: string,
): Promise<ComponentUpdateResult> {
  try {
    const latest = await fetchGithubLatest(CLI_RELEASES_API);
    return buildResult({
      label: "Kimi Code CLI",
      currentRaw: currentVersion,
      latestTag: latest.tag,
      downloadUrl: latest.htmlUrl || CLI_DOWNLOAD_FALLBACK,
      fallbackUrl: CLI_DOWNLOAD_FALLBACK,
    });
  } catch (error) {
    return buildResult({
      label: "Kimi Code CLI",
      currentRaw: currentVersion,
      latestTag: null,
      downloadUrl: CLI_DOWNLOAD_FALLBACK,
      fallbackUrl: CLI_DOWNLOAD_FALLBACK,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function checkAllUpdates(args: {
  desktopVersion: string;
  cliVersion: string;
}): Promise<UpdatesCheckResult> {
  const [desktop, cli] = await Promise.all([
    checkDesktopUpdate(args.desktopVersion),
    checkCliUpdate(args.cliVersion),
  ]);
  return { desktop, cli };
}
