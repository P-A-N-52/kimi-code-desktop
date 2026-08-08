import { useCallback, useEffect, useRef, useState } from "react";
import type { GitComparison, GitEnvironment, GitHubEnvironment } from "@/lib/git-workspace";
import {
  commitGitChanges,
  compareGitBranches,
  createGithubPullRequest,
  getGitComparisonFileDiff,
  getGitEnvironment,
  getGithubEnvironment,
  pushGitBranch,
  switchGitBranch,
} from "@/lib/tauri-api";

export function useGitWorkspace(sessionId: string) {
  const [environment, setEnvironment] = useState<GitEnvironment | null>(null);
  const [githubEnvironment, setGithubEnvironment] = useState<GitHubEnvironment | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [githubLoading, setGithubLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [githubError, setGithubError] = useState<string | null>(null);
  const gitRequestRef = useRef(0);
  const githubRequestRef = useRef(0);

  const refreshGit = useCallback(
    async (baseRef?: string) => {
      if (!sessionId) {
        setEnvironment(null);
        return null;
      }
      const request = ++gitRequestRef.current;
      setGitLoading(true);
      setGitError(null);
      try {
        const next = await getGitEnvironment(sessionId, baseRef);
        if (request === gitRequestRef.current) setEnvironment(next);
        return next;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (request === gitRequestRef.current) setGitError(message);
        return null;
      } finally {
        if (request === gitRequestRef.current) setGitLoading(false);
      }
    },
    [sessionId],
  );

  const refreshGithub = useCallback(async () => {
    if (!sessionId) {
      setGithubEnvironment(null);
      return null;
    }
    const request = ++githubRequestRef.current;
    setGithubLoading(true);
    setGithubError(null);
    try {
      const next = await getGithubEnvironment(sessionId);
      if (request === githubRequestRef.current) setGithubEnvironment(next);
      return next;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (request === githubRequestRef.current) setGithubError(message);
      return null;
    } finally {
      if (request === githubRequestRef.current) setGithubLoading(false);
    }
  }, [sessionId]);

  const refresh = useCallback(
    (baseRef?: string) => {
      void refreshGithub();
      return refreshGit(baseRef);
    },
    [refreshGit, refreshGithub],
  );

  useEffect(() => {
    setEnvironment(null);
    setGithubEnvironment(null);
    setGitError(null);
    setGithubError(null);
    void refreshGit();
    void refreshGithub();
    return () => {
      gitRequestRef.current += 1;
      githubRequestRef.current += 1;
    };
  }, [refreshGit, refreshGithub]);

  const mutate = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      setGitLoading(true);
      setGitError(null);
      try {
        const result = await operation();
        await refreshGit(environment?.baseRef);
        void refreshGithub();
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setGitError(message);
        throw err;
      } finally {
        setGitLoading(false);
      }
    },
    [environment?.baseRef, refreshGit, refreshGithub],
  );

  return {
    environment,
    githubEnvironment,
    gitLoading,
    githubLoading,
    gitError,
    githubError,
    loading: gitLoading || githubLoading,
    error: gitError || githubError,
    refresh,
    refreshGit,
    refreshGithub,
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
