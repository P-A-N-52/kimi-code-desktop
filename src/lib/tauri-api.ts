import { isTauri as _isTauri, invoke } from "@tauri-apps/api/core";
import { type Event, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SessionFileEntry } from "@/hooks/useSessions";
import { stripThinkMarkup } from "@/lib/utils";
import type {
	GitDiffStats,
	GlobalConfig,
	Session,
	SessionStatus,
	UpdateGlobalConfigResponse,
	UploadSessionFileResponse,
} from "./api/models";
import {
	instanceOfModelCapability,
	type ModelCapability,
} from "./api/models/ModelCapability";
import {
	instanceOfProviderType,
	ProviderType,
	type ProviderType as ProviderTypeValue,
} from "./api/models/ProviderType";

export type TextConfigFile = {
	content: string;
	path: string;
};

export type UpdateTextConfigResponse = {
	success: boolean;
	error?: string | null;
};

export type WireEventPayload = {
	session_id: string;
	message: string;
};

export type RuntimeReadinessCheck = {
	id: string;
	label: string;
	status: "ok" | "warning" | "error";
	detail: string;
};

export type RuntimeReadiness = {
	ok: boolean;
	hasBlockingIssues: boolean;
	checks: RuntimeReadinessCheck[];
	issues: string[];
	warnings: string[];
	bundledRuntime: {
		available: boolean;
		version?: string | null;
		packagePath?: string | null;
		executable?: string | null;
		error?: string | null;
	};
	externalCli: {
		available: boolean;
		program?: string | null;
		version?: string | null;
		error?: string | null;
	};
	config: {
		path?: string | null;
		exists: boolean;
		ready: boolean;
		hasDefaultModel: boolean;
		hasProviderSection: boolean;
		hasModelSection: boolean;
		hasCredentialSource: boolean;
		credentialSources: string[];
		error?: string | null;
	};
};

export function isTauri(): boolean {
	if (typeof window === "undefined") return false;
	return (
		_isTauri() ||
		(globalThis as unknown as Record<string, unknown>).isTauri === true ||
		typeof (window as unknown as Record<string, unknown>)
			.__TAURI_INTERNALS__ !== "undefined" ||
		typeof (window as unknown as Record<string, unknown>).__TAURI__ !==
			"undefined"
	);
}

export async function showWindow(): Promise<void> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	return invoke<void>("show_window");
}

export async function hideWindow(): Promise<void> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	return invoke<void>("hide_window");
}

export async function getAppVersion(): Promise<string> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	return invoke<string>("get_app_version");
}

export async function getKimiCliVersion(): Promise<string> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	return invoke<string>("get_kimi_cli_version");
}

export type ManagedUsageInvokeResult =
	| { kind: "ok"; payload: unknown }
	| { kind: "error"; message: string };

export async function fetchManagedUsage(): Promise<ManagedUsageInvokeResult> {
	if (!isTauri()) {
		return {
			kind: "error",
			message: "Managed usage is only available in the desktop app.",
		};
	}
	const raw = await invoke<Record<string, unknown>>("fetch_managed_usage");
	if (raw.kind === "ok") {
		return { kind: "ok", payload: raw.payload };
	}
	return {
		kind: "error",
		message:
			typeof raw.message === "string" && raw.message.length > 0
				? raw.message
				: "Failed to fetch usage",
	};
}

export async function fetchUsageStats(
	range: "today" | "7d" | "30d",
): Promise<unknown> {
	if (!isTauri()) {
		throw new Error("Usage stats are only available in the desktop app.");
	}
	return invoke<unknown>("fetch_usage_stats", { range });
}

export async function checkRuntimeReadiness(): Promise<RuntimeReadiness> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<Record<string, unknown>>("check_runtime_readiness");
	return normalizeRuntimeReadiness(raw);
}

export async function openKimiLogin(): Promise<{
	success: boolean;
	program: string;
}> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<Record<string, unknown>>("open_kimi_login");
	return {
		success: Boolean(raw.success),
		program: String(raw.program ?? ""),
	};
}

export type KimiLoginStart = {
	loginId: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	expiresIn: number | null;
	interval: number;
};

export type KimiLoginPollResult =
	| { kind: "pending"; errorCode?: string; interval?: number }
	| { kind: "success" }
	| { kind: "expired" }
	| { kind: "denied"; message?: string }
	| { kind: "cancelled" }
	| { kind: "error"; message: string };

export async function startKimiLogin(): Promise<KimiLoginStart> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<Record<string, unknown>>("start_kimi_login");
	return {
		loginId: String(raw.loginId ?? ""),
		userCode: String(raw.userCode ?? ""),
		verificationUri: String(raw.verificationUri ?? ""),
		verificationUriComplete: String(raw.verificationUriComplete ?? ""),
		expiresIn:
			typeof raw.expiresIn === "number"
				? raw.expiresIn
				: raw.expiresIn == null
					? null
					: Number(raw.expiresIn) || null,
		interval: Math.max(1, Number(raw.interval) || 5),
	};
}

export async function pollKimiLogin(
	loginId: string,
): Promise<KimiLoginPollResult> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<Record<string, unknown>>("poll_kimi_login", {
		loginId,
	});
	const kind = String(raw.kind ?? "error");
	switch (kind) {
		case "pending":
			return {
				kind: "pending",
				errorCode:
					typeof raw.errorCode === "string" ? raw.errorCode : undefined,
				interval:
					typeof raw.interval === "number" ? raw.interval : undefined,
			};
		case "success":
			return { kind: "success" };
		case "expired":
			return { kind: "expired" };
		case "denied":
			return {
				kind: "denied",
				message: typeof raw.message === "string" ? raw.message : undefined,
			};
		case "cancelled":
			return { kind: "cancelled" };
		default:
			return {
				kind: "error",
				message:
					typeof raw.message === "string" && raw.message.length > 0
						? raw.message
						: "Login failed",
			};
	}
}

export async function cancelKimiLogin(loginId: string): Promise<void> {
	if (!isTauri()) return;
	await invoke("cancel_kimi_login", { loginId });
}

export async function kimiCredentialsStatus(): Promise<{ present: boolean }> {
	if (!isTauri()) return { present: false };
	const raw = await invoke<Record<string, unknown>>("kimi_credentials_status");
	return { present: Boolean(raw.present) };
}

export async function logoutKimi(): Promise<{ success: boolean; present: boolean }> {
	if (!isTauri()) {
		return Promise.reject(new Error("Not in Tauri"));
	}
	const raw = await invoke<Record<string, unknown>>("logout_kimi");
	if (raw.success === false) {
		throw new Error(
			typeof raw.message === "string" && raw.message.length > 0
				? raw.message
				: "Logout failed",
		);
	}
	return {
		success: Boolean(raw.success),
		present: Boolean(raw.present),
	};
}

export async function openExternal(url: string): Promise<void> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	return invoke<void>("open_external", { url });
}

export async function openInExplorer(path: string): Promise<void> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	return invoke<void>("open_in_explorer", { path });
}

export async function openInEditor(
	path: string,
	editor?: string,
): Promise<void> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	return invoke<void>("open_in_editor", { path, editor: editor ?? "vscode" });
}

export async function wireConnect(sessionId: string, connectionId: string): Promise<void> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	return invoke<void>("wire_connect", { sessionId, connectionId });
}

export async function wireDisconnect(sessionId: string, connectionId: string): Promise<void> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	return invoke<void>("wire_disconnect", { sessionId, connectionId });
}

export async function wireSend(
	sessionId: string,
	message: unknown,
): Promise<void> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const serialized =
		typeof message === "string" ? message : JSON.stringify(message);
	return invoke<void>("wire_send", { sessionId, message: serialized });
}

export async function wireStatus(
	sessionId: string,
): Promise<SessionStatus | null> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<Record<string, unknown> | null>("wire_status", {
		sessionId,
	});
	return raw ? normalizeSessionStatus(raw) : null;
}

export function onWireMessage(
	sessionId: string,
	callback: (message: string) => void,
): () => void {
	return listenEvent("wire:message", (payload) => {
		const eventPayload = payload as WireEventPayload | undefined;
		if (
			eventPayload?.session_id === sessionId &&
			typeof eventPayload.message === "string"
		) {
			callback(eventPayload.message);
		}
	});
}

export async function listSessions(args?: {
	limit?: number;
	offset?: number;
	q?: string;
	archived?: boolean;
}): Promise<Session[]> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<unknown[]>("list_sessions", args ?? {});
	return raw.map((item) => normalizeSession(item as Record<string, unknown>));
}

export async function getSession(sessionId: string): Promise<Session | null> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<Record<string, unknown> | null>("get_session", {
		sessionId,
	});
	return raw ? normalizeSession(raw) : null;
}

export async function replaySessionHistory(
	sessionId: string,
): Promise<string[]> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<unknown[]>("replay_session_history", { sessionId });
	return raw.map(String);
}

export async function getSessionSwarmMode(sessionId: string): Promise<boolean> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	return Boolean(await invoke<unknown>("get_session_swarm_mode", { sessionId }));
}

export async function migrateSessionSwarmMode(
	sessionId: string,
	enabled: boolean,
): Promise<void> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	return invoke<void>("migrate_session_swarm_mode", { sessionId, enabled });
}

export async function createSession(
	workDir?: string,
	createDir?: boolean,
): Promise<Session> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<Record<string, unknown>>("create_session", {
		workDir,
		createDir,
	});
	return normalizeSession(raw);
}

export async function deleteSession(sessionId: string): Promise<void> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	return invoke<void>("delete_session", { sessionId });
}

export async function updateSession(args: {
	sessionId: string;
	title?: string;
	archived?: boolean;
}): Promise<Session> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<Record<string, unknown>>("update_session", args);
	return normalizeSession(raw);
}

export async function forkSession(
	sessionId: string,
	turnIndex: number,
): Promise<Session> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<Record<string, unknown>>("fork_session", {
		sessionId,
		turnIndex,
	});
	return normalizeSession(raw);
}

export async function generateTitle(
	sessionId: string,
): Promise<{ title: string }> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<Record<string, unknown>>("generate_title", {
		sessionId,
	});
	return { title: String(raw.title ?? "") };
}

export async function uploadSessionFile(
	sessionId: string,
	file: File,
): Promise<UploadSessionFileResponse> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const buffer = await file.arrayBuffer();
	const data = Array.from(new Uint8Array(buffer));
	const raw = await invoke<Record<string, unknown>>("upload_session_file", {
		sessionId,
		filename: file.name,
		data,
	});
	return {
		path: String(raw.path ?? ""),
		filename: String(raw.filename ?? ""),
		size: Number(raw.size ?? 0),
	};
}

export async function listSessionDirectory(
	sessionId: string,
	path?: string,
): Promise<SessionFileEntry[]> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<unknown[]>("list_session_directory", {
		sessionId,
		path: path ?? ".",
	});
	return raw.map((item) => {
		const entry = item as Record<string, unknown>;
		return {
			name: String(entry.name ?? ""),
			type: entry.type === "directory" ? "directory" : "file",
			size: typeof entry.size === "number" ? entry.size : undefined,
		};
	});
}

export async function getSessionFile(
	sessionId: string,
	path: string,
): Promise<Blob> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<Record<string, unknown>>("get_session_file", {
		sessionId,
		path,
	});
	return filePayloadToBlob(raw);
}

export async function getSessionUploadFile(
	sessionId: string,
	filename: string,
): Promise<Blob> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<Record<string, unknown>>("get_session_upload_file", {
		sessionId,
		filename,
	});
	return filePayloadToBlob(raw);
}

export async function listWorkDirs(): Promise<string[]> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<unknown[]>("list_work_dirs");
	return raw.map(String);
}

export async function getStartupDir(): Promise<string> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	return String(await invoke<unknown>("get_startup_dir"));
}

export async function getGlobalConfig(): Promise<GlobalConfig> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<Record<string, unknown>>("get_global_config");
	return normalizeGlobalConfig(raw);
}

export async function getConfigToml(): Promise<TextConfigFile> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<Record<string, unknown>>("get_config_toml");
	return normalizeTextConfigFile(raw);
}

export async function updateConfigToml(
	content: string,
): Promise<UpdateTextConfigResponse> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<Record<string, unknown>>("update_config_toml", {
		content,
	});
	return normalizeUpdateTextConfigResponse(raw);
}

export async function getMcpConfig(): Promise<TextConfigFile> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<Record<string, unknown>>("get_mcp_config");
	return normalizeTextConfigFile(raw);
}

export async function updateMcpConfig(
	content: string,
): Promise<UpdateTextConfigResponse> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<Record<string, unknown>>("update_mcp_config", {
		content,
	});
	return normalizeUpdateTextConfigResponse(raw);
}

export async function updateGlobalConfig(args: {
	defaultModel?: string;
	defaultThinking?: boolean;
	defaultPlanMode?: boolean;
	restartRunningSessions?: boolean;
	forceRestartBusySessions?: boolean;
}): Promise<UpdateGlobalConfigResponse> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const raw = await invoke<Record<string, unknown>>("update_global_config", {
		defaultModel: args.defaultModel,
		defaultThinking: args.defaultThinking,
		defaultPlanMode: args.defaultPlanMode,
		restartRunningSessions: args.restartRunningSessions,
		forceRestartBusySessions: args.forceRestartBusySessions,
	});
	return {
		config: normalizeGlobalConfig(raw.config as Record<string, unknown>),
		restartedSessionIds:
			(raw.restarted_session_ids as string[] | null | undefined) ?? undefined,
		skippedBusySessionIds:
			(raw.skipped_busy_session_ids as string[] | null | undefined) ??
			undefined,
	};
}

export async function getGitDiffStats(
	sessionId: string,
): Promise<GitDiffStats> {
	if (!isTauri()) return Promise.reject(new Error("Not in Tauri"));
	const data = await invoke<Record<string, unknown>>("get_git_diff_stats", {
		sessionId,
	});
	return {
		isGitRepo: Boolean(data.is_git_repo),
		hasChanges: Boolean(data.has_changes),
		totalAdditions: Number(data.total_additions ?? 0),
		totalDeletions: Number(data.total_deletions ?? 0),
		files: (
			(data.files as Array<Record<string, unknown>> | undefined) ?? []
		).map((file) => ({
			path: String(file.path ?? ""),
			additions: Number(file.additions ?? 0),
			deletions: Number(file.deletions ?? 0),
			status: file.status as "added" | "modified" | "deleted" | "renamed",
		})),
		error: typeof data.error === "string" ? data.error : undefined,
	};
}

export async function sendNotification(
	title: string,
	body: string,
): Promise<void> {
	if (!isTauri()) {
		return Promise.reject(new Error("Not in Tauri"));
	}

	if (!("Notification" in window)) {
		return Promise.reject(new Error("Notifications not supported"));
	}

	const permission = await Notification.requestPermission();
	if (permission !== "granted") {
		return Promise.reject(new Error("Notification permission denied"));
	}

	new Notification(title, { body });
}

export function onNotificationClick(
	callback: (event: { session_id: string; request_id: string }) => void,
): () => void {
	let unlisten: UnlistenFn | undefined;
	let cleanedUp = false;

	const setup = async () => {
		if (!isTauri()) return;
		unlisten = await listen(
			"notification:approval",
			(event: Event<unknown>) => {
				const payload = event.payload as Record<string, unknown> | undefined;
				if (
					payload &&
					typeof payload.session_id === "string" &&
					typeof payload.request_id === "string"
				) {
					callback({
						session_id: payload.session_id,
						request_id: payload.request_id,
					});
				}
			},
		);
		if (cleanedUp && unlisten) {
			unlisten();
		}
	};

	setup();

	return () => {
		cleanedUp = true;
		if (unlisten) {
			unlisten();
		}
	};
}

export function listenEvent(
	event: string,
	callback: (payload: unknown) => void,
): () => void {
	let unlisten: UnlistenFn | undefined;
	let cleanedUp = false;

	const setup = async () => {
		if (!isTauri()) return;
		unlisten = await listen(event, (evt: Event<unknown>) => {
			callback(evt.payload);
		});
		if (cleanedUp && unlisten) {
			unlisten();
		}
	};

	setup();

	return () => {
		cleanedUp = true;
		if (unlisten) {
			unlisten();
		}
	};
}

function normalizeSession(raw: Record<string, unknown>): Session {
	return {
		sessionId: String(raw.session_id ?? raw.sessionId ?? ""),
		title:
			stripThinkMarkup(String(raw.title ?? "Untitled")).trim() || "Untitled",
		lastUpdated: new Date(
			String(raw.last_updated ?? raw.lastUpdated ?? Date.now()),
		),
		isRunning: Boolean(raw.is_running ?? raw.isRunning),
		status: raw.status
			? normalizeSessionStatus(raw.status as Record<string, unknown>)
			: undefined,
		workDir:
			typeof raw.work_dir === "string"
				? raw.work_dir
				: typeof raw.workDir === "string"
					? raw.workDir
					: undefined,
		sessionDir:
			typeof raw.session_dir === "string"
				? raw.session_dir
				: typeof raw.sessionDir === "string"
					? raw.sessionDir
					: undefined,
		archived: Boolean(raw.archived),
	};
}

function normalizeSessionStatus(raw: Record<string, unknown>): SessionStatus {
	return {
		sessionId: String(raw.session_id ?? raw.sessionId ?? ""),
		state: raw.state as SessionStatus["state"],
		seq: Number(raw.seq ?? 0),
		workerId:
			typeof raw.worker_id === "string"
				? raw.worker_id
				: typeof raw.workerId === "string"
					? raw.workerId
					: undefined,
		reason: typeof raw.reason === "string" ? raw.reason : undefined,
		detail: typeof raw.detail === "string" ? raw.detail : undefined,
		updatedAt: new Date(
			typeof raw.updated_at === "number"
				? raw.updated_at
				: typeof raw.updated_at === "string"
					? raw.updated_at
					: typeof raw.updatedAt === "number"
						? raw.updatedAt
						: typeof raw.updatedAt === "string"
							? raw.updatedAt
							: Date.now(),
		),
	};
}

function normalizeCapabilities(raw: unknown): Set<ModelCapability> | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const capabilities = raw.filter((value): value is ModelCapability =>
		instanceOfModelCapability(value),
	);
	return capabilities.length > 0 ? new Set(capabilities) : undefined;
}

function normalizeProviderType(raw: unknown): ProviderTypeValue {
	const value = String(raw ?? "");
	if (instanceOfProviderType(value)) {
		return value as ProviderTypeValue;
	}
	return ProviderType.Kimi;
}

function normalizeGlobalConfig(raw: Record<string, unknown>): GlobalConfig {
	const models =
		(raw.models as Array<Record<string, unknown>> | undefined) ?? [];
	return {
		defaultModel: String(raw.default_model ?? raw.defaultModel ?? ""),
		defaultThinking: Boolean(raw.default_thinking ?? raw.defaultThinking),
		defaultPlanMode: Boolean(raw.default_plan_mode ?? raw.defaultPlanMode),
		defaultPermissionMode: String(
			raw.default_permission_mode ?? raw.defaultPermissionMode ?? "manual",
		),
		models: models.map((model) => ({
			provider: String(model.provider ?? ""),
			model: String(model.model ?? ""),
			maxContextSize: Number(
				model.max_context_size ?? model.maxContextSize ?? 0,
			),
			capabilities: normalizeCapabilities(model.capabilities),
			name: String(model.name ?? ""),
			providerType: normalizeProviderType(
				model.provider_type ?? model.providerType,
			),
		})),
	};
}

function normalizeTextConfigFile(raw: Record<string, unknown>): TextConfigFile {
	return {
		content: String(raw.content ?? ""),
		path: String(raw.path ?? ""),
	};
}

function normalizeUpdateTextConfigResponse(
	raw: Record<string, unknown>,
): UpdateTextConfigResponse {
	return {
		success: Boolean(raw.success),
		error: typeof raw.error === "string" ? raw.error : null,
	};
}

function normalizeRuntimeReadiness(
	raw: Record<string, unknown>,
): RuntimeReadiness {
	const bundledRuntime =
		(raw.bundledRuntime as Record<string, unknown> | undefined) ?? {};
	const externalCli =
		(raw.externalCli as Record<string, unknown> | undefined) ?? {};
	const config = (raw.config as Record<string, unknown> | undefined) ?? {};
	return {
		ok: Boolean(raw.ok),
		hasBlockingIssues: Boolean(raw.hasBlockingIssues),
		checks: (
			(raw.checks as Array<Record<string, unknown>> | undefined) ?? []
		).map((check) => ({
			id: String(check.id ?? ""),
			label: String(check.label ?? ""),
			status:
				check.status === "ok" ||
				check.status === "warning" ||
				check.status === "error"
					? check.status
					: "error",
			detail: String(check.detail ?? ""),
		})),
		issues: ((raw.issues as unknown[] | undefined) ?? []).map(String),
		warnings: ((raw.warnings as unknown[] | undefined) ?? []).map(String),
		bundledRuntime: {
			available: Boolean(bundledRuntime.available),
			version:
				typeof bundledRuntime.version === "string"
					? bundledRuntime.version
					: null,
			packagePath:
				typeof bundledRuntime.packagePath === "string"
					? bundledRuntime.packagePath
					: null,
			executable:
				typeof bundledRuntime.executable === "string"
					? bundledRuntime.executable
					: null,
			error:
				typeof bundledRuntime.error === "string" ? bundledRuntime.error : null,
		},
		externalCli: {
			available: Boolean(externalCli.available),
			program:
				typeof externalCli.program === "string" ? externalCli.program : null,
			version:
				typeof externalCli.version === "string" ? externalCli.version : null,
			error: typeof externalCli.error === "string" ? externalCli.error : null,
		},
		config: {
			path: typeof config.path === "string" ? config.path : null,
			exists: Boolean(config.exists),
			ready: Boolean(config.ready),
			hasDefaultModel: Boolean(config.hasDefaultModel),
			hasProviderSection: Boolean(config.hasProviderSection),
			hasModelSection: Boolean(config.hasModelSection),
			hasCredentialSource: Boolean(config.hasCredentialSource),
			credentialSources: (
				(config.credentialSources as unknown[] | undefined) ?? []
			).map(String),
			error: typeof config.error === "string" ? config.error : null,
		},
	};
}

function filePayloadToBlob(raw: Record<string, unknown>): Blob {
	const bytes = (raw.data as number[] | undefined) ?? [];
	const contentType =
		typeof raw.content_type === "string"
			? raw.content_type
			: "application/octet-stream";
	return new Blob([new Uint8Array(bytes)], { type: contentType });
}
