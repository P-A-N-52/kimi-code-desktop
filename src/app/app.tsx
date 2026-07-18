import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Toaster, toast } from "sonner";
import { useTheme } from "@/hooks/use-theme";
import { useSessions } from "@/hooks/useSessions";
import { shouldPauseForRuntimeReadiness } from "@/lib/runtime-readiness";
import {
	checkRuntimeReadiness,
	isTauri,
	type RuntimeReadiness,
	showWindow,
} from "@/lib/tauri-api";
import { AppRail } from "@/modules/rail/app-rail";
import { CreateSessionDialog } from "@/modules/sessions/create-session-dialog";
import { SessionsSidebar } from "@/modules/sessions/sessions-sidebar";
import { Topbar } from "@/modules/topbar/topbar";
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
	const [showCreateDialog, setShowCreateDialog] = useState(false);
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

	const {
		sessions,
		selectedSessionId,
		createSession,
		deleteSession,
		selectSession,
		renameSession,
		searchQuery,
		setSearchQuery,
		fetchWorkDirs,
		fetchStartupDir,
		error: sessionsError,
	} = useSessions({ enabled: !shouldPauseRuntime });

	const currentSession = useMemo(
		() => sessions.find((s) => s.sessionId === selectedSessionId),
		[sessions, selectedSessionId],
	);

	const anyRunning = useMemo(
		() => sessions.some((s) => s.isRunning),
		[sessions],
	);

	useEffect(() => {
		if (sessionsError) {
			toast.error("Session Error", { description: sessionsError });
		}
	}, [sessionsError]);

	const handleCreateSession = useCallback(
		async (workDir: string) => {
			await createSession(workDir);
		},
		[createSession],
	);

	if (shouldPauseRuntime) {
		return (
			<div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background text-foreground">
				<div className="flex size-10 items-center justify-center rounded-r2 bg-bright font-mono text-[17px] font-semibold text-background">
					K
				</div>
				<p className="font-mono text-[13px] text-muted">
					{isCheckingRuntime
						? "正在检查运行环境…"
						: (runtimeCheckError ?? "运行时未就绪")}
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
		<>
			<AppShell
				rail={
					<AppRail
						sessionsActive={sidebarOpen}
						running={anyRunning}
						onToggleSessions={() => setSidebarOpen((v) => !v)}
						onNewSession={() => setShowCreateDialog(true)}
						onOpenSearch={() => {}}
						onOpenSettings={() => {}}
					/>
				}
				sidebar={
					<SessionsSidebar
						sessions={sessions}
						selectedId={selectedSessionId}
						searchQuery={searchQuery}
						onSearchQueryChange={setSearchQuery}
						onSelect={selectSession}
						onDelete={(id) => void deleteSession(id)}
						onRename={(id, title) => void renameSession(id, title)}
					/>
				}
				sidebarOpen={sidebarOpen}
				topbar={
					<Topbar
						title={currentSession?.title ?? "Kimi Code"}
						shortId={selectedSessionId ? selectedSessionId.slice(0, 6) : undefined}
						panelOpen={panelOpen}
						onTogglePanel={() => setPanelOpen((v) => !v)}
					/>
				}
				panel={null}
				panelOpen={panelOpen}
			>
				<EmptyState onNewSession={() => setShowCreateDialog(true)} />
			</AppShell>
			<CreateSessionDialog
				open={showCreateDialog}
				onOpenChange={setShowCreateDialog}
				onConfirm={handleCreateSession}
				fetchWorkDirs={fetchWorkDirs}
				fetchStartupDir={fetchStartupDir}
			/>
			<Toaster position="top-right" />
		</>
	);
}
