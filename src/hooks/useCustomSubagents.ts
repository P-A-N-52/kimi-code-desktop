import { useCallback, useSyncExternalStore } from "react";
import {
  CUSTOM_SUBAGENTS_CHANGE_EVENT,
  CUSTOM_SUBAGENTS_STORAGE_KEY,
  isCustomSubagentsEnabled,
  setCustomSubagentsEnabled,
} from "@/lib/features";

function subscribeCustomSubagents(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const handleCustomSubagentsChange = () => onStoreChange();
  const handleStorage = (event: StorageEvent) => {
    if (event.key === CUSTOM_SUBAGENTS_STORAGE_KEY) onStoreChange();
  };

  window.addEventListener(CUSTOM_SUBAGENTS_CHANGE_EVENT, handleCustomSubagentsChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(CUSTOM_SUBAGENTS_CHANGE_EVENT, handleCustomSubagentsChange);
    window.removeEventListener("storage", handleStorage);
  };
}

const getCustomSubagentsServerSnapshot = () => false;

export function useCustomSubagentsEnabled(): {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
} {
  const enabled = useSyncExternalStore(
    subscribeCustomSubagents,
    isCustomSubagentsEnabled,
    getCustomSubagentsServerSnapshot,
  );
  const setEnabled = useCallback((nextEnabled: boolean) => {
    setCustomSubagentsEnabled(nextEnabled);
  }, []);

  return { enabled, setEnabled };
}
