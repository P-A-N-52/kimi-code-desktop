import { structuredPatch } from "diff";
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { DiffDisplayData } from "./diff-display";

type DiffLine = {
	kind: "add" | "del" | "ctx";
	oldNo?: number;
	newNo?: number;
	text: string;
};

export function computeDiffLines(data: DiffDisplayData): {
	lines: DiffLine[];
	adds: number;
	dels: number;
} {
	const patch = structuredPatch("file", "file", data.old_text, data.new_text, "", "");
	const lines: DiffLine[] = [];
	let adds = 0;
	let dels = 0;
	for (const hunk of patch.hunks) {
		let oldNo = hunk.oldStart;
		let newNo = hunk.newStart;
		for (const raw of hunk.lines) {
			const kind = raw.startsWith("+") ? "add" : raw.startsWith("-") ? "del" : "ctx";
			const text = raw.slice(1);
			if (kind === "add") {
				adds += 1;
				lines.push({ kind, newNo: newNo++, text });
			} else if (kind === "del") {
				dels += 1;
				lines.push({ kind, oldNo: oldNo++, text });
			} else {
				lines.push({ kind, oldNo: oldNo++, newNo: newNo++, text });
			}
		}
	}
	return { lines, adds, dels };
}

export function DiffView({
	data,
	maxLines,
}: {
	data: DiffDisplayData;
	maxLines?: number;
}) {
	const { lines, adds, dels } = useMemo(() => computeDiffLines(data), [data]);
	const visible = maxLines ? lines.slice(0, maxLines) : lines;
	return (
		<div className="font-mono text-[11.5px] leading-[1.7]">
			<div className="flex items-center gap-2.5 border-b border-line bg-secondary px-3 py-1.5 text-[11px] text-muted">
				<span className="truncate">{data.path || "diff"}</span>
				<span className="text-success">+{adds}</span>
				<span className="text-danger">−{dels}</span>
				{data.is_summary && <span className="text-faint">摘要</span>}
			</div>
			<div className="overflow-x-auto py-1">
				{visible.map((line, i) => (
					<div
						key={`${i}-${line.kind}`}
						className={cn(
							"flex whitespace-pre",
							line.kind === "add" && "bg-success-bg shadow-[inset_2px_0_0_var(--success)]",
							line.kind === "del" && "bg-danger-bg shadow-[inset_2px_0_0_var(--danger)]",
						)}
					>
						<span className="w-[34px] shrink-0 select-none pr-2.5 text-right text-faint tabular-nums">
							{line.kind === "add" ? line.newNo : (line.oldNo ?? line.newNo)}
						</span>
						<span
							className={cn(
								"w-[14px] shrink-0 select-none",
								line.kind === "add" && "text-success",
								line.kind === "del" && "text-danger",
							)}
						>
							{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
						</span>
						<span className={line.kind === "ctx" ? "text-muted" : "text-foreground"}>
							{line.text}
						</span>
					</div>
				))}
				{maxLines && lines.length > maxLines && (
					<div className="px-3 py-1 font-mono text-[10.5px] text-faint">
						… 还有 {lines.length - maxLines} 行
					</div>
				)}
			</div>
		</div>
	);
}
