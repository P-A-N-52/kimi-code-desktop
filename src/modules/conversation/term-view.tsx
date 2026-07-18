import { cn } from "@/lib/utils";

function lineTone(line: string): "ok" | "err" | "dim" | null {
	const t = line.trimStart();
	if (t.startsWith("✓") || /passed|success/i.test(t)) return "ok";
	if (t.startsWith("✗") || /error|failed/i.test(t)) return "err";
	if (t.startsWith("$")) return "dim";
	return null;
}

export function TermView({ output }: { output: string }) {
	return (
		<div className="overflow-x-auto p-3 font-mono text-[11.5px] leading-[1.75] text-muted">
			{output.split("\n").map((line, i) => {
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
		</div>
	);
}
