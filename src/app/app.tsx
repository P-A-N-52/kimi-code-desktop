import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { useTheme } from "@/hooks/use-theme";
import { useSessions } from "@/hooks/useSessions";
import type { LiveMessage } from "@/hooks/types";
import type { SessionStatus } from "@/lib/api/models";
import { shouldPauseForRuntimeReadiness } from "@/lib/runtime-readiness";
import { openKimiCodeWebsite } from "@/lib/kimi-code-link";
import {
	checkRuntimeReadiness,
	isTauri,
	type RuntimeReadiness,
	showWindow,
} from "@/lib/tauri-api";
import {
	ConversationView,
	type ConversationStreamApi,
} from "@/modules/conversation/conversation-view";
import { AppRail } from "@/modules/rail/app-rail";
import { ReadinessOverlay } from "@/modules/readiness/readiness-overlay";
import { CreateSessionDialog } from "@/modules/sessions/create-session-dialog";
import { SessionsSidebar } from "@/modules/sessions/sessions-sidebar";
import { SettingsDialog } from "@/modules/settings/settings-dialog";
import { Topbar } from "@/modules/topbar/topbar";
import { ChangesPanel } from "@/modules/workspace/changes-panel";
import { deriveChanges, derivePendingApprovals } from "@/modules/workspace/derive-changes";
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
	const [showSettings, setShowSettings] = useState(false);
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
		applySessionStatus,
		refreshSession,
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

	const [streamMessages, setStreamMessages] = useState<LiveMessage[]>([]);
	const [streamApi, setStreamApi] = useState<ConversationStreamApi | null>(null);
	const userClosedPanelRef = useRef(false);

	useEffect(() => {
		setStreamMessages([]);
		setStreamApi(null);
		userClosedPanelRef.current = false;
		setPanelOpen(false);
	}, [selectedSessionId]);

	const changes = useMemo(() => deriveChanges(streamMessages), [streamMessages]);
	const pendingApprovals = useMemo(
		() => derivePendingApprovals(streamMessages),
		[streamMessages],
	);

	useEffect(() => {
		if (changes.length > 0 && !userClosedPanelRef.current) {
			setPanelOpen(true);
		}
	}, [changes.length]);

	const handleApproveAll = useCallback(() => {
		if (!streamApi) return;
		for (const approval of pendingApprovals) {
			void streamApi.respondToApproval(approval.id, "approve");
		}
	}, [streamApi, pendingApprovals]);

	const handleRejectAll = useCallback(() => {
		if (!streamApi) return;
		for (const approval of pendingApprovals) {
			void streamApi.respondToApproval(approval.id, "reject");
		}
	}, [streamApi, pendingApprovals]);

	const handleClosePanel = useCallback(() => {
		userClosedPanelRef.current = true;
		setPanelOpen(false);
	}, []);

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

	const handleSessionStatus = useCallback(
		(status: SessionStatus) => {
			applySessionStatus(status);
			if (status.state !== "idle") return;
			const reason = status.reason ?? "";
			if (reason === "config_update") {
				window.dispatchEvent(new Event("kimi:config-update"));
			}
			if (!reason.startsWith("prompt_")) return;
			refreshSession(status.sessionId);
		},
		[applySessionStatus, refreshSession],
	);

	if (shouldPauseRuntime) {
		return (
			<ReadinessOverlay
				checking={isCheckingRuntime}
				readiness={runtimeReadiness}
				error={runtimeCheckError}
				onRetry={runRuntimeReadinessCheck}
				onContinue={() => {
					setRuntimeCheckError(null);
					setHasAcknowledgedRuntime(true);
				}}
				onOpenDownload={() => void openKimiCodeWebsite()}
			/>
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
						onOpenSettings={() => setShowSettings(true)}
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
				panel={
					<ChangesPanel
						changes={changes}
						pendingApprovals={pendingApprovals}
						onApproveAll={handleApproveAll}
						onRejectAll={handleRejectAll}
						onClose={handleClosePanel}
					/>
				}
				panelOpen={panelOpen}
			>
				{selectedSessionId ? (
					<ConversationView
						sessionId={selectedSessionId}
						currentSession={currentSession}
						onSessionStatus={handleSessionStatus}
						onMessagesChange={setStreamMessages}
						onStreamApiChange={setStreamApi}
					/>
				) : (
					<EmptyState onNewSession={() => setShowCreateDialog(true)} />
				)}
			</AppShell>
			<CreateSessionDialog
				open={showCreateDialog}
				onOpenChange={setShowCreateDialog}
				onConfirm={handleCreateSession}
				fetchWorkDirs={fetchWorkDirs}
				fetchStartupDir={fetchStartupDir}
			/>
			<SettingsDialog open={showSettings} onOpenChange={setShowSettings} />
			<Toaster position="top-right" />
		</>
	);
}
