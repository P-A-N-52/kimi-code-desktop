import { Moon, PanelLeftClose, PanelLeftOpen, Plus, Settings, Sun } from "lucide-react";
import { SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_WIDTH } from "@/app/app-shell";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import { IconButton } from "@/ui/icon-button";
import { SessionsSidebar, type SessionsSidebarProps } from "./sessions-sidebar";

export function AppSidebar({
	collapsed,
	running,
	onToggleCollapsed,
	onNewSession,
	onOpenSettings,
	...sessionsProps
}: SessionsSidebarProps & {
	collapsed: boolean;
	running: boolean;
	onToggleCollapsed: () => void;
	onNewSession: () => void;
	onOpenSettings: () => void;
}) {
	const { theme, toggleThemeWithTransition } = useTheme();

	const brandBlock = (
		<div className="relative flex size-[26px] items-center justify-center rounded-r1 bg-bright font-mono text-[13px] font-semibold text-background">
			K
			{running && (
				<span className="absolute -right-[2px] -top-[2px] size-[6px] animate-breathe rounded-full bg-success" />
			)}
		</div>
	);

	const themeIcon = theme === "dark" ? (
		<Sun size={15} strokeWidth={1.5} />
	) : (
		<Moon size={15} strokeWidth={1.5} />
	);

	return (
		<div className="relative h-full overflow-hidden">
			{/* 展开态：固定在 260px 宽，收起时向左滑出并淡出，避免内容回流 */}
			<div
				aria-hidden={collapsed}
				inert={collapsed}
				className={cn(
					"absolute inset-y-0 left-0 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
					collapsed
						? "pointer-events-none -translate-x-2 opacity-0"
						: "translate-x-0 opacity-100",
				)}
				style={{ width: SIDEBAR_WIDTH }}
			>
				<div className="flex h-full flex-col">
					<div className="flex items-center gap-1 px-2.5 pb-1 pt-2.5">
						{brandBlock}
						<IconButton label="新会话" onClick={onNewSession}>
							<Plus size={16} strokeWidth={1.5} />
						</IconButton>
						<div className="flex-1" />
						<IconButton label="收起会话列表" onClick={onToggleCollapsed}>
							<PanelLeftClose size={16} strokeWidth={1.5} />
						</IconButton>
					</div>
					<div className="min-h-0 flex-1">
						<SessionsSidebar {...sessionsProps} />
					</div>
					<div className="flex items-center gap-1 border-t border-line px-2.5 py-2">
						<button
							type="button"
							onClick={(event) => void toggleThemeWithTransition(event)}
							className="flex items-center gap-1.5 rounded-r1 px-2 py-1.5 text-[12px] text-muted transition-colors hover:bg-hover hover:text-foreground"
						>
							{themeIcon}
							{theme === "dark" ? "浅色" : "深色"}
						</button>
						<button
							type="button"
							onClick={onOpenSettings}
							className="flex items-center gap-1.5 rounded-r1 px-2 py-1.5 text-[12px] text-muted transition-colors hover:bg-hover hover:text-foreground"
						>
							<Settings size={14} strokeWidth={1.5} />
							设置
						</button>
					</div>
				</div>
			</div>
			{/* 收起态：锚定左侧 52px，展开时原地淡出，不漂移 */}
			<div
				aria-hidden={!collapsed}
				inert={!collapsed}
				className={cn(
					"absolute inset-y-0 left-0 transition-opacity duration-200 ease-out motion-reduce:transition-none",
					collapsed ? "opacity-100" : "pointer-events-none opacity-0",
				)}
				style={{ width: SIDEBAR_COLLAPSED_WIDTH }}
			>
				<div className="flex h-full flex-col items-center gap-0.5 py-2.5">
					<div className="mb-2.5">{brandBlock}</div>
					<IconButton label="展开会话列表" onClick={onToggleCollapsed}>
						<PanelLeftOpen size={16} strokeWidth={1.5} />
					</IconButton>
					<IconButton label="新会话" onClick={onNewSession}>
						<Plus size={16} strokeWidth={1.5} />
					</IconButton>
					<div className="flex-1" />
					<IconButton
						label={theme === "dark" ? "切换为浅色" : "切换为深色"}
						onClick={(event) => void toggleThemeWithTransition(event)}
					>
						{themeIcon}
					</IconButton>
					<IconButton label="设置" onClick={onOpenSettings}>
						<Settings size={15} strokeWidth={1.5} />
					</IconButton>
				</div>
			</div>
		</div>
	);
}
