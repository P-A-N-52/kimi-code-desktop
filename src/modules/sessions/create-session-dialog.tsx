import { FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/ui/dialog";

export function CreateSessionDialog({
	open,
	onOpenChange,
	onConfirm,
	fetchWorkDirs,
	fetchStartupDir,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: (workDir: string) => Promise<void>;
	fetchWorkDirs: () => Promise<string[]>;
	fetchStartupDir: () => Promise<string>;
}) {
	const [workDir, setWorkDir] = useState("");
	const [recentDirs, setRecentDirs] = useState<string[]>([]);
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		if (!open) return;
		fetchStartupDir()
			.then((dir) => setWorkDir((cur) => cur || dir))
			.catch(() => {});
		fetchWorkDirs()
			.then(setRecentDirs)
			.catch(() => {});
	}, [open, fetchStartupDir, fetchWorkDirs]);

	const handleConfirm = async () => {
		const dir = workDir.trim();
		if (!dir) return;
		setSubmitting(true);
		try {
			await onConfirm(dir);
			onOpenChange(false);
			setWorkDir("");
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogTitle>新建会话</DialogTitle>
				<DialogDescription>
					选择一个工作目录，Kimi 会在该目录下执行任务。
				</DialogDescription>
				<div className="mt-4 flex flex-col gap-3">
					<input
						value={workDir}
						onChange={(e) => setWorkDir(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void handleConfirm();
						}}
						placeholder="工作目录，如 C:\projects\foo"
						className="h-9 rounded-r2 border border-line bg-background px-3 font-mono text-[12px] text-foreground outline-none placeholder:text-faint focus:border-line-strong"
					/>
					{recentDirs.length > 0 && (
						<div className="flex max-h-36 flex-col gap-0.5 overflow-y-auto">
							{recentDirs.slice(0, 8).map((dir) => (
								<button
									key={dir}
									type="button"
									onClick={() => setWorkDir(dir)}
									className="flex items-center gap-2 rounded-r1 px-2 py-1.5 text-left font-mono text-[11.5px] text-muted transition-colors hover:bg-hover hover:text-foreground"
								>
									<FolderOpen size={12} strokeWidth={1.5} />
									<span className="truncate">{dir}</span>
								</button>
							))}
						</div>
					)}
					<div className="flex justify-end gap-2">
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							取消
						</Button>
						<Button
							variant="primary"
							disabled={!workDir.trim() || submitting}
							onClick={() => void handleConfirm()}
						>
							{submitting ? "创建中…" : "创建会话"}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
