import { useMemo } from "react";
import type { TokenUsage } from "@/hooks/wireTypes";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/ui/tooltip";
import { contextPercent, formatContextStatus } from "./context-format";

function UsageRow({
	label,
	value,
	formatter,
}: {
	label: string;
	value: number;
	formatter: Intl.NumberFormat;
}) {
	return (
		<div className="flex items-center justify-between gap-6 text-[11px]">
			<span className="text-muted">{label}</span>
			<span className="font-mono tabular-nums">{formatter.format(value)}</span>
		</div>
	);
}

export function ContextRing({
	usage,
	tokenUsage,
	contextTokens = null,
	maxContextTokens = null,
}: {
	usage: number;
	tokenUsage: TokenUsage | null;
	contextTokens?: number | null;
	maxContextTokens?: number | null;
}) {
	const { resolvedLanguage } = useI18n();
	const compact = useMemo(
		() => new Intl.NumberFormat(resolvedLanguage, { notation: "compact" }),
		[resolvedLanguage],
	);
	const exact = useMemo(
		() => new Intl.NumberFormat(resolvedLanguage),
		[resolvedLanguage],
	);
	const pct = contextPercent(usage, contextTokens, maxContextTokens);
	const statusLabel = formatContextStatus(usage, contextTokens, maxContextTokens);
	const r = 7;
	const circumference = 2 * Math.PI * r;
	const windowLabel =
		typeof contextTokens === "number" &&
		typeof maxContextTokens === "number" &&
		maxContextTokens > 0
			? `${exact.format(contextTokens)} / ${exact.format(maxContextTokens)}`
			: null;
	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						aria-label="当前上下文使用情况"
						className="flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[11px] text-muted transition-colors hover:bg-hover hover:text-foreground"
					>
						<svg
							aria-hidden="true"
							width="13"
							height="13"
							viewBox="0 0 18 18"
							className="-rotate-90"
						>
							<circle
								cx="9" cy="9" r={r} fill="none"
								className="stroke-line-strong" strokeWidth="2"
							/>
							<circle
								cx="9" cy="9" r={r} fill="none"
								className={cn("stroke-foreground transition-[stroke-dashoffset]")}
								strokeWidth="2"
								strokeLinecap="round"
								strokeDasharray={circumference}
								strokeDashoffset={circumference * (1 - pct / 100)}
							/>
						</svg>
						<span className="tabular-nums">{statusLabel}</span>
					</button>
				</TooltipTrigger>
				<TooltipContent side="top" className="p-2.5">
					{tokenUsage || windowLabel ? (
						<div className="flex flex-col gap-1">
							<div className="mb-1 text-[11px] font-medium text-foreground">
								当前上下文 · 最近一次模型请求
							</div>
							{windowLabel && (
								<div className="flex items-center justify-between gap-6 text-[11px]">
									<span className="text-muted">上下文输入</span>
									<span className="font-mono tabular-nums">{windowLabel}</span>
								</div>
							)}
							{tokenUsage && (
								<>
									<UsageRow label="非缓存输入" value={tokenUsage.input_other} formatter={compact} />
									<UsageRow label="缓存读取" value={tokenUsage.input_cache_read} formatter={compact} />
									<UsageRow label="缓存写入" value={tokenUsage.input_cache_creation} formatter={compact} />
									<UsageRow label="本轮输出（不计入圆环）" value={tokenUsage.output} formatter={compact} />
								</>
							)}
						</div>
					) : (
						<span className="text-[11px] text-muted">暂无 token 用量数据</span>
					)}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
