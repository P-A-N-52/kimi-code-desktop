import { MessagesSquare, Moon, Plus, Search, Settings, Sun } from "lucide-react";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import { IconButton } from "@/ui/icon-button";

export function AppRail({
	sessionsActive,
	running,
	onToggleSessions,
	onNewSession,
	onOpenSearch,
	onOpenSettings,
}: {
	sessionsActive: boolean;
	running: boolean;
	onToggleSessions: () => void;
	onNewSession: () => void;
	onOpenSearch: () => void;
	onOpenSettings: () => void;
}) {
	const { theme, toggleTheme } = useTheme();
	return (
		<>
			<div className="mb-2.5 flex size-[26px] items-center justify-center rounded-r1 bg-bright font-mono text-[13px] font-semibold text-background">
				K
			</div>
			<IconButton
				label="会话"
				active={sessionsActive}
				onClick={onToggleSessions}
				className="relative"
			>
				<MessagesSquare size={16} strokeWidth={1.5} />
				{running && (
					<span
						className={cn(
							"absolute right-[3px] top-[3px] size-[6px] rounded-full bg-success",
							"animate-breathe",
						)}
					/>
				)}
			</IconButton>
			<IconButton label="新会话" onClick={onNewSession}>
				<Plus size={16} strokeWidth={1.5} />
			</IconButton>
			<IconButton label="搜索" onClick={onOpenSearch}>
				<Search size={15} strokeWidth={1.5} />
			</IconButton>
			<div className="flex-1" />
			<IconButton
				label={theme === "dark" ? "切换为浅色" : "切换为深色"}
				onClick={toggleTheme}
			>
				{theme === "dark" ? (
					<Sun size={15} strokeWidth={1.5} />
				) : (
					<Moon size={15} strokeWidth={1.5} />
				)}
			</IconButton>
			<IconButton label="设置" onClick={onOpenSettings}>
				<Settings size={15} strokeWidth={1.5} />
			</IconButton>
		</>
	);
}
