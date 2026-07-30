import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { isMacOS } from "@/hooks/utils";

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
	const macOS = isMacOS();
	return (
		<div
			data-platform={macOS ? "macos" : "default"}
			className="relative flex h-dvh overflow-hidden bg-background text-foreground"
		>
			<div
				data-slot="sessions-sidebar"
				className={cn(
					"shrink-0 overflow-hidden border-r border-line bg-background transition-[width] duration-[250ms] ease-out motion-reduce:transition-none",
					// Only overlay when both sidebars would crush the chat column.
					// Sidebar-only stays in-flow so min-width windows don't hide the dialog under the rail.
					sidebarOpen &&
						panelOpen &&
						"max-[1100px]:absolute max-[1100px]:inset-y-0 max-[1100px]:left-0 max-[1100px]:z-30 max-[1100px]:shadow-pop",
				)}
				style={{ width: sidebarOpen ? SIDEBAR_WIDTH : SIDEBAR_COLLAPSED_WIDTH }}
			>
				<div className="h-full w-full">{sidebar}</div>
			</div>
			{/* When the open sidebar overlays, keep a collapsed-rail spacer so chat isn't fully edge-bleed under it. */}
			{sidebarOpen && panelOpen ? (
				<div
					data-slot="sessions-sidebar-spacer"
					aria-hidden
					className="hidden w-[52px] shrink-0 max-[1100px]:block"
				/>
			) : null}
			<div className="flex min-w-0 flex-1 flex-col">
				{/* Frameless: parent is the drag surface; content layer must not capture empty hits. */}
				<div
					data-tauri-drag-region
					className="relative flex h-12 shrink-0 items-center justify-center px-3"
				>
					<div className="pointer-events-none relative z-10 flex w-full items-center justify-center [&>*]:pointer-events-auto">
						{topbar}
					</div>
				</div>
				<div className="flex min-h-0 min-w-0 flex-1">{children}</div>
			</div>
			<div
				data-slot="workspace-panel"
				className={cn(
					"shrink-0 overflow-hidden border-l bg-background transition-[width,border-color] duration-200",
					// Overlay only while open — closed width is 0 and must not steal hit-testing.
					panelOpen &&
						"max-[900px]:absolute max-[900px]:inset-y-0 max-[900px]:right-0 max-[900px]:z-30 max-[900px]:shadow-pop",
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
