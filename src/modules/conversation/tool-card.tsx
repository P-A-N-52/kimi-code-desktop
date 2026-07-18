import {
	ChevronRight,
	FileText,
	Pencil,
	Search,
	SquareTerminal,
	Wrench,
} from "lucide-react";
import { useState } from "react";
import type { LiveMessage } from "@/hooks/types";
import { cn } from "@/lib/utils";
import { findDiffDisplay } from "./diff-display";
import { DiffView, computeDiffLines } from "./diff-view";
import { TermView } from "./term-view";

type ToolCall = NonNullable<LiveMessage["toolCall"]>;

const TOOL_ICONS: Record<string, typeof FileText> = {
	read: FileText,
	edit: Pencil,
	multiedit: Pencil,
	write: Pencil,
	bash: SquareTerminal,
	glob: Search,
	grep: Search,
	search: Search,
};

function toolIcon(title: string) {
	return TOOL_ICONS[title.toLowerCase()] ?? Wrench;
}

function summarizeInput(input: unknown): string {
	if (typeof input !== "object" || input === null) return "";
	const r = input as Record<string, unknown>;
	const candidate =
		r.file_path ?? r.path ?? r.command ?? r.pattern ?? r.query ?? r.cmd;
	if (typeof candidate === "string") {
		 return candidate.length > 80 ? `${candidate.slice(0, 80)}…` : candidate;
	}
	const json = JSON.stringify(input);
	return json.length > 80 ? `${json.slice(0, 80)}…` : json;
}

function isRunningState(state: ToolCall["state"]): boolean {
	return state === "input-streaming" || state === "input-available";
}

export function ToolCard({
	toolCall,
	defaultOpen,
}: {
	toolCall: ToolCall;
	defaultOpen?: boolean;
}) {
	const [open, setOpen] = useState(defaultOpen ?? false);
	const Icon = toolIcon(toolCall.title);
	const running = isRunningState(toolCall.state);
	const diff = findDiffDisplay(toolCall.display);
	const diffStats = diff ? computeDiffLines(diff) : null;

	let status: React.ReactNode = null;
	if (running) {
		status = (
			<span className="size-[10px] animate-spin rounded-full border border-muted border-t-transparent" />
		);
	} else if (toolCall.isError) {
		status = <span className="font-mono text-[11px] text-danger">✗ 失败</span>;
	} else if (diffStats) {
		status = (
			<span className="font-mono text-[11px]">
				<span className="text-success">+{diffStats.adds}</span>{" "}
				<span className="text-danger">−{diffStats.dels}</span>
			</span>
		);
	} else if (toolCall.state === "output-available") {
		status = <span className="font-mono text-[11px] text-success">✓</span>;
	}

	return (
		<div className="my-2.5 overflow-hidden rounded-r2 border border-line bg-elevated">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-hover"
			>
				<Icon size={13} strokeWidth={1.5} className="shrink-0 text-muted" />
				<span className="font-mono text-[12px] font-semibold text-foreground">
					{toolCall.title}
				</span>
				<span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">
					{summarizeInput(toolCall.input)}
				</span>
				{status}
				<ChevronRight
					size={12}
					strokeWidth={1.5}
					className={cn("shrink-0 text-faint transition-transform", open && "rotate-90")}
				/>
			</button>
			{open && (
				<div data-slot="tool-body" className="border-t border-line">
					{diff ? (
						<DiffView data={diff} />
					) : toolCall.isError && toolCall.errorText ? (
						<div className="p-3 font-mono text-[11.5px] text-danger">
							{toolCall.errorText}
						</div>
					) : toolCall.output ? (
						<TermView output={toolCall.output} />
					) : (
						<div className="p-3 font-mono text-[11px] text-faint">（无输出）</div>
					)}
				</div>
			)}
		</div>
	);
}
