import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { useTheme } from "@/hooks/use-theme";
import { shouldPauseForRuntimeReadiness } from "@/lib/runtime-readiness";
import {
	checkRuntimeReadiness,
	isTauri,
	type RuntimeReadiness,
	showWindow,
} from "@/lib/tauri-api";
import { AppRail } from "@/modules/rail/app-rail";
import { AppShell } from "./app-shell";
import { EmptyState } from "./empty-state";

export default function App() {
	useTheme();

	useLayoutEffect(() => {
		if (isTauri()) {
			showWindow().catch(() => {});
		}
	}, []);

	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [panelOpen, setPanelOpen] = useState(false);
	const [runtimeReadiness, setRuntimeReadiness] =
		useState<RuntimeReadiness | null>(null);
	const [runtimeCheckError, setRuntimeCheckError] = useState<string | null>(
		null,
	);
	const [isCheckingRuntime, setIsCheckingRuntime] = useState(() => isTauri());
	const [hasAcknowledgedRuntime, setHasAcknowledgedRuntime] = useState(
		() => !isTauri(),
	);

	const runRuntimeReadinessCheck = useCallback(async () => {
		if (!isTauri()) {
			setRuntimeReadiness(null);
			setRuntimeCheckError(null);
			setIsCheckingRuntime(false);
			setHasAcknowledgedRuntime(true);
			return;
		}
		setIsCheckingRuntime(true);
		setRuntimeCheckError(null);
		setHasAcknowledgedRuntime(false);
		try {
			const readiness = await checkRuntimeReadiness();
			setRuntimeReadiness(readiness);
			setHasAcknowledgedRuntime(
				!shouldPauseForRuntimeReadiness(readiness, false),
			);
		} catch (err) {
			const message =
				err instanceof Error
					? err.message
					: "Failed to run startup readiness checks.";
			setRuntimeReadiness(null);
			setRuntimeCheckError(message);
		} finally {
			setIsCheckingRuntime(false);
		}
	}, []);

	useEffect(() => {
		runRuntimeReadinessCheck();
	}, [runRuntimeReadinessCheck]);

	const shouldPauseRuntime =
		isTauri() &&
		(isCheckingRuntime ||
			Boolean(runtimeCheckError) ||
			shouldPauseForRuntimeReadiness(runtimeReadiness, hasAcknowledgedRuntime));

	if (shouldPauseRuntime) {
		return (
			<div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background text-foreground">
				<div className="flex size-10 items-center justify-center rounded-r2 bg-bright font-mono text-[17px] font-semibold text-background">
					K
				</div>
				<p className="font-mono text-[13px] text-muted">
					{isCheckingRuntime ? "正在检查运行环境…" : (runtimeCheckError ?? "运行时未就绪")}
				</p>
				{!isCheckingRuntime && (
					<button
						type="button"
						onClick={runRuntimeReadinessCheck}
						className="rounded-r1 bg-bright px-3 py-1.5 text-[12.5px] font-medium text-background"
					>
						重试
					</button>
				)}
			</div>
		);
	}

	return (
		<AppShell
			rail={
				<AppRail
					sessionsActive={sidebarOpen}
					running={false}
					onToggleSessions={() => setSidebarOpen((v) => !v)}
					onNewSession={() => {}}
					onOpenSearch={() => {}}
					onOpenSettings={() => {}}
				/>
			}
			sidebar={null}
			sidebarOpen={sidebarOpen}
			topbar={null}
			panel={null}
			panelOpen={panelOpen}
		>
			<EmptyState onNewSession={() => {}} />
		</AppShell>
	);
}
