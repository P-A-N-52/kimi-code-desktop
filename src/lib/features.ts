import { isTauri } from "@/lib/tauri-api";

/**
 * Multi-active sessions are the standard desktop stream model.
 *
 * Browser / non-Tauri builds retain the single-stream implementation because
 * their wire transport does not provide the desktop session router.
 */
export function isMultiActiveSessionsEnabled(): boolean {
  return isTauri();
}

/** Desktop-local experiment for optional custom Agent discovery in the Agents panel. */
export const CUSTOM_SUBAGENTS_STORAGE_KEY =
  "kimi-code-desktop.experimental.custom-subagents.v1";
export const CUSTOM_SUBAGENTS_CHANGE_EVENT = "kimi:custom-subagents-change";

export function isCustomSubagentsEnabled(): boolean {
  if (!isTauri()) return false;
  try {
    return window.localStorage.getItem(CUSTOM_SUBAGENTS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setCustomSubagentsEnabled(enabled: boolean): void {
  if (!isTauri()) return;
  try {
    window.localStorage.setItem(CUSTOM_SUBAGENTS_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Ignore private-mode or quota failures; the in-memory subscribers still refresh.
  }
  window.dispatchEvent(new Event(CUSTOM_SUBAGENTS_CHANGE_EVENT));
}
