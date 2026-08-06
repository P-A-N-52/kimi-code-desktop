import type { LiveMessage } from "@/hooks/types";
import type { GitDiffStats } from "@/lib/api/models";
import { type DiffDisplayData, findDiffDisplay } from "@/modules/conversation/diff-display";
import { computeDiffLines } from "@/modules/conversation/diff-view";

export type ChangeEntry = {
  path: string;
  adds: number;
  dels: number;
  status?: "added" | "modified" | "deleted" | "renamed";
  display?: DiffDisplayData;
};

type Stats = { adds: number; dels: number };
type ToolDisplay = NonNullable<NonNullable<LiveMessage["toolCall"]>["display"]>;
type CachedDiff = {
  display: ToolDisplay;
  diff: DiffDisplayData | null;
  stats?: Stats;
};

const DERIVED_DIFF_CACHE_LIMIT = 200;
const derivedDiffCache = new Map<string, CachedDiff>();

function defaultStats(display: DiffDisplayData): Stats {
  const { adds, dels } = computeDiffLines(display);
  return { adds, dels };
}

function getCachedDiff(message: LiveMessage, display: ToolDisplay): CachedDiff {
  const cached = derivedDiffCache.get(message.id);
  if (cached?.display === display) return cached;

  const next = { display, diff: findDiffDisplay(display) };
  if (derivedDiffCache.size >= DERIVED_DIFF_CACHE_LIMIT) derivedDiffCache.clear();
  derivedDiffCache.set(message.id, next);
  return next;
}

export function deriveChanges(
  messages: LiveMessage[],
  computeStats: (display: DiffDisplayData) => Stats = defaultStats,
): ChangeEntry[] {
  const byPath = new Map<string, ChangeEntry>();
  const useCachedStats = computeStats === defaultStats;
  for (const message of messages) {
    const display = message.toolCall?.display;
    if (!display) continue;
    const cached = getCachedDiff(message, display);
    const diff = cached.diff;
    if (!diff || !diff.path) continue;
    if (byPath.has(diff.path)) byPath.delete(diff.path);
    let stats: Stats;
    if (useCachedStats) {
      if (!cached.stats) cached.stats = defaultStats(diff);
      stats = cached.stats;
    } else {
      stats = computeStats(diff);
    }
    byPath.set(diff.path, {
      path: diff.path,
      ...stats,
      display: diff,
    });
  }
  return [...byPath.values()];
}

export function mergeGitChanges(
  semanticChanges: ChangeEntry[],
  stats: GitDiffStats | null,
): ChangeEntry[] {
  if (!stats?.isGitRepo || !stats.files) return semanticChanges;
  const semanticByPath = new Map(semanticChanges.map((change) => [change.path, change]));
  return stats.files.map((file) => ({
    path: file.path,
    adds: file.additions,
    dels: file.deletions,
    status: file.status,
    display: semanticByPath.get(file.path)?.display,
  }));
}

export type PendingApproval = {
  id: string;
  toolCallId?: string;
  description: string;
  /** Tool card title / action — used to decide YOLO auto-approve vs notify. */
  toolTitle?: string;
  toolKind?: string | null;
};

export function derivePendingApprovals(messages: LiveMessage[]): PendingApproval[] {
  const list: PendingApproval[] = [];
  for (const message of messages) {
    const tc = message.toolCall;
    if (tc?.state !== "approval-requested" || !tc.approval) continue;
    if (tc.approval.submitted || tc.approval.resolved) continue;
    list.push({
      id: tc.approval.id,
      toolCallId: tc.approval.toolCallId,
      description: tc.approval.description || tc.approval.action,
      toolTitle: tc.title || tc.approval.action,
      toolKind: tc.approval.toolKind ?? null,
    });
  }
  return list;
}
