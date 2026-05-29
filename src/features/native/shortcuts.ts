import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Hook to listen for global shortcut confirmation events.
 * The actual global shortcut (ctrl+shift+k) is registered and handled in Rust,
 * which toggles window visibility. This hook listens to window focus changes
 * as a proxy for shortcut-triggered window activation.
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      try {
        const window = getCurrentWindow();
        unlisten = await window.onFocusChanged(({ payload: focused }) => {
          if (focused) {
            // Window was brought to foreground - may have been via global shortcut.
            // Frontend can perform additional initialization here if needed.
          }
        });
      } catch {
        // Not in Tauri environment
      }
    };

    setup();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);
}
