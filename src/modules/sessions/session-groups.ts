import type { Session } from "@/lib/api/models";

export type SessionGroup = { key: string; label: string; items: Session[] };

export type SessionGroupMode = "day" | "project";

const DAY_MS = 86400000;
const SESSION_GROUP_MODE_STORAGE_KEY = "kimi-code-desktop.session-group-mode.v1";
const SESSION_GROUP_EXPAND_STORAGE_KEY =
  "kimi-code-desktop.session-group-expand.v1";

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Normalize workDir for stable Map keys (slash unify + trim + lowercase drive). */
export function normalizeWorkDirKey(workDir?: string | null): string {
  if (!workDir) return "__default__";
  let value = workDir.trim().replace(/[\\/]+$/, "");
  if (!value) return "__default__";
  value = value.replace(/\\/g, "/");
  // Windows drive letter case-insensitive
  if (/^[a-zA-Z]:\//.test(value)) {
    value = value[0].toLowerCase() + value.slice(1);
  }
  return value;
}

function looksLikeHomeDir(normalized: string): boolean {
  return /\/(?:Users|home)\/[^/]+$/i.test(normalized);
}

export function workDirGroupLabel(workDir?: string | null): string {
  if (!workDir) return "默认目录";
  const key = normalizeWorkDirKey(workDir);
  if (key === "__default__") return "默认目录";
  if (looksLikeHomeDir(key)) return "Home";
  const parts = key.split("/");
  return parts[parts.length - 1] || workDir;
}

function disambiguateLabels(groups: SessionGroup[]): SessionGroup[] {
  const byLabel = new Map<string, SessionGroup[]>();
  for (const group of groups) {
    const list = byLabel.get(group.label) ?? [];
    list.push(group);
    byLabel.set(group.label, list);
  }
  return groups.map((group) => {
    const collisions = byLabel.get(group.label) ?? [];
    if (collisions.length < 2 || group.key === "__default__") return group;
    const parts = group.key.split("/");
    const parent = parts.length >= 2 ? parts[parts.length - 2] : group.key;
    return { ...group, label: `${group.label} (${parent})` };
  });
}

export function groupSessionsByDay(
  sessions: Session[],
  now: Date = new Date(),
): SessionGroup[] {
  const today = startOfDay(now);
  const buckets: SessionGroup[] = [
    { key: "today", label: "今天", items: [] },
    { key: "yesterday", label: "昨天", items: [] },
    { key: "week", label: "本周", items: [] },
    { key: "earlier", label: "更早", items: [] },
  ];
  for (const session of sessions) {
    const t = startOfDay(new Date(session.lastUpdated));
    const diff = today - t;
    if (diff <= 0) buckets[0].items.push(session);
    else if (diff < 2 * DAY_MS) buckets[1].items.push(session);
    else if (diff < 7 * DAY_MS) buckets[2].items.push(session);
    else buckets[3].items.push(session);
  }
  return buckets.filter((b) => b.items.length > 0);
}

export function groupSessionsByWorkDir(sessions: Session[]): SessionGroup[] {
  const buckets = new Map<string, SessionGroup>();
  for (const session of sessions) {
    const key = normalizeWorkDirKey(session.workDir);
    const existing = buckets.get(key);
    if (existing) {
      existing.items.push(session);
    } else {
      buckets.set(key, {
        key,
        label: workDirGroupLabel(session.workDir),
        items: [session],
      });
    }
  }

  const groups = Array.from(buckets.values())
    .map((group) => ({
      ...group,
      items: [...group.items].sort(
        (a, b) =>
          new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime(),
      ),
    }))
    .sort((a, b) => {
      const aLatest = a.items[0] ? new Date(a.items[0].lastUpdated).getTime() : 0;
      const bLatest = b.items[0] ? new Date(b.items[0].lastUpdated).getTime() : 0;
      if (bLatest !== aLatest) return bLatest - aLatest;
      return a.label.localeCompare(b.label, "zh");
    });

  return disambiguateLabels(groups);
}

export function readSessionGroupMode(
  storage: Pick<Storage, "getItem"> | null = typeof window !== "undefined"
    ? window.localStorage
    : null,
): SessionGroupMode {
  try {
    const raw = storage?.getItem(SESSION_GROUP_MODE_STORAGE_KEY);
    return raw === "project" ? "project" : "day";
  } catch {
    return "day";
  }
}

export function writeSessionGroupMode(
  mode: SessionGroupMode,
  storage: Pick<Storage, "setItem"> | null = typeof window !== "undefined"
    ? window.localStorage
    : null,
): void {
  try {
    storage?.setItem(SESSION_GROUP_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore quota / private-mode failures.
  }
}

export function readExpandedGroupKeys(
  storage: Pick<Storage, "getItem"> | null = typeof window !== "undefined"
    ? window.localStorage
    : null,
): Set<string> | null {
  try {
    const raw = storage?.getItem(SESSION_GROUP_EXPAND_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return null;
  }
}

export function writeExpandedGroupKeys(
  keys: Set<string>,
  storage: Pick<Storage, "setItem"> | null = typeof window !== "undefined"
    ? window.localStorage
    : null,
): void {
  try {
    storage?.setItem(SESSION_GROUP_EXPAND_STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Ignore quota / private-mode failures.
  }
}
