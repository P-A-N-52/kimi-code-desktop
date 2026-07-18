import type { ReactNode } from "react";
import { Markdown } from "./markdown";

export function AiMessage({
	content,
	children,
}: {
	content?: string;
	children?: ReactNode;
}) {
	return (
		<div className="my-5 flex gap-3">
			<div className="mt-[3px] flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-bright font-mono text-[10px] font-semibold text-background">
				K
			</div>
			<div className="min-w-0 flex-1">
				{content ? <Markdown content={content} /> : null}
				{children}
			</div>
		</div>
	);
}
