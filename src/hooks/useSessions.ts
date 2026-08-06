import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Session, SessionStatus, UploadSessionFileResponse } from "../lib/api/models";
import { SessionFromJSON } from "../lib/api/models/Session";
import { apiClient } from "../lib/apiClient";
import { getAuthHeader, getAuthToken } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import type { WorkspaceFileEntry } from "../lib/workspace-file-entry";
import {
	isTauri,
	createSession as tauriCreateSession,
	deleteSession as tauriDeleteSession,
	deleteUploadedFile as tauriDeleteUploadedFile,
	forkSession as tauriForkSession,
	getSession as tauriGetSession,
	getSessionFile as tauriGetSessionFile,
	getStartupDir as tauriGetStartupDir,
	listSessionDirectory as tauriListSessionDirectory,
	listSessions as tauriListSessions,
	listWorkDirs as tauriListWorkDirs,
	updateSession as tauriUpdateSession,
	updateSessionsArchive as tauriUpdateSessionsArchive,
	updateWorkDirArchive as tauriUpdateWorkDirArchive,
	uploadSessionFile as tauriUploadSessionFile,
} from "../lib/tauri-api";
import { selectSessionsOlderThan, STALE_ARCHIVE_DAYS } from "../modules/sessions/stale-sessions";
import { formatRelativeTime, getApiBaseUrl } from "./utils";

// Regex patterns for path normalization
const LEADING_DOT_SLASH_REGEX = /^\.\/+/;
const LEADING_SLASH_REGEX = /^\/+/;
const TRAILING_WHITESPACE_REGEX = /\s+$/;

export type SessionFileEntry = WorkspaceFileEntry;

type UseSessionsReturn = {
	/** List of sessions (API Session type) */
	sessions: Session[];
	/** List of archived sessions */
	archivedSessions: Session[];
	/** Whether the first archived page has been loaded at least once */
	hasLoadedArchivedSessions: boolean;
	/** Currently selected session ID */
	selectedSessionId: string;
	/** Loading state */
	isLoading: boolean;
	/** Loading state for archived sessions */
	isLoadingArchived: boolean;
	/** Error message if any */
	error: string | null;
	/** Refresh sessions list from API */
	refreshSessions: () => Promise<void>;
	/** Refresh archived sessions list from API */
	refreshArchivedSessions: () => Promise<void>;
	/** Load more sessions for pagination */
	loadMoreSessions: () => Promise<void>;
	/** Load more archived sessions for pagination */
	loadMoreArchivedSessions: () => Promise<void>;
	/** Whether there are more sessions to load */
	hasMoreSessions: boolean;
	/** Whether there are more archived sessions to load */
	hasMoreArchivedSessions: boolean;
	/** Loading state for pagination */
	isLoadingMore: boolean;
	/** Loading state for archived pagination */
	isLoadingMoreArchived: boolean;
	/** Current search query */
	searchQuery: string;
	/** Update search query */
	setSearchQuery: (query: string) => void;
	/** Refresh a single session's data from API */
	refreshSession: (sessionId: string) => Promise<Session | null>;
	/** Create a new session */
	createSession: (workDir?: string, createDir?: boolean) => Promise<Session>;
	/** Delete a session by ID */
	deleteSession: (sessionId: string) => Promise<boolean>;
	/** Select a session */
	selectSession: (sessionId: string) => void;
	/** Apply a runtime session status update */
	applySessionStatus: (status: SessionStatus) => void;
	/** Get formatted relative time for a session */
	getRelativeTime: (session: Session) => string;
	/** Upload a file to a session's work_dir */
	uploadSessionFile: (
		sessionId: string,
		file: File,
	) => Promise<UploadSessionFileResponse>;
	deleteUploadedFile: (fileId: string) => Promise<void>;
	/** List files in a session's work_dir path */
	listSessionDirectory: (
		sessionId: string,
		path?: string,
	) => Promise<SessionFileEntry[]>;
	/** Get a file from a session's work_dir */
	getSessionFile: (sessionId: string, path: string) => Promise<Blob>;
	/** Get the URL for a session file (for direct access/download) */
	getSessionFileUrl: (sessionId: string, path: string) => string;
	/** Fetch available work directories */
	fetchWorkDirs: () => Promise<string[]>;
	/** Fetch the startup directory */
	fetchStartupDir: () => Promise<string>;
	/** Rename a session */
	renameSession: (sessionId: string, title: string) => Promise<boolean>;
	/** Archive a session */
	archiveSession: (sessionId: string) => Promise<boolean>;
	/** Unarchive a session */
	unarchiveSession: (sessionId: string) => Promise<boolean>;
	/** Archive or restore every session in a project group */
	archiveProjectSessions: (
		sessionIds: string[],
		archived: boolean,
		workDir?: string,
	) => Promise<number>;
	/** Bulk archive sessions */
	bulkArchiveSessions: (sessionIds: string[]) => Promise<number>;
	/** Bulk unarchive sessions */
	bulkUnarchiveSessions: (sessionIds: string[]) => Promise<number>;
	/** Bulk delete sessions */
	bulkDeleteSessions: (sessionIds: string[]) => Promise<number>;
	/**
	 * Archive all non-running active sessions whose last activity is older than
	 * `days` (default 30). Pages through the full active list.
	 */
	archiveSessionsOlderThan: (days?: number) => Promise<number>;
	/** Fork a session at a specific turn index */
	forkSession: (sessionId: string, turnIndex: number) => Promise<Session>;
};

type UseSessionsOptions = {
	enabled?: boolean;
};

const normalizeSessionPath = (value?: string): string => {
	if (!value) {
		return ".";
	}
	const trimmed = value.trim();
	if (trimmed === "" || trimmed === "/" || trimmed === ".") {
		return ".";
	}
	const stripped = trimmed
		.replace(LEADING_DOT_SLASH_REGEX, "")
		.replace(LEADING_SLASH_REGEX, "")
		.replace(TRAILING_WHITESPACE_REGEX, "");
	return stripped === "" ? "." : stripped;
};

/** Max page size allowed by list_sessions (Tauri clamp / API docs). */
const LIST_FETCH_PAGE_SIZE = 500;
const AUTO_REFRESH_MS = 30_000;
const TAURI_AUTO_REFRESH_MS = 120_000;

async function fetchAllSessionsPage(args: {
	archived?: boolean;
	q?: string;
}): Promise<Session[]> {
	const all: Session[] = [];
	let offset = 0;
	for (;;) {
		const page = isTauri()
			? await tauriListSessions({
					limit: LIST_FETCH_PAGE_SIZE,
					offset,
					archived: args.archived,
					q: args.q,
				})
			: await apiClient.sessions.listSessionsApiSessionsGet({
					limit: LIST_FETCH_PAGE_SIZE,
					offset,
					archived: args.archived,
					q: args.q,
				});
		all.push(...page);
		if (page.length < LIST_FETCH_PAGE_SIZE) break;
		offset += page.length;
	}
	return all;
}

async function fetchAllArchivedSessionsHttp(): Promise<Session[]> {
	const basePath = getApiBaseUrl();
	const all: Session[] = [];
	let offset = 0;
	for (;;) {
		const response = await fetch(
			`${basePath}/api/sessions/?archived=true&limit=${LIST_FETCH_PAGE_SIZE}&offset=${offset}`,
			{ headers: getAuthHeader() },
		);
		if (!response.ok) {
			throw new Error("Failed to load archived sessions");
		}
		const data = await response.json();
		const page: Session[] = data.map((item: Record<string, unknown>) => ({
			sessionId: item.session_id as string,
			title: item.title as string,
			lastUpdated: new Date(item.last_updated as string),
			isRunning: item.is_running as boolean,
			status: item.status as SessionStatus | undefined,
			workDir: item.work_dir as string | undefined,
			sessionDir: item.session_dir as string | undefined,
			archived: item.archived as boolean,
		}));
		all.push(...page);
		if (page.length < LIST_FETCH_PAGE_SIZE) break;
		offset += page.length;
	}
	return all;
}

function normalizeProjectWorkDir(value: string): string {
	const normalized = value.trim().replace(/\\/g, "/");
	if (normalized === "/" || /^[a-zA-Z]:\/$/.test(normalized)) return normalized;
	return normalized.replace(/\/+$/, "");
}

async function resolveProjectSessions(
	workDir: string,
	fallbackSessions: Session[],
	knownSessions: Session[],
): Promise<Session[]> {
	const candidates = new Map<string, Session>();
	for (const session of knownSessions) candidates.set(session.sessionId, session);

	const pages = await Promise.allSettled([
		fetchAllSessionsPage({ archived: false }),
		fetchAllSessionsPage({ archived: true }),
	]);
	for (const page of pages) {
		if (page.status !== "fulfilled") continue;
		for (const session of page.value) candidates.set(session.sessionId, session);
	}

	const target = normalizeProjectWorkDir(workDir);
	const resolvedSessions = [...candidates.values()]
		.filter(
			(session) =>
				typeof session.workDir === "string" &&
				normalizeProjectWorkDir(session.workDir) === target,
		)

	return resolvedSessions.length > 0 ? resolvedSessions : fallbackSessions;
}

/**
 * Custom error class for directory not found
 */
export class DirectoryNotFoundError extends Error {
	isDirectoryNotFound = true;
	constructor(message: string) {
		super(message);
		this.name = "DirectoryNotFoundError";
	}
}

/**
 * Hook for managing sessions with real API calls
 */
export function useSessions(
	options: UseSessionsOptions = {},
): UseSessionsReturn {
	const { resolvedLanguage } = useI18n();
	const enabled = options.enabled ?? true;
	// Sessions list (using API Session type)
	const [sessions, setSessions] = useState<Session[]>([]);

	// Archived sessions list
	const [archivedSessions, setArchivedSessions] = useState<Session[]>([]);
	const [hasLoadedSessions, setHasLoadedSessions] = useState(false);
	const [hasLoadedArchivedSessions, setHasLoadedArchivedSessions] =
		useState(false);

	// Currently selected session
	const [selectedSessionId, setSelectedSessionId] = useState<string>("");

	// Loading and error states
	const [isLoading, setIsLoading] = useState(false);
	const [isLoadingArchived, setIsLoadingArchived] = useState(false);
	// Lists are fully loaded on refresh; keep these fields for sidebar API compatibility.
	const isLoadingMore = false;
	const isLoadingMoreArchived = false;
	const [error, setError] = useState<string | null>(null);

	const [hasMoreSessions, setHasMoreSessions] = useState(false);
	const [hasMoreArchivedSessions, setHasMoreArchivedSessions] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const lastRefreshRef = useRef(0);
	const refreshRequestIdRef = useRef(0);
	const archivedRefreshInFlightRef = useRef<Promise<void> | null>(null);
	const archivedRefreshVersionRef = useRef(0);
	const archivedRefreshQueuedRef = useRef(false);
	const archivedPreloadRequestedRef = useRef(false);

	/**
	 * Refresh sessions list from API
	 */
	const refreshSessions = useCallback(async () => {
		if (!enabled) {
			return;
		}
		const requestId = ++refreshRequestIdRef.current;
		setIsLoading(true);
		setError(null);

		try {
			// Load the full active list once; sidebar search filters client-side.
			// Passing `q` here used to re-hit ACP on every keystroke under high latency.
			const sessionsList = await fetchAllSessionsPage({
				archived: false,
			});

			if (requestId !== refreshRequestIdRef.current) return;
			setSessions(sessionsList);
			setHasMoreSessions(false);
			setHasLoadedSessions(true);
			lastRefreshRef.current = Date.now();
		} catch (err) {
			if (requestId !== refreshRequestIdRef.current) return;
			const message =
				err instanceof Error ? err.message : "Failed to load sessions";
			setError(message);
			console.error("Failed to refresh sessions:", err);
		} finally {
			if (requestId === refreshRequestIdRef.current) setIsLoading(false);
		}
	}, [enabled]);

	const loadMoreSessions = useCallback(async () => {
		// Sessions are fully loaded on refresh; keep for API compatibility.
		return;
	}, []);

	const applySessionStatus = useCallback((status: SessionStatus) => {
		setSessions((current) =>
			current.map((session) =>
				session.sessionId === status.sessionId
					? {
							...session,
							status,
							isRunning: status.state === "busy" || status.state === "idle",
						}
					: session,
			),
		);
	}, []);

	/**
	 * Refresh archived sessions list from API
	 */
	const refreshArchivedSessions = useCallback(async () => {
		if (!enabled) {
			return;
		}

		archivedRefreshVersionRef.current += 1;
		archivedRefreshQueuedRef.current = true;
		if (archivedRefreshInFlightRef.current) {
			await archivedRefreshInFlightRef.current;
			return;
		}

		const refresh = (async () => {
			while (archivedRefreshQueuedRef.current) {
				archivedRefreshQueuedRef.current = false;
				const requestedVersion = archivedRefreshVersionRef.current;
				setIsLoadingArchived(true);
				try {
					const archivedList = isTauri()
						? await fetchAllSessionsPage({ archived: true })
						: await fetchAllArchivedSessionsHttp();

					// Archive/unarchive can finish while an older list request is in
					// flight. Never let that older response replace the latest state.
					if (requestedVersion !== archivedRefreshVersionRef.current) {
						continue;
					}
					setArchivedSessions(archivedList);
					setHasMoreArchivedSessions(false);
					setHasLoadedArchivedSessions(true);
				} catch (err) {
					if (requestedVersion !== archivedRefreshVersionRef.current) {
						continue;
					}
					const message =
						err instanceof Error ? err.message : "Failed to load archived sessions";
					setError(message);
					setHasLoadedArchivedSessions(false);
					toast.error(message);
					console.error("Failed to refresh archived sessions:", err);
				} finally {
					if (
						requestedVersion === archivedRefreshVersionRef.current &&
						!archivedRefreshQueuedRef.current
					) {
						setIsLoadingArchived(false);
					}
				}
			}
		})();

		archivedRefreshInFlightRef.current = refresh;
		try {
			await refresh;
		} finally {
			if (archivedRefreshInFlightRef.current === refresh) {
				archivedRefreshInFlightRef.current = null;
			}
		}
	}, [enabled]);

	useEffect(() => {
		if (!enabled) {
			return;
		}
		if (!hasLoadedSessions || hasLoadedArchivedSessions) {
			return;
		}
		if (searchQuery.trim()) {
			return;
		}
		if (archivedPreloadRequestedRef.current || isLoadingArchived) {
			return;
		}

		archivedPreloadRequestedRef.current = true;
		const loadArchived = () => {
			void refreshArchivedSessions();
		};

		const idleWindow = window as Window & {
			requestIdleCallback?: (
				callback: IdleRequestCallback,
				options?: IdleRequestOptions,
			) => number;
			cancelIdleCallback?: (handle: number) => void;
		};

		if (idleWindow.requestIdleCallback) {
			const idleId = idleWindow.requestIdleCallback(loadArchived, {
				timeout: 1_500,
			});
			return () => idleWindow.cancelIdleCallback?.(idleId);
		}

		const timeoutId = window.setTimeout(loadArchived, 500);
		return () => window.clearTimeout(timeoutId);
	}, [
		enabled,
		hasLoadedArchivedSessions,
		hasLoadedSessions,
		isLoadingArchived,
		refreshArchivedSessions,
		searchQuery,
	]);

	/**
	 * Load more archived sessions for pagination
	 */
	const loadMoreArchivedSessions = useCallback(async () => {
		// Archived sessions are fully loaded on refresh; keep for API compatibility.
		return;
	}, []);

	// Initial + enabled-gated refresh (search is client-side — do not refetch on typing).
	useEffect(() => {
		if (!enabled) {
			return;
		}
		void refreshSessions();
	}, [enabled, refreshSessions]);

	// Refresh when returning to the tab (throttled)
	useEffect(() => {
		if (!enabled) {
			return;
		}
		const handleVisibilityChange = () => {
			if (document.visibilityState !== "visible") {
				return;
			}
			const now = Date.now();
			if (now - lastRefreshRef.current < 60_000) {
				return;
			}
			refreshSessions();
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () =>
			document.removeEventListener("visibilitychange", handleVisibilityChange);
	}, [enabled, refreshSessions]);

	// Periodic refresh to catch sessions created outside the web UI
	useEffect(() => {
		if (!enabled) {
			return;
		}
		if (searchQuery.trim()) {
			return;
		}
		const interval = window.setInterval(
			() => {
				if (document.visibilityState !== "visible") {
					return;
				}
				if (isLoading) {
					return;
				}
				refreshSessions();
			},
			isTauri() ? TAURI_AUTO_REFRESH_MS : AUTO_REFRESH_MS,
		);
		return () => window.clearInterval(interval);
	}, [enabled, isLoading, refreshSessions, searchQuery]);

	/**
	 * Refresh a single session's data from API
	 * Returns: Session (API type) or null if not found
	 * @param sessionId - The session ID to refresh
	 */
	const refreshSession = useCallback(
		async (sessionId: string): Promise<Session | null> => {
			try {
				const session = isTauri()
					? await tauriGetSession(sessionId)
					: await apiClient.sessions.getSessionApiSessionsSessionIdGet({
							sessionId,
						});

				if (!session) {
					return null;
				}

				const isArchived = Boolean(session.archived);

				if (isArchived) {
					// Update archived list and ensure it doesn't appear in active list
					setArchivedSessions((current) => {
						const exists = current.some((s) => s.sessionId === sessionId);
						if (!exists) {
							return [session, ...current];
						}
						return current.map((s) =>
							s.sessionId === sessionId ? session : s,
						);
					});
					setSessions((current) =>
						current.filter((s) => s.sessionId !== sessionId),
					);
				} else {
					// Update active list and ensure it doesn't appear in archived list
					setSessions((current) => {
						const exists = current.some((s) => s.sessionId === sessionId);
						if (!exists) {
							return [session, ...current];
						}
						return current.map((s) =>
							s.sessionId === sessionId ? session : s,
						);
					});
					setArchivedSessions((current) =>
						current.filter((s) => s.sessionId !== sessionId),
					);
				}

				return session;
			} catch (err) {
				console.error("Failed to refresh session:", sessionId, err);
				return null;
			}
		},
		[],
	);

	/**
	 * Create a new session
	 * Returns: Session (API type)
	 * @param workDir - Optional working directory for the session
	 * @param createDir - Whether to auto-create directory if it doesn't exist
	 */
	const createSession = useCallback(
		async (workDir?: string, createDir?: boolean): Promise<Session> => {
			setIsLoading(true);
			setError(null);
			try {
				if (isTauri()) {
					const session = await tauriCreateSession(workDir, createDir);
					setSessions((current) => [session, ...current]);
					setSelectedSessionId(session.sessionId);
					return session;
				}

				// Use fetch directly to support the work_dir parameter
				const basePath = getApiBaseUrl();
				const body: { work_dir?: string; create_dir?: boolean } = {};
				if (workDir) {
					body.work_dir = workDir;
				}
				if (createDir) {
					body.create_dir = createDir;
				}
				const response = await fetch(`${basePath}/api/sessions/`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...getAuthHeader(),
					},
					body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
				});

				if (!response.ok) {
					const data = await response.json();
					// Check for 404 with "Directory does not exist" message
					if (
						response.status === 404 &&
						typeof data.detail === "string" &&
						data.detail.includes("Directory does not exist")
					) {
						throw new DirectoryNotFoundError(data.detail);
					}
					throw new Error(data.detail || "Failed to create session");
				}

				const sessionData = await response.json();
				const session = SessionFromJSON(sessionData);

				// Update sessions list (add to beginning)
				setSessions((current) => [session, ...current]);

				// Select the new session
				setSelectedSessionId(session.sessionId);

				return session;
			} catch (err) {
				// Re-throw DirectoryNotFoundError without setting global error
				// Use property check instead of instanceof for reliability
				if (
					err instanceof Error &&
					"isDirectoryNotFound" in err &&
					(err as DirectoryNotFoundError).isDirectoryNotFound
				) {
					throw err;
				}
				const message =
					err instanceof Error ? err.message : "Failed to create session";
				setError(message);
				throw err;
			} finally {
				setIsLoading(false);
			}
		},
		[],
	);

	/**
	 * Delete a session
	 */
	const deleteSession = useCallback(
		async (sessionId: string): Promise<boolean> => {
			setIsLoading(true);
			setError(null);

			try {
				if (isTauri()) {
					await tauriDeleteSession(sessionId);
				} else {
					await apiClient.sessions.deleteSessionApiSessionsSessionIdDelete({
						sessionId,
					});
				}

				// Update sessions list
				let nextSelectedId: string | undefined;
				setSessions((current) => {
					const next = current.filter((s) => s.sessionId !== sessionId);
					if (sessionId === selectedSessionId) {
						nextSelectedId = next.length > 0 ? next[0].sessionId : "";
					}
					return next;
				});

				if (nextSelectedId !== undefined) {
					setSelectedSessionId(nextSelectedId);
				}

				return true;
			} catch (err) {
				const message =
					err instanceof Error ? err.message : "Failed to delete session";
				setError(message);
				return false;
			} finally {
				setIsLoading(false);
			}
		},
		[selectedSessionId],
	);

	/**
	 * Select a session
	 */
	const selectSession = useCallback(
		(sessionId: string) => {
			console.log("[useSessions] Selecting session:", sessionId);
			setSelectedSessionId(sessionId);
			if (!sessionId) {
				return;
			}
			if (!sessions.some((s) => s.sessionId === sessionId)) {
				refreshSession(sessionId);
			}
		},
		[refreshSession, sessions],
	);

	/**
	 * Get formatted relative time for a session
	 */
	const getRelativeTime = useCallback(
		(session: Session): string =>
			formatRelativeTime(session.lastUpdated, resolvedLanguage),
		[resolvedLanguage],
	);

	/**
	 * Upload a file to a session's work_dir
	 * Returns: UploadSessionFileResponse with path, filename, and size
	 */
	const uploadSessionFile = useCallback(
		async (
			sessionId: string,
			file: File,
		): Promise<UploadSessionFileResponse> => {
			try {
				const response = isTauri()
					? await tauriUploadSessionFile(sessionId, file)
					: await apiClient.sessions.uploadSessionFileApiSessionsSessionIdFilesPost(
							{
								sessionId,
								file,
							},
						);
				return response;
			} catch (err) {
				const message =
					err instanceof Error ? err.message : "Failed to upload file";
				setError(message);
				throw err;
			}
		},
		[],
	);

	const deleteUploadedFile = useCallback(async (fileId: string): Promise<void> => {
		if (isTauri()) {
			await tauriDeleteUploadedFile(fileId);
		}
	}, []);

	/**
	 * List files/directories under a path within the session work_dir
	 */
	const listSessionDirectory = useCallback(
		async (sessionId: string, path?: string): Promise<SessionFileEntry[]> => {
			// Note: We don't set global error here since file listing failures
			// are handled locally by the session-files-panel component
			if (isTauri()) {
				return tauriListSessionDirectory(sessionId, normalizeSessionPath(path));
			}

			const response =
				await apiClient.sessions.getSessionFileApiSessionsSessionIdFilesPathGetRaw(
					{
						sessionId,
						path: normalizeSessionPath(path),
					},
				);
			const contentType =
				response.raw.headers.get("content-type") ?? "application/octet-stream";
			if (!contentType.includes("application/json")) {
				throw new Error("Requested path is not a directory");
			}
			const entries = (await response.value()) as SessionFileEntry[];
			return entries;
		},
		[],
	);

	/**
	 * Get a file from a session's work_dir
	 * Returns: Blob of the file content
	 */
	const getSessionFile = useCallback(
		async (sessionId: string, path: string): Promise<Blob> => {
			setError(null);
			try {
				if (isTauri()) {
					return await tauriGetSessionFile(
						sessionId,
						normalizeSessionPath(path),
					);
				}

				const response =
					await apiClient.sessions.getSessionFileApiSessionsSessionIdFilesPathGetRaw(
						{
							sessionId,
							path: normalizeSessionPath(path),
						},
					);
				const contentType =
					response.raw.headers.get("content-type") ??
					"application/octet-stream";
				if (contentType.includes("application/json")) {
					throw new Error("Requested path is a directory, not a file");
				}
				return await response.raw.blob();
			} catch (err) {
				const message =
					err instanceof Error ? err.message : "Failed to get file";
				setError(message);
				throw err;
			}
		},
		[],
	);

	/**
	 * Get the URL for a session file (for direct access/download)
	 */
	const getSessionFileUrl = useCallback(
		(sessionId: string, path: string): string => {
			if (isTauri()) {
				// Native desktop downloads are handled asynchronously by SessionFilesPanel
				// via getSessionFile(); keep a harmless href for non-navigation fallback.
				return "#";
			}
			const basePath = getApiBaseUrl();
			const token = getAuthToken();
			const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
			return `${basePath}/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(path)}${tokenParam}`;
		},
		[],
	);

	/**
	 * Fetch available work directories from the backend
	 */
	const fetchWorkDirs = useCallback(async (): Promise<string[]> => {
		if (isTauri()) {
			return tauriListWorkDirs();
		}

		const basePath = getApiBaseUrl();
		const response = await fetch(`${basePath}/api/work-dirs/`, {
			headers: getAuthHeader(),
		});

		if (!response.ok) {
			throw new Error("Failed to fetch work directories");
		}

		return response.json();
	}, []);

	/**
	 * Fetch the startup directory from the backend
	 */
	const fetchStartupDir = useCallback(async (): Promise<string> => {
		if (isTauri()) {
			return tauriGetStartupDir();
		}

		const basePath = getApiBaseUrl();
		const response = await fetch(`${basePath}/api/work-dirs/startup`, {
			headers: getAuthHeader(),
		});

		if (!response.ok) {
			throw new Error("Failed to fetch startup directory");
		}

		return response.json();
	}, []);

	/**
	 * Rename a session
	 */
	const renameSession = useCallback(
		async (sessionId: string, title: string): Promise<boolean> => {
			try {
				if (isTauri()) {
					await tauriUpdateSession({ sessionId, title });
				} else {
					const basePath = getApiBaseUrl();
					const response = await fetch(
						`${basePath}/api/sessions/${encodeURIComponent(sessionId)}`,
						{
							method: "PATCH",
							headers: {
								"Content-Type": "application/json",
								...getAuthHeader(),
							},
							body: JSON.stringify({ title }),
						},
					);

					if (!response.ok) {
						const data = await response.json();
						throw new Error(data.detail || "Failed to rename session");
					}
				}

				await refreshSession(sessionId);
				return true;
			} catch (err) {
				const message =
					err instanceof Error ? err.message : "Failed to rename session";
				console.error("Failed to rename session:", err);
				toast.error(message);
				return false;
			}
		},
		[refreshSession],
	);

	/**
	 * Archive a session
	 */
	const archiveSession = useCallback(
		async (sessionId: string): Promise<boolean> => {
			try {
				if (isTauri()) {
					await tauriUpdateSession({ sessionId, archived: true });
				} else {
					const basePath = getApiBaseUrl();
					const response = await fetch(
						`${basePath}/api/sessions/${encodeURIComponent(sessionId)}`,
						{
							method: "PATCH",
							headers: {
								"Content-Type": "application/json",
								...getAuthHeader(),
							},
							body: JSON.stringify({ archived: true }),
						},
					);

					if (!response.ok) {
						const data = await response.json();
						throw new Error(data.detail || "Failed to archive session");
					}
				}

				setSessions((current) => {
					const next = current.filter((s) => s.sessionId !== sessionId);
					if (sessionId === selectedSessionId) {
						setSelectedSessionId(next.length > 0 ? next[0].sessionId : "");
					}
					return next;
				});

				await Promise.all([refreshSessions(), refreshArchivedSessions()]);
				return true;
			} catch (err) {
				const message =
					err instanceof Error ? err.message : "Failed to archive session";
				console.error("Failed to archive session:", err);
				toast.error(message);
				return false;
			}
		},
		[refreshArchivedSessions, refreshSessions, selectedSessionId],
	);

	/**
	 * Unarchive a session
	 */
	const unarchiveSession = useCallback(
		async (sessionId: string): Promise<boolean> => {
			try {
				if (isTauri()) {
					await tauriUpdateSession({ sessionId, archived: false });
				} else {
					const basePath = getApiBaseUrl();
					const response = await fetch(
						`${basePath}/api/sessions/${encodeURIComponent(sessionId)}`,
						{
							method: "PATCH",
							headers: {
								"Content-Type": "application/json",
								...getAuthHeader(),
							},
							body: JSON.stringify({ archived: false }),
						},
					);

					if (!response.ok) {
						const data = await response.json();
						throw new Error(data.detail || "Failed to unarchive session");
					}
				}

				setArchivedSessions((current) =>
					current.filter((s) => s.sessionId !== sessionId),
				);
				await Promise.all([refreshSessions(), refreshArchivedSessions()]);
				return true;
			} catch (err) {
				const message =
					err instanceof Error ? err.message : "Failed to unarchive session";
				console.error("Failed to unarchive session:", err);
				toast.error(message);
				return false;
			}
		},
		[refreshArchivedSessions, refreshSessions],
	);

	/**
	 * Archive or restore a complete project group.
	 * Tauri resolves the project from the persisted work directory, checks all
	 * busy sessions before writing, and then updates sessions one by one. A
	 * filesystem failure can therefore leave a partially updated project. The
	 * HTTP path keeps a complete-list fallback for environments without the
	 * native project command.
	 */
	const archiveProjectSessions = useCallback(
		async (
			sessionIds: string[],
			archived: boolean,
			workDir?: string,
		): Promise<number> => {
			const ids = [...new Set(sessionIds)];
			if (ids.length === 0) return 0;

			try {
				const knownSessions = [...sessions, ...archivedSessions];
				const native = isTauri();
				const requestedWorkDirs = ids
					.map((id) =>
						knownSessions
							.find((item) => item.sessionId === id)
							?.workDir?.trim(),
					)
					.filter((value): value is string => Boolean(value));
				const explicitWorkDir = workDir?.trim() || null;
				const projectWorkDir = explicitWorkDir ?? requestedWorkDirs[0] ?? null;
				const sameProject = Boolean(
					projectWorkDir &&
						(explicitWorkDir ||
							(requestedWorkDirs.length === ids.length &&
								requestedWorkDirs.every(
									(value) =>
										normalizeProjectWorkDir(value) ===
										normalizeProjectWorkDir(projectWorkDir),
								))),
				);
				const fallbackProjectSessions =
					sameProject && projectWorkDir
						? [
								...new Set(
									knownSessions
										.filter(
											(item) =>
												item.workDir?.trim() &&
												normalizeProjectWorkDir(item.workDir) ===
													normalizeProjectWorkDir(projectWorkDir),
										)
										.map((item) => item),
								),
							]
						: [];
				const resolvedProjectSessions = native
					? []
					: sameProject && projectWorkDir
						? await resolveProjectSessions(
								projectWorkDir,
								fallbackProjectSessions.length > 0
									? fallbackProjectSessions
									: ids.flatMap((id) => {
											const session = knownSessions.find((item) => item.sessionId === id);
											return session ? [session] : [];
									  }),
								knownSessions,
							)
						: ids.flatMap((id) => {
								const session = knownSessions.find((item) => item.sessionId === id);
								return session ? [session] : [];
						  });
				const projectIds = resolvedProjectSessions
					.filter((session) => Boolean(session.archived) !== archived)
					.map((session) => session.sessionId);

				let successfulIds: string[];
				let failedIds: string[] = [];
				if (native) {
					successfulIds =
						sameProject && projectWorkDir
							? await tauriUpdateWorkDirArchive(projectWorkDir, archived, ids)
							: await tauriUpdateSessionsArchive(ids, archived);
				} else {
					const busySession = resolvedProjectSessions.find(
						(item) => item.status?.state === "busy",
					);
					if (busySession) {
						throw new Error(
							resolvedLanguage === "zh-CN"
								? "项目中有会话正在运行，请等待任务完成后再操作。"
								: "A session in this project is busy. Wait for it to finish before changing the project archive state.",
						);
					}

					const basePath = getApiBaseUrl();
					const results = await Promise.allSettled(
						projectIds.map(async (sessionId) => {
							const response = await fetch(
								`${basePath}/api/sessions/${encodeURIComponent(sessionId)}`,
								{
									method: "PATCH",
									headers: {
										"Content-Type": "application/json",
										...getAuthHeader(),
									},
									body: JSON.stringify({ archived }),
								},
							);
							if (!response.ok) {
								const data = await response.json().catch(() => ({}));
								throw new Error(
									data.detail || "Failed to update project sessions",
								);
							}
							return sessionId;
						}),
					);
					successfulIds = results
						.filter(
							(result): result is PromiseFulfilledResult<string> =>
								result.status === "fulfilled",
						)
						.map((result) => result.value);
					failedIds = results
						.map((result, index) =>
							result.status === "rejected" ? projectIds[index] : null,
						)
						.filter((sessionId): sessionId is string => sessionId !== null);
				}

				if (failedIds.length > 0 && successfulIds.length > 0) {
					toast.info(
						resolvedLanguage === "zh-CN"
							? `已处理 ${successfulIds.length} 个会话，${failedIds.length} 个忙碌或不可编辑会话未处理。`
							: `${successfulIds.length} sessions updated; ${failedIds.length} busy or unavailable sessions were skipped.`,
					);
				}

				if (successfulIds.length > 0) {
					if (archived) {
						setSessions((current) => {
							const next = current.filter(
								(session) => !successfulIds.includes(session.sessionId),
							);
							if (successfulIds.includes(selectedSessionId)) {
								setSelectedSessionId(next[0]?.sessionId ?? "");
							}
							return next;
						});
					} else {
						setArchivedSessions((current) =>
							current.filter(
								(session) => !successfulIds.includes(session.sessionId),
							),
						);
					}
					await Promise.all([refreshSessions(), refreshArchivedSessions()]);
				}
				return successfulIds.length;
			} catch (err) {
				const message =
					err instanceof Error
						? err.message
						: "Failed to update project sessions";
				console.error("Failed to update project archive state:", err);
				toast.error(message);
				return 0;
			}
		},
		[
			archivedSessions,
			refreshArchivedSessions,
			refreshSessions,
			resolvedLanguage,
			sessions,
			selectedSessionId,
		],
	);

	/**
	 * Bulk archive sessions
	 * Returns the number of successfully archived sessions
	 */
	const bulkArchiveSessions = useCallback(
		async (sessionIds: string[]): Promise<number> => {
			let successCount = 0;

			if (isTauri()) {
				const results = await Promise.allSettled(
					sessionIds.map((sessionId) =>
						tauriUpdateSession({ sessionId, archived: true }).then(
							() => sessionId,
						),
					),
				);
				const successfulIds = results
					.filter(
						(result): result is PromiseFulfilledResult<string> =>
							result.status === "fulfilled",
					)
					.map((result) => result.value);
				successCount = successfulIds.length;
				if (successfulIds.length > 0) {
					setSessions((current) => {
						const next = current.filter(
							(s) => !successfulIds.includes(s.sessionId),
						);
						if (successfulIds.includes(selectedSessionId)) {
							setSelectedSessionId(next.length > 0 ? next[0].sessionId : "");
						}
						return next;
					});
					await Promise.all([refreshSessions(), refreshArchivedSessions()]);
				}
				return successCount;
			}

			const basePath = getApiBaseUrl();
			const results = await Promise.allSettled(
				sessionIds.map(async (sessionId) => {
					const response = await fetch(
						`${basePath}/api/sessions/${encodeURIComponent(sessionId)}`,
						{
							method: "PATCH",
							headers: {
								"Content-Type": "application/json",
								...getAuthHeader(),
							},
							body: JSON.stringify({ archived: true }),
						},
					);
					if (!response.ok) {
						throw new Error("Failed to archive");
					}
					return sessionId;
				}),
			);

			const successfulIds: string[] = [];
			for (const result of results) {
				if (result.status === "fulfilled") {
					successCount++;
					successfulIds.push(result.value);
				}
			}

			if (successfulIds.length > 0) {
				setSessions((current) => {
					const next = current.filter(
						(s) => !successfulIds.includes(s.sessionId),
					);
					if (successfulIds.includes(selectedSessionId)) {
						setSelectedSessionId(next.length > 0 ? next[0].sessionId : "");
					}
					return next;
				});
				await Promise.all([refreshSessions(), refreshArchivedSessions()]);
			}

			return successCount;
		},
		[refreshArchivedSessions, refreshSessions, selectedSessionId],
	);

	const listAllActiveSessions = useCallback(async (): Promise<Session[]> => {
		return fetchAllSessionsPage({ archived: false });
	}, []);

	/**
	 * Archive active sessions whose last activity is older than `days`.
	 */
	const archiveSessionsOlderThan = useCallback(
		async (days: number = STALE_ARCHIVE_DAYS): Promise<number> => {
			try {
				const active = await listAllActiveSessions();
				const stale = selectSessionsOlderThan(active, days);
				if (stale.length === 0) {
					toast.message(
						resolvedLanguage === "zh-CN"
							? `没有超过 ${days} 天未活跃的会话`
							: `No sessions inactive for more than ${days} days`,
					);
					return 0;
				}
				const count = await bulkArchiveSessions(
					stale.map((session) => session.sessionId),
				);
				if (count > 0) {
					toast.success(
						resolvedLanguage === "zh-CN"
							? `已归档 ${count} 个超过 ${days} 天未活跃的会话`
							: `Archived ${count} sessions inactive for more than ${days} days`,
					);
				}
				return count;
			} catch (err) {
				const message =
					err instanceof Error
						? err.message
						: "Failed to archive stale sessions";
				console.error("Failed to archive stale sessions:", err);
				toast.error(message);
				return 0;
			}
		},
		[bulkArchiveSessions, listAllActiveSessions, resolvedLanguage],
	);

	/**
	 * Bulk unarchive sessions
	 * Returns the number of successfully unarchived sessions
	 */
	const bulkUnarchiveSessions = useCallback(
		async (sessionIds: string[]): Promise<number> => {
			let successCount = 0;

			if (isTauri()) {
				const results = await Promise.allSettled(
					sessionIds.map((sessionId) =>
						tauriUpdateSession({ sessionId, archived: false }).then(
							() => sessionId,
						),
					),
				);
				const successfulIds = results
					.filter(
						(result): result is PromiseFulfilledResult<string> =>
							result.status === "fulfilled",
					)
					.map((result) => result.value);
				successCount = successfulIds.length;
				if (successfulIds.length > 0) {
					setArchivedSessions((current) =>
						current.filter((s) => !successfulIds.includes(s.sessionId)),
					);
					await Promise.all([refreshSessions(), refreshArchivedSessions()]);
				}
				return successCount;
			}

			const basePath = getApiBaseUrl();
			const results = await Promise.allSettled(
				sessionIds.map(async (sessionId) => {
					const response = await fetch(
						`${basePath}/api/sessions/${encodeURIComponent(sessionId)}`,
						{
							method: "PATCH",
							headers: {
								"Content-Type": "application/json",
								...getAuthHeader(),
							},
							body: JSON.stringify({ archived: false }),
						},
					);
					if (!response.ok) {
						throw new Error("Failed to unarchive");
					}
					return sessionId;
				}),
			);

			const successfulIds: string[] = [];
			for (const result of results) {
				if (result.status === "fulfilled") {
					successCount++;
					successfulIds.push(result.value);
				}
			}

			if (successfulIds.length > 0) {
				setArchivedSessions((current) =>
					current.filter((s) => !successfulIds.includes(s.sessionId)),
				);
				await Promise.all([refreshSessions(), refreshArchivedSessions()]);
			}

			return successCount;
		},
		[refreshArchivedSessions, refreshSessions],
	);

	/**
	 * Bulk delete sessions
	 * Returns the number of successfully deleted sessions
	 */
	const bulkDeleteSessions = useCallback(
		async (sessionIds: string[]): Promise<number> => {
			let successCount = 0;

			if (isTauri()) {
				const results = await Promise.allSettled(
					sessionIds.map((sessionId) =>
						tauriDeleteSession(sessionId).then(() => sessionId),
					),
				);
				const successfulIds = results
					.filter(
						(result): result is PromiseFulfilledResult<string> =>
							result.status === "fulfilled",
					)
					.map((result) => result.value);
				successCount = successfulIds.length;
				if (successfulIds.length > 0) {
					setSessions((current) => {
						const next = current.filter(
							(s) => !successfulIds.includes(s.sessionId),
						);
						if (successfulIds.includes(selectedSessionId)) {
							setSelectedSessionId(next.length > 0 ? next[0].sessionId : "");
						}
						return next;
					});
					setArchivedSessions((current) =>
						current.filter((s) => !successfulIds.includes(s.sessionId)),
					);
				}
				return successCount;
			}

			const basePath = getApiBaseUrl();
			const results = await Promise.allSettled(
				sessionIds.map(async (sessionId) => {
					const response = await fetch(
						`${basePath}/api/sessions/${encodeURIComponent(sessionId)}`,
						{
							method: "DELETE",
							headers: getAuthHeader(),
						},
					);
					if (!response.ok) {
						throw new Error("Failed to delete");
					}
					return sessionId;
				}),
			);

			const successfulIds: string[] = [];
			for (const result of results) {
				if (result.status === "fulfilled") {
					successCount++;
					successfulIds.push(result.value);
				}
			}

			if (successfulIds.length > 0) {
				setSessions((current) => {
					const next = current.filter(
						(s) => !successfulIds.includes(s.sessionId),
					);
					if (successfulIds.includes(selectedSessionId)) {
						setSelectedSessionId(next.length > 0 ? next[0].sessionId : "");
					}
					return next;
				});
				setArchivedSessions((current) =>
					current.filter((s) => !successfulIds.includes(s.sessionId)),
				);
			}

			return successCount;
		},
		[selectedSessionId],
	);

	/**
	 * Fork a session at a specific turn index
	 * Creates a new session with history up to the specified turn
	 */
	const forkSession = useCallback(
		async (sessionId: string, turnIndex: number): Promise<Session> => {
			try {
				const session = isTauri()
					? await tauriForkSession(sessionId, turnIndex)
					: await (async () => {
							const basePath = getApiBaseUrl();
							const response = await fetch(
								`${basePath}/api/sessions/${encodeURIComponent(sessionId)}/fork`,
								{
									method: "POST",
									headers: {
										"Content-Type": "application/json",
										...getAuthHeader(),
									},
									body: JSON.stringify({ turn_index: turnIndex }),
								},
							);

							if (!response.ok) {
								const data = await response.json();
								throw new Error(data.detail || "Failed to fork session");
							}

							const sessionData = await response.json();
							return SessionFromJSON(sessionData);
						})();

				setSessions((current) => [session, ...current]);
				setSelectedSessionId(session.sessionId);
				return session;
			} catch (err) {
				const message =
					err instanceof Error ? err.message : "Failed to fork session";
				setError(message);
				throw err;
			}
		},
		[],
	);

	return {
		sessions,
		archivedSessions,
		hasLoadedArchivedSessions,
		selectedSessionId,
		isLoading,
		isLoadingArchived,
		error,
		refreshSessions,
		refreshArchivedSessions,
		loadMoreSessions,
		loadMoreArchivedSessions,
		hasMoreSessions,
		hasMoreArchivedSessions,
		isLoadingMore,
		isLoadingMoreArchived,
		searchQuery,
		setSearchQuery,
		refreshSession,
		createSession,
		deleteSession,
		selectSession,
		applySessionStatus,
		getRelativeTime,
		uploadSessionFile,
		deleteUploadedFile,
		listSessionDirectory,
		getSessionFile,
		getSessionFileUrl,
		fetchWorkDirs,
		fetchStartupDir,
		renameSession,
		archiveSession,
		unarchiveSession,
		archiveProjectSessions,
		bulkArchiveSessions,
		bulkUnarchiveSessions,
		bulkDeleteSessions,
		archiveSessionsOlderThan,
		forkSession,
	};
}
