import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const RAIL_WIDTH = 52;
export const SIDEBAR_WIDTH = 260;
export const PANEL_WIDTH = 400;

export function AppShell({
	rail,
	sidebar,
	sidebarOpen,
	topbar,
	panel,
	panelOpen,
	children,
}: {
	rail: ReactNode;
	sidebar: ReactNode;
	sidebarOpen: boolean;
	topbar: ReactNode;
	panel: ReactNode;
	panelOpen: boolean;
	children: ReactNode;
}) {
	return (
		<div className="flex h-dvh overflow-hidden bg-background text-foreground">
			<div
				className="flex shrink-0 flex-col items-center gap-0.5 py-2.5"
				style={{ width: RAIL_WIDTH }}
			>
				{rail}
			</div>
			<div
				data-slot="sessions-sidebar"
				className={cn(
					"shrink-0 overflow-hidden border-r transition-[width,border-color] duration-200",
					sidebarOpen ? "border-line" : "border-transparent",
				)}
				style={{ width: sidebarOpen ? SIDEBAR_WIDTH : 0 }}
			>
				<div className="h-full" style={{ width: SIDEBAR_WIDTH }}>
					{sidebar}
				</div>
			</div>
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="relative flex h-12 shrink-0 items-center justify-center px-3">
					{topbar}
				</div>
				<div className="flex min-h-0 flex-1">{children}</div>
			</div>
			<div
				data-slot="workspace-panel"
				className={cn(
					"shrink-0 overflow-hidden border-l transition-[width,border-color] duration-200",
					panelOpen ? "border-line" : "border-transparent",
				)}
				style={{ width: panelOpen ? PANEL_WIDTH : 0 }}
			>
				<div className="h-full" style={{ width: PANEL_WIDTH }}>
					{panel}
				</div>
			</div>
		</div>
	);
}
