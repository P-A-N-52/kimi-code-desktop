import { useEffect, useCallback } from "react";
import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";
import { showWindow } from "@/lib/tauri-api";

export async function requestNotificationPermission(): Promise<"default" | "denied" | "granted"> {
  if (!("Notification" in window)) {
    return "denied";
  }
  return Notification.requestPermission();
}

export async function showApprovalNotification(
  _sessionId: string,
  _requestId: string,
  description: string,
): Promise<void> {
  if (!("Notification" in window)) {
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return;
  }
  new Notification("Approval Request", { body: description });
}

export async function showTaskCompleteNotification(
  _sessionId: string,
  title: string,
): Promise<void> {
  if (!("Notification" in window)) {
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return;
  }
  new Notification("Task Complete", { body: title });
}

/**
 * Hook that listens to Tauri notification events.
 * When a notification event is received, brings the window to the foreground
 * and invokes the callback to focus the corresponding session.
 */
export function useNotificationEvents(onFocusSession: (sessionId: string) => void): void {
  const handleFocusSession = useCallback(
    (sessionId: string) => {
      showWindow().catch(() => {
        // Ignore window show errors
      });
      onFocusSession(sessionId);
    },
    [onFocusSession],
  );

  useEffect(() => {
    let unlistenApproval: UnlistenFn | undefined;
    let unlistenTaskComplete: UnlistenFn | undefined;
    let cleanedUp = false;

    const setup = async () => {
      const tauri = (window as unknown as Record<string, unknown>).__TAURI__;
      if (!tauri) return;

      unlistenApproval = await listen("notification:approval", (event: Event<unknown>) => {
        const payload = event.payload as Record<string, unknown> | undefined;
        if (payload && typeof payload.session_id === "string") {
          handleFocusSession(payload.session_id);
        }
      });

      if (cleanedUp) {
        if (unlistenApproval) unlistenApproval();
        return;
      }

      unlistenTaskComplete = await listen("notification:task-complete", (event: Event<unknown>) => {
        const payload = event.payload as Record<string, unknown> | undefined;
        if (payload && typeof payload.session_id === "string") {
          handleFocusSession(payload.session_id);
        }
      });

      if (cleanedUp && unlistenTaskComplete) {
        unlistenTaskComplete();
      }
    };

    setup();

    return () => {
      cleanedUp = true;
      if (unlistenApproval) unlistenApproval();
      if (unlistenTaskComplete) unlistenTaskComplete();
    };
  }, [handleFocusSession]);
}
