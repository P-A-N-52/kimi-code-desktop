import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export function ThinkingBlock({
	thinking,
	duration,
}: {
	thinking: string;
	duration?: number;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className="my-2">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex items-center gap-1.5 font-mono text-[11px] text-faint transition-colors hover:text-muted"
			>
				<ChevronRight
					size={12}
					strokeWidth={1.5}
					className={cn("transition-transform", open && "rotate-90")}
				/>
				思考过程{duration !== undefined && ` · ${duration.toFixed(1)}s`}
			</button>
			{open && (
				<div className="mt-1.5 whitespace-pre-wrap border-l border-line pl-3 text-[13px] text-muted">
					{thinking}
				</div>
			)}
		</div>
	);
}
