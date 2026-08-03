import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

const MAX_OUTPUT_LINES = 2000;

function lineTone(line: string): "ok" | "err" | "dim" | null {
	const t = line.trimStart();
	if (t.startsWith("✓") || /passed|success/i.test(t)) return "ok";
	if (t.startsWith("✗") || /error|failed/i.test(t)) return "err";
	if (t.startsWith("$")) return "dim";
	return null;
}

export function TermView({ output }: { output: string }) {
	const [showAll, setShowAll] = useState(false);
	const lines = useMemo(() => output.split("\n"), [output]);
	const truncated = lines.length > MAX_OUTPUT_LINES;
	const visibleLines = useMemo(
		() => (showAll ? lines : lines.slice(0, MAX_OUTPUT_LINES)),
		[lines, showAll],
	);

	return (
		<div className="overflow-x-auto p-3 font-mono text-[11.5px] leading-[1.75] text-muted">
			{visibleLines.map((line, i) => {
				const tone = lineTone(line);
				return (
					<div
						key={`${i}-${line.slice(0, 12)}`}
						className={cn(
							"whitespace-pre-wrap",
							tone === "ok" && "text-success",
							tone === "err" && "text-danger",
							tone === "dim" && "text-faint",
						)}
					>
						{line}
					</div>
				);
			})}
			{truncated ? (
				<div className="mt-1 text-faint">
					{!showAll ? (
						<div className="whitespace-pre-wrap">{`输出已截断（共 ${lines.length} 行）`}</div>
					) : null}
					<button
						type="button"
						aria-expanded={showAll}
						onClick={() => setShowAll((value) => !value)}
						className="font-mono text-[11.5px] text-muted underline decoration-line/70 underline-offset-2 hover:text-foreground"
					>
						{showAll ? "收起" : "显示完整输出"}
					</button>
				</div>
			) : null}
		</div>
	);
}
