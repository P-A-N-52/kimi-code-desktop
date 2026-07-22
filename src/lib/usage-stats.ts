/**
 * Local session usage stats (Today / 7d / 30d) from wire.jsonl usage.record.
 */

export type UsageStatsRange = "today" | "7d" | "30d";

export type UsageStatsBucket = {
  requests: number;
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
  totalTokens: number;
};

export type UsageStatsSeriesPoint = UsageStatsBucket & {
  key: string;
};

export type UsageStatsModelRow = UsageStatsBucket & {
  model: string;
};

export type UsageStatsPayload = {
  range: UsageStatsRange;
  summary: UsageStatsBucket;
  series: UsageStatsSeriesPoint[];
  byModel: UsageStatsModelRow[];
  scannedFiles: number;
  recordCount: number;
  startMs: number;
  endMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(0, Math.trunc(n));
  }
  return 0;
}

function parseBucket(raw: unknown): UsageStatsBucket {
  if (!isRecord(raw)) {
    return {
      requests: 0,
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
      totalTokens: 0,
    };
  }
  const inputOther = toNumber(raw.inputOther);
  const output = toNumber(raw.output);
  const inputCacheRead = toNumber(raw.inputCacheRead);
  const inputCacheCreation = toNumber(raw.inputCacheCreation);
  const totalTokens =
    toNumber(raw.totalTokens) ||
    inputOther + output + inputCacheRead + inputCacheCreation;
  return {
    requests: toNumber(raw.requests),
    inputOther,
    output,
    inputCacheRead,
    inputCacheCreation,
    totalTokens,
  };
}

export function parseUsageStatsPayload(raw: unknown): UsageStatsPayload {
  if (!isRecord(raw)) {
    throw new Error("Invalid usage stats response");
  }
  const rangeRaw = typeof raw.range === "string" ? raw.range : "today";
  const range: UsageStatsRange =
    rangeRaw === "7d" || rangeRaw === "30d" || rangeRaw === "today" ? rangeRaw : "today";

  const series = Array.isArray(raw.series)
    ? raw.series.filter(isRecord).map((item) => ({
        key: typeof item.key === "string" ? item.key : "",
        ...parseBucket(item),
      }))
    : [];

  const byModel = Array.isArray(raw.byModel)
    ? raw.byModel.filter(isRecord).map((item) => ({
        model: typeof item.model === "string" ? item.model : "unknown",
        ...parseBucket(item),
      }))
    : [];

  return {
    range,
    summary: parseBucket(raw.summary),
    series,
    byModel,
    scannedFiles: toNumber(raw.scannedFiles),
    recordCount: toNumber(raw.recordCount),
    startMs: toNumber(raw.startMs),
    endMs: toNumber(raw.endMs),
  };
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatSeriesLabel(range: UsageStatsRange, key: string): string {
  if (range === "today") return `${key}:00`;
  // YYYY-MM-DD → MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return key.slice(5);
  return key;
}
