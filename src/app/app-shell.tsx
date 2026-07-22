import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const SIDEBAR_WIDTH = 260;
export const SIDEBAR_COLLAPSED_WIDTH = 52;
export const PANEL_WIDTH = 400;

export function AppShell({
	sidebar,
	sidebarOpen,
	topbar,
	panel,
	panelOpen,
	children,
}: {
	sidebar: ReactNode;
	sidebarOpen: boolean;
	topbar: ReactNode;
	panel: ReactNode;
	panelOpen: boolean;
	children: ReactNode;
}) {
	return (
		<div className="relative flex h-dvh overflow-hidden bg-background text-foreground">
			<div
				data-slot="sessions-sidebar"
				className="shrink-0 overflow-hidden border-r border-line transition-[width] duration-[250ms] ease-out motion-reduce:transition-none"
				style={{ width: sidebarOpen ? SIDEBAR_WIDTH : SIDEBAR_COLLAPSED_WIDTH }}
			>
				<div className="h-full w-full">{sidebar}</div>
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
					"shrink-0 overflow-hidden border-l transition-[width,border-color] duration-200 max-[900px]:absolute max-[900px]:inset-y-0 max-[900px]:right-0 max-[900px]:z-30 max-[900px]:shadow-pop",
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
