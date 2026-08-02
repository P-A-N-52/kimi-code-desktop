/**
 * React binding for the desktop session-stream orchestrator.
 *
 * Mounted at the app root (bootstrap.tsx). Tauri creates the orchestrator and
 * its single global `wire:message` listener; web builds remain a transparent
 * single-stream pass-through (see `isMultiActiveSessionsEnabled`).
 *
 * The runtime pause signal (`shouldPauseRuntime`, §4.6) is not a prop because
 * it lives inside App; App forwards it via `orchestrator.setPaused()`.
 */

import { createContext, useContext, useEffect, useRef } from "react";
import { isMultiActiveSessionsEnabled } from "@/lib/features";
import {
  createSessionStreamOrchestrator,
  type SessionStreamOrchestrator,
} from "./orchestrator";

export const SessionStreamOrchestratorContext = createContext<SessionStreamOrchestrator | null>(
  null,
);

export type SessionStreamOrchestratorProviderProps = {
  children: React.ReactNode;
};

export function SessionStreamOrchestratorProvider({
  children,
}: SessionStreamOrchestratorProviderProps) {
  const enabled = isMultiActiveSessionsEnabled();
  const orchestratorRef = useRef<SessionStreamOrchestrator | null>(null);
  if (enabled && orchestratorRef.current === null) {
    orchestratorRef.current = createSessionStreamOrchestrator();
  }
  const orchestrator = enabled ? orchestratorRef.current : null;

  useEffect(() => {
    // App teardown: unregister the global wire:message listener and disconnect
    // live workers. Intentionally not `stop()`-ing runtimes: React unmount
    // (incl. StrictMode double-mount) must not wipe global tool-events stores;
    // real app exit stops every ACP worker in Rust (RunEvent::ExitRequested).
    return () => {
      orchestrator?.destroy();
    };
  }, [orchestrator]);

  return (
    <SessionStreamOrchestratorContext.Provider value={orchestrator}>
      {children}
    </SessionStreamOrchestratorContext.Provider>
  );
}

export function useSessionStreamOrchestrator(): SessionStreamOrchestrator | null {
  return useContext(SessionStreamOrchestratorContext);
}
