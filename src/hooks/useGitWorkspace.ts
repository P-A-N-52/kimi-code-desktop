import { useCallback, useEffect, useRef, useState } from "react";
import type { GitComparison, GitEnvironment } from "@/lib/git-workspace";
import {
  commitGitChanges,
  compareGitBranches,
  createGithubPullRequest,
  getGitComparisonFileDiff,
  getGitEnvironment,
  pushGitBranch,
  switchGitBranch,
} from "@/lib/tauri-api";

export function useGitWorkspace(sessionId: string) {
  const [environment, setEnvironment] = useState<GitEnvironment | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(
    async (baseRef?: string) => {
      if (!sessionId) {
        setEnvironment(null);
        return null;
      }
      const request = ++requestRef.current;
      setLoading(true);
      setError(null);
      try {
        const next = await getGitEnvironment(sessionId, baseRef);
        if (request === requestRef.current) setEnvironment(next);
        return next;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (request === requestRef.current) setError(message);
        return null;
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    setEnvironment(null);
    setError(null);
    void refresh();
    return () => {
      requestRef.current += 1;
    };
  }, [refresh]);

  const mutate = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      setLoading(true);
      setError(null);
      try {
        const result = await operation();
        await refresh(environment?.baseRef);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [environment?.baseRef, refresh],
  );

  return {
    environment,
    loading,
    error,
    refresh,
    setBaseRef: (baseRef: string) => refresh(baseRef),
    compare: (leftRef: string, rightRef: string): Promise<GitComparison> =>
      compareGitBranches(sessionId, leftRef, rightRef),
    getFileDiff: (leftRef: string, rightRef: string, path: string) =>
      getGitComparisonFileDiff(sessionId, leftRef, rightRef, path),
    switchBranch: (targetRef: string, confirmDirty: boolean) => {
      if (!environment) return Promise.reject(new Error("Git environment is not ready"));
      return mutate(() => switchGitBranch(sessionId, targetRef, environment.headSha, confirmDirty));
    },
    commit: (paths: string[], message: string) => {
      if (!environment) return Promise.reject(new Error("Git environment is not ready"));
      return mutate(() => commitGitChanges(sessionId, paths, message, environment.headSha));
    },
    push: (remote: string) => {
      if (!environment) return Promise.reject(new Error("Git environment is not ready"));
      return mutate(() =>
        pushGitBranch(sessionId, remote, environment.currentBranch, environment.headSha),
      );
    },
    createPullRequest: (args: { baseRef: string; title: string; body: string; draft: boolean }) => {
      if (!environment) return Promise.reject(new Error("Git environment is not ready"));
      return mutate(() =>
        createGithubPullRequest({
          sessionId,
          baseRef: args.baseRef,
          headRef: environment.currentBranch,
          title: args.title,
          body: args.body,
          draft: args.draft,
          expectedHead: environment.headSha,
        }),
      );
    },
  };
}
