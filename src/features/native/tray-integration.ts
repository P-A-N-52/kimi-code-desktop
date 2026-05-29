import { useEffect } from "react";
import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Hook that listens to the system tray "New Session" event.
 * When the tray menu item is clicked, invokes the provided callback.
 */
export function useTrayEvents(onNewSession: () => void): void {
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cleanedUp = false;

    const setup = async () => {
      const tauri = (window as unknown as Record<string, unknown>).__TAURI__;
      if (!tauri) return;

      unlisten = await listen("tauri://new-session", (_event: Event<unknown>) => {
        onNewSession();
      });

      if (cleanedUp && unlisten) {
        unlisten();
      }
    };

    setup();

    return () => {
      cleanedUp = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [onNewSession]);
}
