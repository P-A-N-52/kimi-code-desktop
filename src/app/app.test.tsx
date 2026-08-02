import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UI_LANGUAGE_STORAGE_KEY, UiLanguageProvider } from "@/lib/i18n";
import App from "./app";

const mocks = vi.hoisted(() => {
	const useToolEventsStore = Object.assign(
		vi.fn((selector: (state: { currentGoal: null }) => unknown) =>
			selector({ currentGoal: null }),
		),
		{
			getState: vi.fn(() => ({ clearCurrentGoal: vi.fn() })),
		},
	);

	return {
		checkRuntimeReadiness: vi.fn(),
		isTauri: vi.fn(() => true),
		showWindow: vi.fn(() => Promise.resolve()),
		openKimiCodeWebsite: vi.fn(() => Promise.resolve()),
		useSessions: vi.fn(),
		useSessionStream: vi.fn(),
		useSessionStreamOrchestrator: vi.fn(() => null),
		useGitDiffStats: vi.fn(),
		useTheme: vi.fn(),
		useToolEventsStore,
		createConfigSessionReconnectCoordinator: vi.fn(() => ({
			handleConfigUpdate: vi.fn(),
			handleSessionStatus: vi.fn(),
		})),
	};
});

vi.mock("@/lib/tauri-api", () => ({
	SESSION_NOTIFICATION_CLICK_EVENT: "kimi:session-notification-click",
	checkRuntimeReadiness: mocks.checkRuntimeReadiness,
	isTauri: mocks.isTauri,
	showWindow: mocks.showWindow,
	openKimiCodeWebsite: mocks.openKimiCodeWebsite,
	sendNotification: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/hooks/use-theme", () => ({ useTheme: mocks.useTheme }));
vi.mock("@/hooks/useGitDiffStats", () => ({ useGitDiffStats: mocks.useGitDiffStats }));
vi.mock("@/hooks/useSessionStream", () => ({ useSessionStream: mocks.useSessionStream }));
vi.mock("@/hooks/useSessions", () => ({
	DirectoryNotFoundError: class DirectoryNotFoundError extends Error {},
	useSessions: mocks.useSessions,
}));
vi.mock("@/lib/session-stream/provider", () => ({
	useSessionStreamOrchestrator: mocks.useSessionStreamOrchestrator,
}));
vi.mock("@/lib/config-session-reconnect", () => ({
	createConfigSessionReconnectCoordinator: mocks.createConfigSessionReconnectCoordinator,
}));
vi.mock("@/lib/config-update", () => ({
	CONFIG_UPDATE_EVENT: "kimi:config-update",
	configUpdateDetailFromEvent: vi.fn(() => ({
		 restartedSessionIds: [],
		skippedBusySessionIds: [],
		failedSessionIds: [],
	})),
}));
vi.mock("@/lib/tool-events/store", () => ({
	getCurrentGoal: vi.fn(() => null),
	selectCurrentGoal: vi.fn(() => null),
	useToolEventsStore: mocks.useToolEventsStore,
}));
vi.mock("@/modules/readiness/readiness-overlay", () => ({
	ReadinessOverlay: ({ onOpenSettings }: { onOpenSettings: () => void }) => (
		<button data-testid="readiness-overlay" type="button" onClick={onOpenSettings}>
			打开配置设置
		</button>
	),
}));
vi.mock("@/modules/settings/settings-dialog", () => ({
	SettingsDialog: ({ open, initialTab }: { open: boolean; initialTab?: string }) =>
		open ? <div data-testid="settings-dialog">{initialTab}</div> : null,
}));
vi.mock("@/modules/conversation/conversation-view", () => ({
	ConversationView: () => null,
}));
vi.mock("@/modules/conversation/goal-cancel-confirmation", () => ({
	GoalCancelConfirmation: () => null,
}));
vi.mock("@/modules/sessions/app-sidebar", () => ({ AppSidebar: () => null }));
vi.mock("@/modules/topbar/topbar", () => ({ Topbar: () => null }));
vi.mock("@/modules/workspace/changes-panel", () => ({ ChangesPanel: () => null }));
vi.mock("@/app/app-shell", () => ({ AppShell: () => null }));
vi.mock("@/app/new-session-view", () => ({ NewSessionView: () => null }));
vi.mock("@/modules/workspace/derive-changes", () => ({
	deriveChanges: vi.fn(() => []),
	derivePendingApprovals: vi.fn(() => []),
	mergeGitChanges: vi.fn(() => []),
}));

function createRuntimeReadiness() {
	return {
		ok: false,
		hasBlockingIssues: false,
		checks: [],
		issues: [],
		warnings: ["Config file not found"],
		bundledRuntime: { available: false },
		externalCli: { available: true, program: "kimi", version: "0.31.0" },
		config: {
			exists: false,
			ready: false,
			hasDefaultModel: false,
			hasProviderSection: false,
			hasModelSection: false,
			hasCredentialSource: false,
			credentialSources: [],
		},
	};
}

function createReadyRuntimeReadiness() {
	const readiness = createRuntimeReadiness();
	return {
		...readiness,
		ok: true,
		warnings: [],
		config: { ...readiness.config, exists: true, ready: true },
	};
}

function installSessionMocks() {
	mocks.useSessions.mockReturnValue({
		sessions: [],
		sessionSidebarStatuses: {},
		archivedSessions: [],
		selectedSessionId: "",
		createSession: vi.fn(),
		deleteSession: vi.fn(),
		selectSession: vi.fn(),
		renameSession: vi.fn(),
		archiveSession: vi.fn(),
		unarchiveSession: vi.fn(),
		bulkArchiveSessions: vi.fn(),
		bulkUnarchiveSessions: vi.fn(),
		bulkDeleteSessions: vi.fn(),
		archiveSessionsOlderThan: vi.fn(),
		refreshArchivedSessions: vi.fn(),
		hasLoadedArchivedSessions: false,
		loadMoreSessions: vi.fn(),
		loadMoreArchivedSessions: vi.fn(),
		hasMoreSessions: false,
		hasMoreArchivedSessions: false,
		isLoading: false,
		isLoadingArchived: false,
		isLoadingMore: false,
		isLoadingMoreArchived: false,
		searchQuery: "",
		setSearchQuery: vi.fn(),
		fetchWorkDirs: vi.fn(),
		fetchStartupDir: vi.fn(() => Promise.resolve(".")),
		applySessionStatus: vi.fn(),
		refreshSession: vi.fn(),
		listSessionDirectory: vi.fn(),
		getSessionFile: vi.fn(),
		uploadSessionFile: vi.fn(),
		error: null,
	});
	mocks.useSessionStream.mockReturnValue({
		messages: [],
		sessionStatus: null,
		reconnect: vi.fn(),
		disconnect: vi.fn(() => Promise.resolve()),
		controlGoal: vi.fn(),
		permissionMode: "default",
		respondToApproval: vi.fn(),
		slashCommands: [],
	});
	mocks.useGitDiffStats.mockReturnValue({
		stats: [],
		isLoading: false,
		error: null,
		refresh: vi.fn(),
	});
}

describe("App runtime readiness", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, "zh-CN");
		mocks.isTauri.mockReturnValue(true);
		mocks.checkRuntimeReadiness.mockResolvedValue(createRuntimeReadiness());
		installSessionMocks();
	});

	const renderApp = () =>
		render(
			<UiLanguageProvider>
				<App />
			</UiLanguageProvider>,
		);

	it("opens the config settings tab without enabling session list or creation", async () => {
		renderApp();

		await waitFor(() => {
			expect(mocks.checkRuntimeReadiness).toHaveBeenCalledOnce();
		});
		expect(mocks.useSessions).toHaveBeenLastCalledWith({ enabled: false });

		fireEvent.click(screen.getByRole("button", { name: "打开配置设置" }));

		const settingsDialog = await screen.findByTestId("settings-dialog");
		expect(settingsDialog.textContent).toBe("config");
		expect(screen.queryByRole("button", { name: "打开配置设置" })).toBeNull();
		expect(mocks.useSessions).toHaveBeenLastCalledWith({ enabled: false });
	});

	it("rechecks after a config update and reblocks sessions when config becomes incomplete", async () => {
		mocks.checkRuntimeReadiness.mockReset();
		mocks.checkRuntimeReadiness
			.mockResolvedValueOnce(createReadyRuntimeReadiness())
			.mockResolvedValueOnce(createRuntimeReadiness());

		renderApp();

		await waitFor(() => {
			expect(mocks.checkRuntimeReadiness).toHaveBeenCalledOnce();
			expect(mocks.useSessions).toHaveBeenLastCalledWith({ enabled: true });
		});
		expect(screen.queryByTestId("readiness-overlay")).toBeNull();

		await act(async () => {
			window.dispatchEvent(new Event("kimi:config-update"));
		});

		await waitFor(() => {
			expect(mocks.checkRuntimeReadiness).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId("readiness-overlay")).toBeTruthy();
		});
		expect(mocks.useSessions).toHaveBeenLastCalledWith({ enabled: false });
	});
});
