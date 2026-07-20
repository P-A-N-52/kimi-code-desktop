import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { StreamingCaret } from "./streaming-caret";

export function ThinkingBlock({
	thinking,
	duration,
	streaming = false,
}: {
	thinking: string;
	duration?: number;
	streaming?: boolean;
}) {
	// null = follow default (open while streaming); boolean = user override
	const [userOpen, setUserOpen] = useState<boolean | null>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const open = userOpen ?? streaming;

	useEffect(() => {
		if (!streaming || !open || !bodyRef.current) return;
		bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
	}, [thinking, streaming, open]);

	const label = streaming
		? "思考中…"
		: duration !== undefined
			? `思考过程 · ${duration.toFixed(1)}s`
			: "思考过程";

	return (
		<div className="my-2" data-slot="thinking-block" data-streaming={streaming || undefined}>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setUserOpen((prev) => !(prev ?? streaming))}
				className="flex items-center gap-1.5 font-mono text-[11px] text-faint transition-colors hover:text-muted"
			>
				<ChevronRight
					size={12}
					strokeWidth={1.5}
					className={cn("transition-transform", open && "rotate-90")}
				/>
				{label}
			</button>
			{open ? (
				<div
					ref={bodyRef}
					className={cn(
						"mt-1.5 whitespace-pre-wrap border-l border-line pl-3 text-[13px] text-muted",
						streaming && "max-h-64 overflow-y-auto",
					)}
				>
					{thinking}
					{streaming ? <StreamingCaret /> : null}
				</div>
			) : streaming && thinking ? (
				// User collapsed mid-stream: keep a live tail so it doesn't feel frozen.
				<div className="mt-1.5 truncate border-l border-line pl-3 font-mono text-[12px] text-faint">
					{thinking.slice(-80)}
					<StreamingCaret />
				</div>
			) : null}
		</div>
	);
}
