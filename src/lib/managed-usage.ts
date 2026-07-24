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
  /** Model id shown in Session usage (e.g. kimi-code/kimi-for-coding). */
  modelLabel?: string | null;
  tokenInput?: number | null;
  tokenOutput?: number | null;
  tokenCacheRead?: number | null;
  tokenCacheCreation?: number | null;
};

export type SessionStatusContext = {
  version?: string | null;
  model?: string | null;
  /** Display name override (falls back to model). */
  modelDisplayName?: string | null;
  workDir?: string | null;
  sessionId?: string | null;
  sessionTitle?: string | null;
  permissionMode?: string | null;
  planMode?: boolean | null;
  swarmMode?: boolean | null;
  /** Thinking effort label: on / off / high / … */
  thinkingEffort?: string | null;
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

/** 1024-based compact token count — matches Kimi Code TUI `formatTokenCount`. */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1024 * 1024) {
    const v = n / (1024 * 1024);
    const s = v.toFixed(1);
    return `${s.endsWith(".0") ? s.slice(0, -2) : s}M`;
  }
  if (n >= 1024) {
    const k = n / 1024;
    const rounded = k >= 100 ? Math.round(k) : Number(k.toFixed(1));
    const s = String(rounded);
    return `${s.endsWith(".0") ? s.slice(0, -2) : s}k`;
  }
  return String(n);
}

export function usagePercent(used: number, max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.ceil((used / max) * 100)));
}

export function renderProgressBar(
  ratio: number,
  width = 20,
  filled = "█",
  empty = "░",
): string {
  const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(ratio, 1)) : 0;
  const filledCount = Math.round(clamped * width);
  return filled.repeat(filledCount) + empty.repeat(Math.max(0, width - filledCount));
}

function usedRatio(row: UsageRow): number {
  return row.limit > 0 ? Math.max(0, Math.min(row.used / row.limit, 1)) : 0;
}

function currencySymbol(currency: string): string {
  switch (currency.toUpperCase()) {
    case "CNY":
      return "¥";
    case "USD":
      return "$";
    default:
      return "";
  }
}

function formatMoney(cents: number, currency: string): string {
  const symbol = currencySymbol(currency);
  const amount = (cents / 100).toFixed(2);
  return symbol ? `${symbol}${amount}` : `${amount} ${currency}`;
}

function formatExtraUsageSection(extra: BoosterWalletInfo): string[] {
  const hasMonthlyLimit =
    extra.monthlyChargeLimitEnabled && extra.monthlyChargeLimitCents > 0;
  const lines: string[] = ["Extra Usage"];
  if (hasMonthlyLimit) {
    const ratio = Math.max(
      0,
      Math.min(extra.monthlyUsedCents / extra.monthlyChargeLimitCents, 1),
    );
    lines.push(`  ${renderProgressBar(ratio, 20)}`);
  }
  const rows: Array<{ label: string; value: string }> = [
    {
      label: "Used this month",
      value: formatMoney(extra.monthlyUsedCents, extra.currency),
    },
    {
      label: "Monthly limit",
      value: hasMonthlyLimit
        ? formatMoney(extra.monthlyChargeLimitCents, extra.currency)
        : "Unlimited",
    },
    {
      label: "Balance",
      value: formatMoney(extra.balanceCents, extra.currency),
    },
  ];
  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  for (const row of rows) {
    lines.push(`  ${row.label.padEnd(labelWidth, " ")} ${row.value}`);
  }
  return lines;
}

function formatPlanUsageSection(
  parsed: ParsedManagedUsage | null,
  error?: string,
): string[] {
  if (error) {
    // Align with CLI: non-managed / unavailable → platform-only copy; keep auth hints as-is.
    const message =
      /not available|non-managed|unavailable|only available/i.test(error) &&
      !/login|auth|sign.?in/i.test(error)
        ? "Usage is available on Kimi Code platform only."
        : error;
    return ["Plan usage", `  ${message}`];
  }
  if (!parsed) {
    return ["Plan usage", "  Usage is available on Kimi Code platform only."];
  }
  const rows: UsageRow[] = [];
  if (parsed.summary) rows.push(parsed.summary);
  rows.push(...parsed.limits);
  if (rows.length === 0) {
    return ["Plan usage", "  No usage data available."];
  }
  const labelWidth = Math.max(10, ...rows.map((r) => r.label.length));
  const pctWidth = Math.max(
    ...rows.map((r) => `${Math.round(usedRatio(r) * 100)}% used`.length),
  );
  const lines: string[] = ["Plan usage"];
  for (const row of rows) {
    const ratio = usedRatio(row);
    const pct = `${Math.round(ratio * 100)}% used`;
    const reset = row.resetHint ? `  ${row.resetHint}` : "";
    lines.push(
      `  ${row.label.padEnd(labelWidth, " ")} ${renderProgressBar(ratio, 20)} ${pct.padEnd(pctWidth, " ")}${reset}`,
    );
  }
  if (parsed.extraUsage) {
    lines.push("");
    lines.push(...formatExtraUsageSection(parsed.extraUsage));
  }
  return lines;
}

function formatContextWindowSection(session: SessionUsageContext): string[] {
  const maxTokens =
    typeof session.maxContextTokens === "number" ? session.maxContextTokens : 0;
  if (maxTokens <= 0) {
    return ["Context window", "  No context window data available."];
  }
  const tokens =
    typeof session.contextTokens === "number" ? Math.max(0, session.contextTokens) : 0;
  const ratio =
    typeof session.contextUsage === "number" && Number.isFinite(session.contextUsage)
      ? Math.max(0, Math.min(session.contextUsage, 1))
      : tokens / maxTokens;
  const pct = usagePercent(tokens, maxTokens);
  const pctText = `${pct}%`.padStart(6, " ");
  return [
    "Context window",
    `  ${renderProgressBar(ratio, 20)} ${pctText}  (${formatTokenCount(tokens)} / ${formatTokenCount(maxTokens)})`,
  ];
}

function sessionInputTotal(session: SessionUsageContext): number {
  return (
    Math.max(0, session.tokenInput ?? 0) +
    Math.max(0, session.tokenCacheRead ?? 0) +
    Math.max(0, session.tokenCacheCreation ?? 0)
  );
}

function formatSessionUsageSection(session: SessionUsageContext): string[] {
  const lines: string[] = ["Session usage"];
  const input = sessionInputTotal(session);
  const output = Math.max(0, session.tokenOutput ?? 0);
  if (input <= 0 && output <= 0) {
    lines.push("  No token usage recorded yet.");
    return lines;
  }
  const model = (session.modelLabel ?? "model").trim() || "model";
  lines.push(
    `  ${model}  input ${formatTokenCount(input)}  output ${formatTokenCount(output)}  total ${formatTokenCount(input + output)}`,
  );
  return lines;
}

function formatModelStatusLine(status: SessionStatusContext): string {
  const model =
    (status.modelDisplayName ?? status.model ?? "").trim() || "not set";
  if (model === "not set") return model;
  const effort = (status.thinkingEffort ?? "off").trim() || "off";
  return `${model} (thinking ${effort})`;
}

export function formatUsageReport(args: {
  managed: ManagedUsageFetchResult;
  session?: SessionUsageContext;
}): string {
  const session = args.session ?? {};
  const lines: string[] = [...formatSessionUsageSection(session), ""];
  lines.push(...formatContextWindowSection(session));

  const managedSection =
    args.managed.kind === "ok"
      ? formatPlanUsageSection(args.managed.parsed)
      : formatPlanUsageSection(null, args.managed.message);
  if (managedSection.length > 0) {
    lines.push("");
    lines.push(...managedSection);
  }
  return lines.join("\n");
}

export function formatStatusReport(args: {
  managed: ManagedUsageFetchResult;
  status: SessionStatusContext;
  session?: SessionUsageContext;
}): string {
  const { status } = args;
  const version = (status.version ?? "").trim() || "?";
  const rows: Array<{ label: string; value: string }> = [
    { label: "Model", value: formatModelStatusLine(status) },
    { label: "Directory", value: (status.workDir ?? "").trim() || "—" },
    { label: "Permissions", value: (status.permissionMode ?? "manual").trim() },
    {
      label: "Plan mode",
      value: status.planMode ? "on" : "off",
    },
    {
      label: "Session",
      value: (status.sessionId ?? "").trim() || "none",
    },
  ];
  const title = status.sessionTitle?.trim();
  if (title) rows.push({ label: "Title", value: title });

  const labelWidth = Math.max(10, ...rows.map((r) => r.label.length));
  const lines: string[] = [`>_ Kimi Code (v${version})`, ""];
  for (const row of rows) {
    lines.push(`  ${row.label.padEnd(labelWidth, " ")} ${row.value}`);
  }

  lines.push("");
  lines.push(...formatContextWindowSection(args.session ?? {}));

  const managedSection =
    args.managed.kind === "ok"
      ? formatPlanUsageSection(args.managed.parsed)
      : formatPlanUsageSection(null, args.managed.message);
  if (managedSection.length > 0) {
    lines.push("");
    lines.push(...managedSection);
  }
  return lines.join("\n");
}

