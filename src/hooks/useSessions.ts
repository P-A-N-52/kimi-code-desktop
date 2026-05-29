import { useState, useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import type {
  Session,
  UploadSessionFileResponse,
  SessionStatus,
} from "../lib/api/models";
import { SessionFromJSON } from "../lib/api/models/Session";
import { apiClient } from "../lib/apiClient";
import { getAuthHeader, getAuthToken } from "../lib/auth";
import {
  isTauri,
  listSessions as tauriListSessions,
  getSession as tauriGetSession,
  createSession as tauriCreateSession,
  deleteSession as tauriDeleteSession,
  updateSession as tauriUpdateSession,
  forkSession as tauriForkSession,
  generateTitle as tauriGenerateTitle,
  uploadSessionFile as tauriUploadSessionFile,
  listSessionDirectory as tauriListSessionDirectory,
  getSessionFile as tauriGetSessionFile,
  listWorkDirs as tauriListWorkDirs,
  getStartupDir as tauriGetStartupDir,
} from "../lib/tauri-api";
import { formatRelativeTime, getApiBaseUrl } from "./utils";

// Regex patterns for path normalization
const LEADING_DOT_SLASH_REGEX = /^\.\/+/;
const LEADING_SLASH_REGEX = /^\/+/;
const TRAILING_WHITESPACE_REGEX = /\s+$/;

export type SessionFileEntry = {
  name: string;
  type: "directory" | "file";
  size?: number;
};

type UseSessionsReturn = {
  /** List of sessions (API Session type) */
  sessions: Session[];
  /** List of archived sessions */
  archivedSessions: Session[];
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
  /** Generate title using AI (backend reads messages from wire.jsonl) */
  generateTitle: (sessionId: string) => Promise<string | null>;
  /** Archive a session */
  archiveSession: (sessionId: string) => Promise<boolean>;
  /** Unarchive a session */
  unarchiveSession: (sessionId: string) => Promise<boolean>;
  /** Bulk archive sessions */
  bulkArchiveSessions: (sessionIds: string[]) => Promise<number>;
  /** Bulk unarchive sessions */
  bulkUnarchiveSessions: (sessionIds: string[]) => Promise<number>;
  /** Bulk delete sessions */
  bulkDeleteSessions: (sessionIds: string[]) => Promise<number>;
  /** Fork a session at a specific turn index */
  forkSession: (sessionId: string, turnIndex: number) => Promise<Session>;
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

const PAGE_SIZE = 100;
const AUTO_REFRESH_MS = 30_000;
const TAURI_AUTO_REFRESH_MS = 120_000;

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
export function useSessions(): UseSessionsReturn {
  // Sessions list (using API Session type)
  const [sessions, setSessions] = useState<Session[]>([]);

  // Archived sessions list
  const [archivedSessions, setArchivedSessions] = useState<Session[]>([]);

  // Currently selected session
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");

  // Loading and error states
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isLoadingArchived, setIsLoadingArchived] = useState(false);
  const [isLoadingMoreArchived, setIsLoadingMoreArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [hasMoreSessions, setHasMoreSessions] = useState(true);
  const [hasMoreArchivedSessions, setHasMoreArchivedSessions] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const lastRefreshRef = useRef(0);
  const refreshInFlightRef = useRef(false);

  /**
   * Refresh sessions list from API
   */
  const refreshSessions = useCallback(async () => {
    if (refreshInFlightRef.current) {
      return;
    }
    refreshInFlightRef.current = true;
    setIsLoading(true);
    setError(null);

    try {
      const sessionsList = isTauri()
        ? await tauriListSessions({
            limit: PAGE_SIZE,
            offset: 0,
            q: searchQuery.trim() || undefined,
          })
        : await apiClient.sessions.listSessionsApiSessionsGet({
            limit: PAGE_SIZE,
            offset: 0,
            q: searchQuery.trim() || undefined,
          });

      // Update sessions list
      setSessions(sessionsList);
      setHasMoreSessions(sessionsList.length === PAGE_SIZE);
      lastRefreshRef.current = Date.now();

      // Don't auto-select first session - user can click on one or create a new one
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load sessions";
      setError(message);
      console.error("Failed to refresh sessions:", err);
    } finally {
      refreshInFlightRef.current = false;
      setIsLoading(false);
    }
  }, [searchQuery]);

  const loadMoreSessions = useCallback(async () => {
    if (isLoadingMore || isLoading || !hasMoreSessions) {
      return;
    }
    setIsLoadingMore(true);
    setError(null);
    try {
      const offset = sessions.length;
      const moreSessions = isTauri()
        ? await tauriListSessions({
            limit: PAGE_SIZE,
            offset,
            q: searchQuery.trim() || undefined,
          })
        : await apiClient.sessions.listSessionsApiSessionsGet({
            limit: PAGE_SIZE,
            offset,
            q: searchQuery.trim() || undefined,
          });
      setSessions((current) => [...current, ...moreSessions]);
      setHasMoreSessions(moreSessions.length === PAGE_SIZE);
      lastRefreshRef.current = Date.now();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load more sessions";
      setError(message);
      console.error("Failed to load more sessions:", err);
    } finally {
      setIsLoadingMore(false);
    }
  }, [hasMoreSessions, isLoading, isLoadingMore, searchQuery, sessions.length]);

  const applySessionStatus = useCallback((status: SessionStatus) => {
    setSessions((current) =>
      current.map((session) =>
        session.sessionId === status.sessionId
          ? { ...session, status }
          : session,
      ),
    );
  }, []);

  /**
   * Refresh archived sessions list from API
   */
  const refreshArchivedSessions = useCallback(async () => {
    setIsLoadingArchived(true);
    try {
      if (isTauri()) {
        const archivedList = await tauriListSessions({
          archived: true,
          limit: PAGE_SIZE,
        });
        setArchivedSessions(archivedList);
        setHasMoreArchivedSessions(archivedList.length === PAGE_SIZE);
        return;
      }

      const basePath = getApiBaseUrl();
      const response = await fetch(
        `${basePath}/api/sessions/?archived=true&limit=${PAGE_SIZE}`,
        {
          headers: getAuthHeader(),
        },
      );
      if (!response.ok) {
        throw new Error("Failed to load archived sessions");
      }
      const data = await response.json();
      // Convert snake_case to camelCase
      const archivedList: Session[] = data.map(
        (item: Record<string, unknown>) => ({
          sessionId: item.session_id as string,
          title: item.title as string,
          lastUpdated: new Date(item.last_updated as string),
          isRunning: item.is_running as boolean,
          status: item.status as SessionStatus | undefined,
          workDir: item.work_dir as string | undefined,
          sessionDir: item.session_dir as string | undefined,
          archived: item.archived as boolean,
        }),
      );
      setArchivedSessions(archivedList);
      setHasMoreArchivedSessions(archivedList.length === PAGE_SIZE);
    } catch (err) {
      console.error("Failed to refresh archived sessions:", err);
    } finally {
      setIsLoadingArchived(false);
    }
  }, []);

  /**
   * Load more archived sessions for pagination
   */
  const loadMoreArchivedSessions = useCallback(async () => {
    if (isLoadingMoreArchived || isLoadingArchived || !hasMoreArchivedSessions) {
      return;
    }
    setIsLoadingMoreArchived(true);
    try {
      const offset = archivedSessions.length;
      if (isTauri()) {
        const moreArchived = await tauriListSessions({
          archived: true,
          limit: PAGE_SIZE,
          offset,
        });
        setArchivedSessions((current) => [...current, ...moreArchived]);
        setHasMoreArchivedSessions(moreArchived.length === PAGE_SIZE);
        return;
      }

      const basePath = getApiBaseUrl();
      const response = await fetch(
        `${basePath}/api/sessions/?archived=true&limit=${PAGE_SIZE}&offset=${offset}`,
        {
          headers: getAuthHeader(),
        },
      );
      if (!response.ok) {
        throw new Error("Failed to load more archived sessions");
      }
      const data = await response.json();
      const moreArchived: Session[] = data.map(
        (item: Record<string, unknown>) => ({
          sessionId: item.session_id,
          title: item.title,
          lastUpdated: new Date(item.last_updated as string),
          isRunning: item.is_running,
          status: item.status,
          workDir: item.work_dir,
          sessionDir: item.session_dir,
          archived: item.archived,
        }),
      );
      setArchivedSessions((current) => [...current, ...moreArchived]);
      setHasMoreArchivedSessions(moreArchived.length === PAGE_SIZE);
    } catch (err) {
      console.error("Failed to load more archived sessions:", err);
    } finally {
      setIsLoadingMoreArchived(false);
    }
  }, [
    archivedSessions.length,
    hasMoreArchivedSessions,
    isLoadingArchived,
    isLoadingMoreArchived,
  ]);

  // Refresh sessions list when search changes
  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  // Refresh when returning to the tab (throttled)
  useEffect(() => {
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
  }, [refreshSessions]);

  // Periodic refresh to catch sessions created outside the web UI
  useEffect(() => {
    if (searchQuery.trim()) {
      return;
    }
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }
      if (isLoading || isLoadingMore) {
        return;
      }
      refreshSessions();
    }, isTauri() ? TAURI_AUTO_REFRESH_MS : AUTO_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [isLoading, isLoadingMore, refreshSessions, searchQuery]);

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
        setSessions((current) => {
          const next = current.filter((s) => s.sessionId !== sessionId);

          // If we deleted the selected session, select the first remaining one
          if (sessionId === selectedSessionId && next.length > 0) {
            setSelectedSessionId(next[0].sessionId);
          } else if (next.length === 0) {
            setSelectedSessionId("");
          }

          return next;
        });

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
    (session: Session): string => formatRelativeTime(session.lastUpdated),
    [],
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
          return await tauriGetSessionFile(sessionId, normalizeSessionPath(path));
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
   * Generate title using AI
   * Backend reads messages from wire.jsonl automatically
   */
  const generateTitle = useCallback(
    async (sessionId: string): Promise<string | null> => {
      try {
        let result: { title: string };
        if (isTauri()) {
          result = await tauriGenerateTitle(sessionId);
        } else {
          const basePath = getApiBaseUrl();
          const response = await fetch(
            `${basePath}/api/sessions/${encodeURIComponent(sessionId)}/generate-title`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...getAuthHeader(),
              },
              body: JSON.stringify({}),
            },
          );

          if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || "Failed to generate title");
          }

          result = await response.json();
        }

        await refreshSession(sessionId);
        return result.title;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to generate title";
        console.error("Failed to generate title:", err);
        toast.error(message);
        return null;
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

        await refreshArchivedSessions();
        return true;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to archive session";
        console.error("Failed to archive session:", err);
        toast.error(message);
        return false;
      }
    },
    [refreshArchivedSessions, selectedSessionId],
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
        await refreshSessions();
        return true;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to unarchive session";
        console.error("Failed to unarchive session:", err);
        toast.error(message);
        return false;
      }
    },
    [refreshSessions],
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
            tauriUpdateSession({ sessionId, archived: true }).then(() => sessionId),
          ),
        );
        const successfulIds = results
          .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
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
          await refreshArchivedSessions();
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
        await refreshArchivedSessions();
      }

      return successCount;
    },
    [refreshArchivedSessions, selectedSessionId],
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
            tauriUpdateSession({ sessionId, archived: false }).then(() => sessionId),
          ),
        );
        const successfulIds = results
          .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
          .map((result) => result.value);
        successCount = successfulIds.length;
        if (successfulIds.length > 0) {
          setArchivedSessions((current) =>
            current.filter((s) => !successfulIds.includes(s.sessionId)),
          );
          await refreshSessions();
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
        await refreshSessions();
      }

      return successCount;
    },
    [refreshSessions],
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
          sessionIds.map((sessionId) => tauriDeleteSession(sessionId).then(() => sessionId)),
        );
        const successfulIds = results
          .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
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
    listSessionDirectory,
    getSessionFile,
    getSessionFileUrl,
    fetchWorkDirs,
    fetchStartupDir,
    renameSession,
    generateTitle,
    archiveSession,
    unarchiveSession,
    bulkArchiveSessions,
    bulkUnarchiveSessions,
    bulkDeleteSessions,
    forkSession,
  };
}
