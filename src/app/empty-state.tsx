import { Kbd } from "@/ui/kbd";

export function EmptyState({ onNewSession }: { onNewSession: () => void }) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-4">
			<div className="flex size-10 items-center justify-center rounded-r2 bg-bright font-mono text-[17px] font-semibold text-background">
				K
			</div>
			<p className="font-mono text-[13px] text-muted">给 Kimi 布置一个任务</p>
			<button
				type="button"
				onClick={onNewSession}
				className="flex items-center gap-2 rounded-r2 border border-line px-3 py-1.5 text-[12.5px] text-muted transition-colors hover:bg-hover hover:text-foreground"
			>
				新建会话
				<Kbd>⌘N</Kbd>
			</button>
		</div>
	);
}
