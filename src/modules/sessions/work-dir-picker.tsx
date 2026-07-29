import { ChevronDown, FolderOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { isTauri, pickFolder } from "@/lib/tauri-api";
import { cn } from "@/lib/utils";

export function workDirBasename(path: string): string {
	const normalized = path.replace(/[/\\]+$/, "");
	const parts = normalized.split(/[/\\]/);
	return parts[parts.length - 1] || path || "工作目录";
}

const chipClassName =
	"flex max-w-[min(100%,20rem)] items-center gap-1.5 rounded-r2 border border-line px-2.5 py-1.5 text-left";

export function WorkDirPicker({
	workDir,
	onWorkDirChange,
	recentDirs = [],
	disabled = false,
	readOnly = false,
	className,
}: {
	workDir: string;
	onWorkDirChange?: (dir: string) => void;
	recentDirs?: string[];
	disabled?: boolean;
	/** Fixed display — no folder selection (used in active conversation). */
	readOnly?: boolean;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const [customDir, setCustomDir] = useState("");
	const menuRef = useRef<HTMLDivElement>(null);
	const browsingRef = useRef(false);

	useEffect(() => {
		if (!open || readOnly) return;
		const close = (event: MouseEvent) => {
			if (browsingRef.current) return;
			if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [open, readOnly]);

	const selectDir = (dir: string) => {
		onWorkDirChange?.(dir);
		setOpen(false);
		setCustomDir("");
	};

	const applyCustomDir = () => {
		const dir = customDir.trim();
		if (!dir) return;
		selectDir(dir);
	};

	const browseFolder = () => {
		void (async () => {
			browsingRef.current = true;
			try {
				const dir = await pickFolder();
				if (!dir) return;
				setCustomDir(dir);
			} catch (error) {
				toast.error("打开文件夹选择器失败", {
					description: error instanceof Error ? error.message : String(error),
				});
			} finally {
				browsingRef.current = false;
			}
		})();
	};

	const label = workDir ? workDirBasename(workDir) : readOnly ? "工作目录" : "选择工作目录";

	if (readOnly) {
		return (
			<div className={cn("relative", className)} title={workDir || "工作目录"}>
				<div className={chipClassName} aria-label={`工作目录 ${label}`}>
					<FolderOpen size={13} strokeWidth={1.5} className="shrink-0 text-muted" />
					<span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">
						{label}
					</span>
				</div>
			</div>
		);
	}

	return (
		<div ref={menuRef} className={cn("relative", className)}>
			<button
				type="button"
				disabled={disabled}
				title={workDir || "选择工作目录"}
				onClick={() => setOpen((value) => !value)}
				className={cn(
					chipClassName,
					"transition-colors",
					disabled
						? "cursor-not-allowed opacity-50"
						: "hover:border-line-strong hover:bg-hover",
				)}
			>
				<FolderOpen size={13} strokeWidth={1.5} className="shrink-0 text-muted" />
				<span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">
					{label}
				</span>
				<ChevronDown size={11} strokeWidth={1.5} className="shrink-0 text-faint" />
			</button>
			{open && (
				<div className="absolute bottom-[calc(100%+6px)] left-0 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-r3 border border-line-strong bg-elevated p-2 shadow-pop">
					<p className="mb-2 px-1 text-[11px] text-muted">Kimi 会在该目录下执行任务</p>
					{recentDirs.length > 0 && (
						<div className="mb-2 flex max-h-40 flex-col gap-0.5 overflow-y-auto">
							{recentDirs.slice(0, 8).map((dir) => (
								<button
									key={dir}
									type="button"
									onClick={() => selectDir(dir)}
									className={cn(
										"flex items-center gap-2 rounded-r1 px-2 py-1.5 text-left font-mono text-[11px] transition-colors hover:bg-hover",
										dir === workDir ? "bg-active text-foreground" : "text-muted",
									)}
								>
									<FolderOpen size={12} strokeWidth={1.5} className="shrink-0" />
									<span className="truncate">{dir}</span>
								</button>
							))}
						</div>
					)}
					<div className="flex gap-1.5">
						<input
							value={customDir}
							onChange={(event) => setCustomDir(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") applyCustomDir();
							}}
							placeholder="输入路径，如 C:\projects\foo"
							className="h-8 min-w-0 flex-1 rounded-r2 border border-line bg-background px-2.5 font-mono text-[11px] text-foreground outline-none placeholder:text-faint focus:border-line-strong"
						/>
						{isTauri() && (
							<button
								type="button"
								onClick={browseFolder}
								className="shrink-0 rounded-r2 border border-line px-2.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-foreground"
							>
								浏览
							</button>
						)}
						<button
							type="button"
							disabled={!customDir.trim()}
							onClick={applyCustomDir}
							className="shrink-0 rounded-r2 border border-line px-2.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-foreground disabled:opacity-40"
						>
							确定
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
