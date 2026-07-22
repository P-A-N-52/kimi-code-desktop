import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchManagedUsage,
  fetchUsageStats,
} from "@/lib/tauri-api";
import {
  parseManagedUsageFetchResult,
  type ManagedUsageFetchResult,
  type ParsedManagedUsage,
  type UsageRow,
} from "@/lib/managed-usage";
import {
  formatCount,
  formatSeriesLabel,
  parseUsageStatsPayload,
  type UsageStatsPayload,
  type UsageStatsRange,
} from "@/lib/usage-stats";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";

const RANGES: Array<{ id: UsageStatsRange; label: string }> = [
  { id: "today", label: "今日" },
  { id: "7d", label: "7 天" },
  { id: "30d", label: "30 天" },
];

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-faint">{label}</div>
      <div className="mt-0.5 truncate font-mono text-[13px] text-bright">{value}</div>
    </div>
  );
}

function QuotaBar({ row }: { row: UsageRow }) {
  const pct =
    row.limit > 0 ? Math.min(100, Math.round((row.used / row.limit) * 100)) : 0;
  const left =
    row.limit > 0
      ? Math.max(0, Math.round(((row.limit - row.used) / row.limit) * 100))
      : 0;
  return (
    <div className="mb-2.5">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-foreground">{row.label}</span>
        <span className="font-mono text-[10.5px] text-faint">
          {formatCount(row.used)} / {formatCount(row.limit)} · {left}% left
          {row.resetHint ? ` · ${row.resetHint}` : ""}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-line">
        <div
          className="h-full rounded-full bg-bright/70"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function TrendChart({
  range,
  series,
}: {
  range: UsageStatsRange;
  series: UsageStatsPayload["series"];
}) {
  const max = Math.max(1, ...series.map((p) => p.totalTokens));
  const width = 640;
  const height = 120;
  const padX = 8;
  const padY = 10;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const n = Math.max(1, series.length);
  const step = innerW / n;

  const points = series
    .map((p, i) => {
      const x = padX + step * (i + 0.5);
      const y = padY + innerH * (1 - p.totalTokens / max);
      return `${x},${y}`;
    })
    .join(" ");

  const labelEvery =
    range === "today" ? 3 : range === "7d" ? 1 : Math.ceil(series.length / 8);

  return (
    <div className="overflow-hidden rounded-r2 border border-line bg-background/40 p-2">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-28 w-full">
        <title>Token 用量趋势</title>
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-bright/80"
          points={points}
        />
        {series.map((p, i) => {
          if (i % labelEvery !== 0 && i !== series.length - 1) return null;
          const x = padX + step * (i + 0.5);
          return (
            <text
              key={p.key}
              x={x}
              y={height - 2}
              textAnchor="middle"
              className="fill-current text-[9px] text-faint"
            >
              {formatSeriesLabel(range, p.key)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

function PlanQuotaBlock({ managed }: { managed: ManagedUsageFetchResult | null }) {
  if (!managed) {
    return <p className="font-mono text-[11px] text-faint">额度加载中…</p>;
  }
  if (managed.kind === "error") {
    return (
      <p className="font-mono text-[11px] text-faint">
        当前额度不可用：{managed.message}
      </p>
    );
  }
  const parsed: ParsedManagedUsage = managed.parsed;
  const rows: UsageRow[] = [];
  if (parsed.summary) rows.push(parsed.summary);
  rows.push(...parsed.limits);
  if (rows.length === 0 && !parsed.extraUsage) {
    return (
      <p className="font-mono text-[11px] text-faint">账号未返回配额数据</p>
    );
  }
  return (
    <div>
      {rows.map((row) => (
        <QuotaBar key={row.label} row={row} />
      ))}
      {parsed.extraUsage && (
        <p className="mt-1 font-mono text-[10.5px] text-faint">
          Extra Usage 本月{" "}
          {(parsed.extraUsage.monthlyUsedCents / 100).toFixed(2)}{" "}
          {parsed.extraUsage.currency}
          {parsed.extraUsage.monthlyChargeLimitEnabled
            ? ` / ${(parsed.extraUsage.monthlyChargeLimitCents / 100).toFixed(2)}`
            : " / Unlimited"}
          · 余额 {(parsed.extraUsage.balanceCents / 100).toFixed(2)}
        </p>
      )}
    </div>
  );
}

export function UsagePanel({ enabled }: { enabled: boolean }) {
  const [range, setRange] = useState<UsageStatsRange>("today");
  const [stats, setStats] = useState<UsageStatsPayload | null>(null);
  const [managed, setManaged] = useState<ManagedUsageFetchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async (nextRange: UsageStatsRange) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const [statsRaw, managedRaw] = await Promise.all([
        fetchUsageStats(nextRange),
        fetchManagedUsage(),
      ]);
      if (requestId !== requestIdRef.current) return;
      setStats(parseUsageStatsPayload(statsRaw));
      setManaged(parseManagedUsageFetchResult(managedRaw));
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setStats(null);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      requestIdRef.current += 1;
      setLoading(false);
      return;
    }
    void load(range);
  }, [enabled, range, load]);

  const summary = stats?.summary;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-r2 border border-line p-0.5">
          {RANGES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setRange(item.id)}
              className={cn(
                "rounded-r1 px-2.5 py-1 text-[12px] transition-colors",
                range === item.id
                  ? "bg-active text-bright"
                  : "text-muted hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          className="ml-auto"
          disabled={loading}
          onClick={() => void load(range)}
        >
          {loading ? "刷新中…" : "刷新"}
        </Button>
      </div>

      {error && (
        <p className="whitespace-pre-wrap font-mono text-[11px] text-danger">{error}</p>
      )}

      <section>
        <div className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-faint">
          本地 Token 用量
        </div>
        {loading && !stats ? (
          <p className="font-mono text-[11px] text-faint">扫描会话记录中…</p>
        ) : summary && summary.requests > 0 ? (
          <>
            <div className="mb-3 grid grid-cols-3 gap-3 sm:grid-cols-6">
              <Metric label="请求" value={formatCount(summary.requests)} />
              <Metric label="总 Tokens" value={formatCount(summary.totalTokens)} />
              <Metric label="Input" value={formatCount(summary.inputOther)} />
              <Metric label="Output" value={formatCount(summary.output)} />
              <Metric label="Cache 读" value={formatCount(summary.inputCacheRead)} />
              <Metric label="Cache 写" value={formatCount(summary.inputCacheCreation)} />
            </div>
            {stats && <TrendChart range={range} series={stats.series} />}
            <p className="mt-1.5 font-mono text-[10px] text-faint">
              已扫描 {stats?.scannedFiles ?? 0} 个 wire · 命中 {stats?.recordCount ?? 0}{" "}
              条 turn 记录
            </p>
          </>
        ) : (
          <p className="font-mono text-[11px] text-faint">
            暂无本地用量记录。新会话中的 LLM 调用会写入 wire.jsonl，之后可在此汇总。
          </p>
        )}
      </section>

      {stats && stats.byModel.length > 0 && (
        <section>
          <div className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-faint">
            按模型
          </div>
          <div className="overflow-x-auto rounded-r2 border border-line">
            <table className="w-full min-w-[420px] border-collapse text-left text-[11.5px]">
              <thead>
                <tr className="border-b border-line text-faint">
                  <th className="px-2.5 py-1.5 font-medium">模型</th>
                  <th className="px-2.5 py-1.5 font-medium">请求</th>
                  <th className="px-2.5 py-1.5 font-medium">Input</th>
                  <th className="px-2.5 py-1.5 font-medium">Output</th>
                  <th className="px-2.5 py-1.5 font-medium">合计</th>
                </tr>
              </thead>
              <tbody>
                {stats.byModel.map((row) => (
                  <tr key={row.model} className="border-b border-line/70 last:border-0">
                    <td className="max-w-[180px] truncate px-2.5 py-1.5 font-mono text-foreground">
                      {row.model}
                    </td>
                    <td className="px-2.5 py-1.5 font-mono text-muted">
                      {formatCount(row.requests)}
                    </td>
                    <td className="px-2.5 py-1.5 font-mono text-muted">
                      {formatCount(row.inputOther)}
                    </td>
                    <td className="px-2.5 py-1.5 font-mono text-muted">
                      {formatCount(row.output)}
                    </td>
                    <td className="px-2.5 py-1.5 font-mono text-muted">
                      {formatCount(row.totalTokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <div className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-faint">
          当前 Plan 额度
        </div>
        <PlanQuotaBlock managed={managed} />
      </section>
    </div>
  );
}
