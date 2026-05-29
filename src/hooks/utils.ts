import { v4 as uuidV4 } from "uuid";

declare global {
  interface Window {
    __KIMI_BACKEND_URL__?: string;
  }
}

/**
 * Check if running on macOS.
 */
export function isMacOS(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return navigator.platform.toLowerCase().includes("mac");
}

const _isMac =
  typeof navigator !== "undefined" &&
  navigator.platform.toLowerCase().includes("mac");

/**
 * Check if the platform-specific modifier key is pressed (Cmd on macOS, Ctrl elsewhere).
 */
export function hasPlatformModifier(
  e: Pick<KeyboardEvent | MouseEvent, "metaKey" | "ctrlKey">,
): boolean {
  return _isMac ? e.metaKey : e.ctrlKey;
}

/**
 * Get the API base URL for connecting to the Kimi backend.
 * - Tauri desktop: returns the sidecar URL from window.__KIMI_BACKEND_URL__
 * - Vite dev / browser: uses Vite proxy, so empty string (relative URLs like /api/...)
 * - Production web: same-origin, so empty string
 */
export function getApiBaseUrl(): string {
  if (typeof window !== "undefined" && window.__KIMI_BACKEND_URL__) {
    return window.__KIMI_BACKEND_URL__;
  }
  return "";
}

/**
 * Generate a unique message ID
 * Uses crypto.randomUUID for true uniqueness to avoid key collisions
 * when switching sessions or reconnecting WebSocket
 */
export const createMessageId = (prefix: "user" | "assistant"): string => {
  // Fallback for older browsers
  return `${prefix}-${uuidV4()}`;
};

/**
 * Format relative time for session display
 */
export const formatRelativeTime = (date: Date): string => {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);

  if (minutes < 1) {
    return "Just now";
  } else if (minutes < 60) {
    return `${minutes}m ago`;
  } else {
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours}h ago`;
    } else {
      const days = Math.floor(hours / 24);
      return `${days}d ago`;
    }
  }
};
