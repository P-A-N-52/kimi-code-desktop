import { Check, Pencil, Search, Trash2, X } from "lucide-react";
import { useState } from "react";
import { formatRelativeTime } from "@/hooks/utils";
import type { Session } from "@/lib/api/models";
import { cn } from "@/lib/utils";
import { Kbd } from "@/ui/kbd";
import { groupSessionsByDay } from "./session-groups";

function workDirName(workDir?: string | null): string {
	if (!workDir) return "默认目录";
	const parts = workDir.replace(/[\\/]+$/, "").split(/[\\/]/);
	return parts[parts.length - 1] || workDir;
}

function SessionItem({
	session,
	selected,
	onSelect,
	onDelete,
	onRename,
}: {
	session: Session;
	selected: boolean;
	onSelect: () => void;
	onDelete: () => void;
	onRename: (title: string) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(session.title ?? "");

	const commitRename = () => {
		const next = draft.trim();
		setEditing(false);
		if (next && next !== session.title) onRename(next);
	};

	return (
		<div
			className={cn(
				"group relative w-full rounded-r1 px-2.5 py-1.5 text-left transition-colors",
				selected ? "bg-active" : "hover:bg-hover",
			)}
		>
			{selected && (
				<span className="absolute left-0 top-[7px] bottom-[7px] w-[2px] rounded-full bg-bright" />
			)}
			{editing ? (
				<div className="flex items-center gap-1">
					<input
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitRename();
							if (e.key === "Escape") setEditing(false);
						}}
						className="h-6 min-w-0 flex-1 rounded-r1 border border-line-strong bg-elevated px-1.5 text-[13px] outline-none"
					/>
					<button
						type="button"
						aria-label="确认重命名"
						onClick={commitRename}
						className="text-muted hover:text-success"
					>
						<Check size={13} strokeWidth={1.5} />
					</button>
					<button
						type="button"
						aria-label="取消重命名"
						onClick={() => setEditing(false)}
						className="text-muted hover:text-foreground"
					>
						<X size={13} strokeWidth={1.5} />
					</button>
				</div>
			) : (
				<button type="button" onClick={onSelect} className="w-full text-left">
					<span className="flex items-center gap-1.5 truncate text-[13px] font-medium text-foreground">
						{session.isRunning && (
							<span className="size-[5px] shrink-0 animate-breathe rounded-full bg-success" />
						)}
						{session.title || "未命名会话"}
					</span>
					<span className="mt-px block truncate font-mono text-[10.5px] text-faint">
						{workDirName(session.workDir)} · {formatRelativeTime(new Date(session.lastUpdated))}
					</span>
				</button>
			)}
			{!editing && (
				<div className="absolute right-1.5 top-1.5 hidden gap-0.5 group-hover:flex">
					<button
						type="button"
						aria-label="重命名"
						onClick={() => {
							setDraft(session.title ?? "");
							setEditing(true);
						}}
						className="flex size-[22px] items-center justify-center rounded-r1 text-muted hover:bg-active hover:text-foreground"
					>
						<Pencil size={11} strokeWidth={1.5} />
					</button>
					<button
						type="button"
						aria-label="删除会话"
						onClick={onDelete}
						className="flex size-[22px] items-center justify-center rounded-r1 text-muted hover:bg-danger-bg hover:text-danger"
					>
						<Trash2 size={11} strokeWidth={1.5} />
					</button>
				</div>
			)}
		</div>
	);
}

export function SessionsSidebar({
	sessions,
	selectedId,
	searchQuery,
	onSearchQueryChange,
	onSelect,
	onDelete,
	onRename,
}: {
	sessions: Session[];
	selectedId: string;
	searchQuery: string;
	onSearchQueryChange: (q: string) => void;
	onSelect: (sessionId: string) => void;
	onDelete: (sessionId: string) => void;
	onRename: (sessionId: string, title: string) => void;
}) {
	const groups = groupSessionsByDay(sessions);
	return (
		<div className="flex h-full flex-col px-2 pb-2 pt-3">
			<div className="mx-1 mb-3 flex items-center gap-2 rounded-r2 border border-line px-2.5 py-1.5 text-faint transition-colors focus-within:border-line-strong">
				<Search size={12} strokeWidth={1.5} />
				<input
					id="sessions-search-input"
					value={searchQuery}
					onChange={(e) => onSearchQueryChange(e.target.value)}
					placeholder="搜索会话"
					className="w-full bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-faint"
				/>
				<Kbd>⌘K</Kbd>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{groups.length === 0 && (
					<p className="px-2.5 py-6 text-center font-mono text-[11px] text-faint">
						{searchQuery ? "没有匹配的会话" : "还没有会话"}
					</p>
				)}
				{groups.map((group) => (
					<div key={group.label} className="mb-4">
						<div className="mb-1 px-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-faint">
							{group.label}
						</div>
						{group.items.map((session) => (
							<SessionItem
								key={session.sessionId}
								session={session}
								selected={session.sessionId === selectedId}
								onSelect={() => onSelect(session.sessionId)}
								onDelete={() => onDelete(session.sessionId)}
								onRename={(title) => onRename(session.sessionId, title)}
							/>
						))}
					</div>
				))}
			</div>
		</div>
	);
}
