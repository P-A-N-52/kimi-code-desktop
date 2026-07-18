import { ArrowUp, ChevronDown, FileText, Plus, Square, SquareTerminal } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function Composer({
	draft,
	onDraftChange,
	onSend,
	onCancel,
	busy,
	planMode,
}: {
	draft: string;
	onDraftChange: (v: string) => void;
	onSend: () => void;
	onCancel: () => void;
	busy: boolean;
	planMode: boolean;
}) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const placeholder = () => toast("后续版本接入");

	return (
		<div
			className={cn(
				"rounded-r3 border bg-elevated px-3 pb-2 pt-3 shadow-pop transition-colors focus-within:border-line-strong",
				planMode ? "border-dashed border-bright/40" : "border-line-strong",
			)}
		>
			<textarea
				ref={textareaRef}
				value={draft}
				onChange={(e) => onDraftChange(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						onSend();
					}
				}}
				rows={2}
				placeholder="给 Kimi 布置任务… (@ 引用文件 · / 命令)"
				className="max-h-40 w-full resize-none bg-transparent px-1 text-[14px] leading-[1.55] text-foreground outline-none placeholder:text-faint"
			/>
			<div className="mt-1.5 flex items-center gap-0.5">
				<button
					type="button"
					aria-label="附件"
					onClick={placeholder}
					className="flex h-7 w-7 items-center justify-center rounded-r1 text-muted transition-colors hover:bg-hover hover:text-foreground"
				>
					<Plus size={14} strokeWidth={1.5} />
				</button>
				<button
					type="button"
					onClick={placeholder}
					className="flex h-7 items-center gap-1 rounded-r1 px-1.5 font-mono text-[11px] text-muted transition-colors hover:bg-hover hover:text-foreground"
				>
					<SquareTerminal size={13} strokeWidth={1.5} />
					命令
				</button>
				<button
					type="button"
					onClick={placeholder}
					className="flex h-7 items-center gap-1 rounded-r1 px-1.5 font-mono text-[11px] text-muted transition-colors hover:bg-hover hover:text-foreground"
				>
					<FileText size={13} strokeWidth={1.5} />
					上下文
				</button>
				{planMode && (
					<span className="ml-1 rounded bg-bright px-1.5 py-0.5 font-mono text-[9.5px] font-semibold tracking-[0.12em] text-background">
						PLAN
					</span>
				)}
				<button
					type="button"
					className="ml-auto flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 font-mono text-[11.5px] font-medium text-muted transition-colors hover:bg-hover hover:text-foreground"
				>
					kimi-k2
					<ChevronDown size={10} strokeWidth={1.5} />
				</button>
				<button
					type="button"
					aria-label={busy ? "停止" : "发送"}
					onClick={busy ? onCancel : onSend}
					className={cn(
						"flex size-7 items-center justify-center rounded-full transition-colors",
						busy
							? "border border-line-strong text-muted hover:text-foreground"
							: "bg-bright text-background hover:opacity-85",
					)}
				>
					{busy ? (
						<Square size={11} strokeWidth={1.5} />
					) : (
						<ArrowUp size={13} strokeWidth={2} />
					)}
				</button>
			</div>
		</div>
	);
}
