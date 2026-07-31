import { isTauri } from "@/lib/tauri-api";

/**
 * G5 multi-active-sessions feature flag (design `docs/plans/2026-07-31-g5-multi-active-sessions-design.md` §9.1).
 *
 * Effective flag: `isTauri() && (buildTime || devLocalStorage)`.
 * Default off; Web / non-Tauri builds are always off.
 *
 * - Build-time: `VITE_G5_MULTI_ACTIVE_SESSIONS === "true"` (production default off).
 * - Dev override: localStorage key `kimi-code-desktop.experimental.multi-active-sessions.v1` = `"1"`,
 *   honored only when `import.meta.env.DEV` is true.
 *
 * Flag changes require a full page reload; do not hot-swap.
 */

const DEV_LOCAL_STORAGE_KEY = "kimi-code-desktop.experimental.multi-active-sessions.v1";

export function isMultiActiveSessionsEnabled(): boolean {
  if (!isTauri()) return false;
  if (import.meta.env.VITE_G5_MULTI_ACTIVE_SESSIONS === "true") return true;
  if (import.meta.env.DEV) {
    try {
      return window.localStorage.getItem(DEV_LOCAL_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  }
  return false;
}
