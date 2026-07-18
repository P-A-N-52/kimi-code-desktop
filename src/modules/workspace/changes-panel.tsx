import { FileText, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { DiffView } from "@/modules/conversation/diff-view";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import type { ChangeEntry, PendingApproval } from "./derive-changes";

const TABS = ["更改", "文件", "Agent"] as const;

export function ChangesPanel({
	changes,
	pendingApprovals,
	onApproveAll,
	onRejectAll,
	onClose,
}: {
	changes: ChangeEntry[];
	pendingApprovals: PendingApproval[];
	onApproveAll: () => void;
	onRejectAll: () => void;
	onClose: () => void;
}) {
	const [tab, setTab] = useState<(typeof TABS)[number]>("更改");
	const [openPaths, setOpenPaths] = useState<Set<string>>(new Set());

	const toggle = (path: string) => {
		setOpenPaths((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-line px-3">
				{TABS.map((t) => (
					<button
						key={t}
						type="button"
						onClick={() => {
							if (t === "更改") setTab(t);
							else toast("后续版本接入");
						}}
						className={cn(
							"rounded-r1 px-2 py-1 text-[12.5px] font-medium transition-colors",
							tab === t
								? "bg-active text-bright"
								: "text-muted hover:text-foreground",
						)}
					>
						{t}
						{t === "更改" && changes.length > 0 && (
							<span className="ml-1 font-mono text-[10px] text-faint tabular-nums">
								{changes.length}
							</span>
						)}
					</button>
				))}
				<div className="flex-1" />
				<IconButton label="关闭面板" onClick={onClose}>
					<X size={14} strokeWidth={1.5} />
				</IconButton>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto p-3">
				{changes.length === 0 ? (
					<p className="py-10 text-center font-mono text-[11px] text-faint">
						当前会话还没有文件变更
					</p>
				) : (
					changes.map((change) => (
						<div
							key={change.path}
							className="mb-2 overflow-hidden rounded-r2 border border-line bg-elevated"
						>
							<button
								type="button"
								onClick={() => toggle(change.path)}
								className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-hover"
							>
								<FileText size={12} strokeWidth={1.5} className="shrink-0 text-muted" />
								<span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">
									{change.path}
								</span>
								<span className="font-mono text-[10.5px] text-success tabular-nums">
									+{change.adds}
								</span>
								<span className="font-mono text-[10.5px] text-danger tabular-nums">
									−{change.dels}
								</span>
							</button>
							{openPaths.has(change.path) && (
								<div className="border-t border-line">
									<DiffView data={change.display} maxLines={8} />
								</div>
							)}
						</div>
					))
				)}
			</div>
			<div className="flex shrink-0 gap-2 border-t border-line p-3">
				<Button
					variant="primary"
					className="flex-1"
					disabled={pendingApprovals.length === 0}
					onClick={onApproveAll}
				>
					全部接受
				</Button>
				<Button
					variant="ghost"
					className="flex-1"
					disabled={pendingApprovals.length === 0}
					onClick={onRejectAll}
				>
					全部拒绝
				</Button>
			</div>
		</div>
	);
}
