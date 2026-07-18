import type { TokenUsage } from "@/hooks/wireTypes";
import { cn } from "@/lib/utils";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/ui/tooltip";

const compact = new Intl.NumberFormat("en-US", { notation: "compact" });

function UsageRow({ label, value }: { label: string; value: number }) {
	return (
		<div className="flex items-center justify-between gap-6 text-[11px]">
			<span className="text-muted">{label}</span>
			<span className="font-mono tabular-nums">{compact.format(value)}</span>
		</div>
	);
}

export function ContextRing({
	usage,
	tokenUsage,
}: {
	usage: number;
	tokenUsage: TokenUsage | null;
}) {
	const pct = Math.min(100, Math.max(0, usage * 100));
	const r = 7;
	const circumference = 2 * Math.PI * r;
	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						className="flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[11px] text-muted transition-colors hover:bg-hover hover:text-foreground"
					>
						<svg width="13" height="13" viewBox="0 0 18 18" className="-rotate-90">
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
						<span className="tabular-nums">{pct.toFixed(1)}%</span>
					</button>
				</TooltipTrigger>
				<TooltipContent side="top" className="p-2.5">
					{tokenUsage ? (
						<div className="flex flex-col gap-1">
							<UsageRow label="Input" value={tokenUsage.input_other} />
							<UsageRow label="Cache read" value={tokenUsage.input_cache_read} />
							<UsageRow label="Cache write" value={tokenUsage.input_cache_creation} />
							<UsageRow label="Output" value={tokenUsage.output} />
						</div>
					) : (
						<span className="text-[11px] text-muted">暂无 token 用量数据</span>
					)}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
