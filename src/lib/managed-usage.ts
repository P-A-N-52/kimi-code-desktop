/**
 * Parse and format Kimi Code managed platform usage (Weekly / 5h quotas).
 * Field handling mirrors MoonshotAI/kimi-code `packages/oauth/src/managed-usage.ts`.
 */

export type UsageRow = {
  label: string;
  used: number;
  limit: number;
  resetHint?: string;
};

export type BoosterWalletInfo = {
  balanceCents: number;
  totalCents: number;
  monthlyChargeLimitEnabled: boolean;
  monthlyChargeLimitCents: number;
  monthlyUsedCents: number;
  currency: string;
};

export type ParsedManagedUsage = {
  summary: UsageRow | null;
  limits: UsageRow[];
  extraUsage: BoosterWalletInfo | null;
};

export type ManagedUsageFetchResult =
  | { kind: "ok"; parsed: ParsedManagedUsage }
  | { kind: "error"; message: string };

export type SessionUsageContext = {
  contextUsage?: number | null;
  contextTokens?: number | null;
  maxContextTokens?: number | null;
  tokenInput?: number | null;
  tokenOutput?: number | null;
  tokenCacheRead?: number | null;
  tokenCacheCreation?: number | null;
};

export type SessionStatusContext = {
  version?: string | null;
  model?: string | null;
  workDir?: string | null;
  sessionId?: string | null;
  permissionMode?: string | null;
  planMode?: boolean | null;
  swarmMode?: boolean | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toInt(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "0s";
  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (secs && parts.length === 0) parts.push(`${secs}s`);
  return parts.length > 0 ? parts.join(" ") : "0s";
}

export function formatResetTime(val: string, nowMs = Date.now()): string {
  let normalised = val;
  if (normalised.includes(".") && normalised.endsWith("Z")) {
    const [base, frac] = normalised.slice(0, -1).split(".");
    if (base !== undefined && frac !== undefined) {
      normalised = `${base}.${frac.slice(0, 3)}Z`;
    }
  }
  const parsed = Date.parse(normalised);
  if (!Number.isFinite(parsed)) return `resets at ${val}`;
  const diffSec = Math.floor((parsed - nowMs) / 1000);
  if (diffSec <= 0) return "reset";
  return `resets in ${formatDuration(diffSec)}`;
}

function resetHintFrom(raw: Record<string, unknown>): string | undefined {
  for (const key of ["reset_at", "resetAt", "reset_time", "resetTime"]) {
    const v = raw[key];
    if (typeof v === "string" && v.length > 0) {
      return formatResetTime(v);
    }
  }
  for (const key of ["reset_in", "resetIn", "ttl", "window"]) {
    const seconds = toInt(raw[key]);
    if (seconds !== null && seconds > 0) {
      return `resets in ${formatDuration(seconds)}`;
    }
  }
  return undefined;
}

function toUsageRow(raw: unknown, defaultLabel: string): UsageRow | null {
  if (!isRecord(raw)) return null;
  const limit = toInt(raw.limit);
  let used = toInt(raw.used);
  if (used === null) {
    const remaining = toInt(raw.remaining);
    if (remaining !== null && limit !== null) {
      used = limit - remaining;
    }
  }
  if (used === null && limit === null) return null;
  const name =
    typeof raw.name === "string"
      ? raw.name
      : typeof raw.title === "string"
        ? raw.title
        : defaultLabel;
  return {
    label: name,
    used: used ?? 0,
    limit: limit ?? 0,
    resetHint: resetHintFrom(raw),
  };
}

function limitLabel(
  item: Record<string, unknown>,
  detail: Record<string, unknown>,
  window: Record<string, unknown>,
  idx: number,
): string {
  for (const key of ["name", "title", "scope"]) {
    const v = item[key] ?? detail[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  const duration = toInt(window.duration ?? item.duration ?? detail.duration);
  const rawUnit = window.timeUnit ?? item.timeUnit ?? detail.timeUnit;
  const timeUnit = typeof rawUnit === "string" ? rawUnit : "";
  if (duration !== null) {
    if (timeUnit.includes("MINUTE")) {
      if (duration >= 60 && duration % 60 === 0) return `${duration / 60}h limit`;
      return `${duration}m limit`;
    }
    if (timeUnit.includes("HOUR")) return `${duration}h limit`;
    if (timeUnit.includes("DAY")) return `${duration}d limit`;
    return `${duration}s limit`;
  }
  return `Limit #${idx + 1}`;
}

const FIXED_POINT_CENTS = 1_000_000;

function fixedPointToCents(value: number): number {
  const cents = value / FIXED_POINT_CENTS;
  if (cents > 0 && cents < 1) return 1;
  return Math.round(cents);
}

function parseMoney(raw: unknown): { cents: number; currency: string } | null {
  if (!isRecord(raw)) return null;
  const cents = toInt(raw.priceInCents);
  if (cents === null) return null;
  const currency = typeof raw.currency === "string" ? raw.currency : "";
  return { cents, currency };
}

function parseBoosterWallet(raw: unknown): BoosterWalletInfo | null {
  if (!isRecord(raw)) return null;
  const balance = raw.balance;
  if (!isRecord(balance)) return null;
  if (balance.type !== "BOOSTER") return null;
  const amountRaw = toInt(balance.amount);
  if (amountRaw === null || amountRaw <= 0) return null;
  const totalCents = fixedPointToCents(amountRaw);
  const amountLeftRaw = toInt(balance.amountLeft);
  const balanceCents =
    amountLeftRaw !== null ? fixedPointToCents(amountLeftRaw) : 0;

  const monthlyLimit = parseMoney(raw.monthlyChargeLimit);
  const monthlyUsed = parseMoney(raw.monthlyUsed);
  const monthlyChargeLimitEnabled = raw.monthlyChargeLimitEnabled === true;

  const currency =
    monthlyLimit && monthlyLimit.currency.length > 0
      ? monthlyLimit.currency
      : monthlyUsed && monthlyUsed.currency.length > 0
        ? monthlyUsed.currency
        : "USD";

  return {
    balanceCents,
    totalCents,
    monthlyChargeLimitEnabled,
    monthlyChargeLimitCents: monthlyLimit?.cents ?? 0,
    monthlyUsedCents: monthlyUsed?.cents ?? 0,
    currency,
  };
}

export function parseManagedUsagePayload(payload: unknown): ParsedManagedUsage {
  if (!isRecord(payload)) {
    return { summary: null, limits: [], extraUsage: null };
  }
  const summary = toUsageRow(payload.usage, "Weekly limit");
  const limits: UsageRow[] = [];
  const rawLimits = payload.limits;
  if (Array.isArray(rawLimits)) {
    rawLimits.forEach((item, idx) => {
      if (!isRecord(item)) return;
      const detailRaw = item.detail;
      const detail = isRecord(detailRaw) ? detailRaw : item;
      const windowRaw = item.window;
      const window = isRecord(windowRaw) ? windowRaw : {};
      const label = limitLabel(item, detail, window, idx);
      const row = toUsageRow(detail, label);
      if (row !== null) limits.push(row);
    });
  }
  return {
    summary,
    limits,
    extraUsage: parseBoosterWallet(payload.boosterWallet),
  };
}

export function parseManagedUsageFetchResult(
  raw: unknown,
): ManagedUsageFetchResult {
  if (!isRecord(raw)) {
    return { kind: "error", message: "Invalid usage response" };
  }
  if (raw.kind === "error") {
    return {
      kind: "error",
      message:
        typeof raw.message === "string" && raw.message.length > 0
          ? raw.message
          : "Failed to fetch usage",
    };
  }
  if (raw.kind === "ok") {
    return { kind: "ok", parsed: parseManagedUsagePayload(raw.payload) };
  }
  return { kind: "error", message: "Invalid usage response" };
}

function formatBar(used: number, limit: number): string {
  if (limit <= 0) return "[----------]";
  const ratio = Math.min(1, Math.max(0, used / limit));
  const filled = Math.round(ratio * 10);
  return `[${"#".repeat(filled)}${"-".repeat(10 - filled)}]`;
}

function formatUsageRow(row: UsageRow): string {
  const remainingPct =
    row.limit > 0
      ? Math.max(0, Math.round(((row.limit - row.used) / row.limit) * 100))
      : 0;
  const counts =
    row.limit > 0
      ? `${row.used.toLocaleString("en-US")} / ${row.limit.toLocaleString("en-US")}`
      : row.used.toLocaleString("en-US");
  const reset = row.resetHint ? ` (${row.resetHint})` : "";
  return `${row.label}  ${formatBar(row.used, row.limit)}  ${remainingPct}% left · ${counts}${reset}`;
}

function formatCents(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  return `${currency} ${amount}`;
}

function formatExtraUsage(extra: BoosterWalletInfo): string[] {
  const lines = ["Extra Usage:"];
  if (extra.monthlyChargeLimitEnabled && extra.monthlyChargeLimitCents > 0) {
    lines.push(
      `  Monthly used  ${formatCents(extra.monthlyUsedCents, extra.currency)} / ${formatCents(extra.monthlyChargeLimitCents, extra.currency)}`,
    );
  } else {
    lines.push(
      `  Monthly used  ${formatCents(extra.monthlyUsedCents, extra.currency)} / Unlimited`,
    );
  }
  lines.push(
    `  Balance       ${formatCents(extra.balanceCents, extra.currency)}`,
  );
  return lines;
}

function formatQuotaBlock(parsed: ParsedManagedUsage | null, error?: string): string[] {
  const lines: string[] = ["Plan quotas:"];
  if (error) {
    lines.push(`  (unavailable) ${error}`);
    return lines;
  }
  if (!parsed) {
    lines.push("  (unavailable)");
    return lines;
  }
  if (parsed.summary) {
    lines.push(`  ${formatUsageRow(parsed.summary)}`);
  }
  for (const limit of parsed.limits) {
    lines.push(`  ${formatUsageRow(limit)}`);
  }
  if (!parsed.summary && parsed.limits.length === 0) {
    lines.push("  No quota data returned for this account.");
  }
  if (parsed.extraUsage) {
    lines.push(...formatExtraUsage(parsed.extraUsage));
  }
  return lines;
}

function formatContextLine(session: SessionUsageContext): string | null {
  const tokens =
    typeof session.contextTokens === "number" &&
    typeof session.maxContextTokens === "number" &&
    session.maxContextTokens > 0
      ? `${session.contextTokens.toLocaleString("en-US")} / ${session.maxContextTokens.toLocaleString("en-US")}`
      : null;
  const pct =
    typeof session.contextUsage === "number"
      ? ` (${Math.round(session.contextUsage * 1000) / 10}%)`
      : "";
  if (tokens) return `Context: ${tokens}${pct}`;
  if (typeof session.contextUsage === "number") {
    return `Context: ${Math.round(session.contextUsage * 1000) / 10}%`;
  }
  return null;
}

function formatTokenLine(session: SessionUsageContext): string | null {
  const parts: string[] = [];
  if (typeof session.tokenInput === "number") {
    parts.push(`input ${session.tokenInput.toLocaleString("en-US")}`);
  }
  if (typeof session.tokenOutput === "number") {
    parts.push(`output ${session.tokenOutput.toLocaleString("en-US")}`);
  }
  if (typeof session.tokenCacheRead === "number") {
    parts.push(`cache read ${session.tokenCacheRead.toLocaleString("en-US")}`);
  }
  if (typeof session.tokenCacheCreation === "number") {
    parts.push(
      `cache creation ${session.tokenCacheCreation.toLocaleString("en-US")}`,
    );
  }
  return parts.length > 0 ? `Tokens: ${parts.join(", ")}` : null;
}

export function formatUsageReport(args: {
  managed: ManagedUsageFetchResult;
  session?: SessionUsageContext;
}): string {
  const lines = ["Usage"];
  if (args.managed.kind === "ok") {
    lines.push(...formatQuotaBlock(args.managed.parsed));
  } else {
    lines.push(...formatQuotaBlock(null, args.managed.message));
  }
  const session = args.session ?? {};
  const tokenLine = formatTokenLine(session);
  const contextLine = formatContextLine(session);
  if (tokenLine || contextLine) {
    lines.push("Session:");
    if (tokenLine) lines.push(`  ${tokenLine}`);
    if (contextLine) lines.push(`  ${contextLine}`);
  }
  return lines.join("\n");
}

export function formatStatusReport(args: {
  managed: ManagedUsageFetchResult;
  status: SessionStatusContext;
  session?: SessionUsageContext;
}): string {
  const lines = ["Status"];
  const { status } = args;
  if (status.version) lines.push(`Version: ${status.version}`);
  if (status.model) lines.push(`Model: ${status.model}`);
  if (status.workDir) lines.push(`Work dir: ${status.workDir}`);
  if (status.sessionId) lines.push(`Session: ${status.sessionId}`);
  if (status.permissionMode) lines.push(`Permission: ${status.permissionMode}`);
  if (typeof status.planMode === "boolean") {
    lines.push(`Plan mode: ${status.planMode ? "on" : "off"}`);
  }
  if (typeof status.swarmMode === "boolean") {
    lines.push(`Swarm mode: ${status.swarmMode ? "on" : "off"}`);
  }
  const contextLine = formatContextLine(args.session ?? {});
  if (contextLine) lines.push(contextLine);

  if (args.managed.kind === "ok") {
    lines.push(...formatQuotaBlock(args.managed.parsed));
  } else {
    lines.push(...formatQuotaBlock(null, args.managed.message));
  }
  return lines.join("\n");
}
