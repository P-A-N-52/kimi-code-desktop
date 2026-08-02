/**
 * React binding for the G5 session-stream orchestrator (design §5.5 / §9.1).
 *
 * Mounted at the app root (bootstrap.tsx) but only creates the orchestrator —
 * and with it the SINGLE global `wire:message` listener — when the
 * multi-active-sessions flag is on AND running in Tauri
 * (see `isMultiActiveSessionsEnabled` in `@/lib/features`). Flag off: the
 * provider is a transparent pass-through and no listener is registered
 * (rollback guarantee of §9.1).
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
