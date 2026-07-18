import { useState, useCallback, useEffect, useRef } from "react";
import type { GitDiffStats } from "../lib/api/models";
import { getAuthHeader } from "../lib/auth";
import { getApiBaseUrl } from "./utils";
import { isTauri, getGitDiffStats as tauriGetGitDiffStats } from "../lib/tauri-api";

type UseGitDiffStatsReturn = {
  stats: GitDiffStats | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

const CACHE_TTL_MS = 30000; // shared 30 seconds cache
const POLL_INTERVAL_MS = 30000; // 30 seconds polling for web mode
const TAURI_POLL_INTERVAL_MS = 120000; // avoid spawning desktop API helpers while idle

type GitDiffStatsCacheEntry = {
  stats?: GitDiffStats;
  timestamp: number;
  promise?: Promise<GitDiffStats>;
};

const sharedCache = new Map<string, GitDiffStatsCacheEntry>();

/**
 * Hook for fetching git diff stats for a session
 */
export function useGitDiffStats(sessionId: string | null): UseGitDiffStatsReturn {
  const [stats, setStats] = useState<GitDiffStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchStats = useCallback(async (forceRefresh = false) => {
    if (!sessionId) {
      setStats(null);
      return;
    }

    const requestId = ++requestIdRef.current;
    abortControllerRef.current?.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Check cache
    const now = Date.now();
    const cached = sharedCache.get(sessionId);
    if (!forceRefresh && cached?.stats && now - cached.timestamp < CACHE_TTL_MS) {
      if (requestId === requestIdRef.current) {
        setStats(cached.stats);
      }
      return;
    }
    if (!forceRefresh && cached?.promise) {
      const cachedStats = await cached.promise;
      if (requestId === requestIdRef.current) {
        setStats(cachedStats);
      }
      return;
    }

    if (requestId === requestIdRef.current) {
      setIsLoading(true);
      setError(null);
    }

    try {
      const promise = (async (): Promise<GitDiffStats> => {
        if (isTauri()) {
          return tauriGetGitDiffStats(sessionId);
        }

        const basePath = getApiBaseUrl();
        const response = await fetch(
          `${basePath}/api/sessions/${encodeURIComponent(sessionId)}/git-diff`,
          { headers: getAuthHeader(), signal: abortController.signal },
        );

        if (!response.ok) {
          throw new Error("Failed to fetch git diff stats");
        }

        const data = await response.json();
        // Convert snake_case to camelCase
        return {
          isGitRepo: Boolean(data.is_git_repo),
          hasChanges: Boolean(data.has_changes ?? false),
          totalAdditions: Number(data.total_additions ?? 0),
          totalDeletions: Number(data.total_deletions ?? 0),
          files: (data.files ?? []).map((f: Record<string, unknown>) => ({
            path: String(f.path ?? ""),
            additions: Number(f.additions ?? 0),
            deletions: Number(f.deletions ?? 0),
            status: f.status as "added" | "modified" | "deleted" | "renamed",
          })),
          error: data.error ?? null,
        };
      })();

      sharedCache.set(sessionId, {
        stats: cached?.stats,
        timestamp: cached?.timestamp ?? 0,
        promise,
      });
      const gitDiffStats = await promise;

      if (requestId !== requestIdRef.current) {
        return;
      }

      // Update cache
      sharedCache.set(sessionId, {
        stats: gitDiffStats,
        timestamp: Date.now(),
      });

      setStats(gitDiffStats);
    } catch (err) {
      if (abortController.signal.aborted) {
        return;
      }
      if (requestId !== requestIdRef.current) {
        return;
      }
      sharedCache.delete(sessionId);
      const message =
        err instanceof Error ? err.message : "Failed to fetch git diff stats";
      setError(message);
      setStats(null);
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [sessionId]);

  // Invalidate in-flight requests when session changes
  useEffect(() => {
    requestIdRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setStats(null);
    setError(null);
  }, [sessionId]);

  // Initial fetch and polling
  useEffect(() => {
    fetchStats();

    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }
      fetchStats();
    }, isTauri() ? TAURI_POLL_INTERVAL_MS : POLL_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      abortControllerRef.current?.abort();
    };
  }, [fetchStats]);

  const refresh = useCallback(async () => {
    await fetchStats(true);
  }, [fetchStats]);

  return {
    stats,
    isLoading,
    error,
    refresh,
  };
}
