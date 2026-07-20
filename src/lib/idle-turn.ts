/** Classify ACP/legacy idle `reason` for refresh + notification gating. */
export function classifyIdleReason(reason: string): {
  isSuccessfulComplete: boolean;
  isCancelled: boolean;
  isPromptFailure: boolean;
  isTurnComplete: boolean;
  wouldNotifySuccess: boolean;
} {
  const isSuccessfulComplete = reason === "finished";
  const isCancelled = reason === "cancelled";
  const isPromptFailure = reason.startsWith("prompt_");
  const isTurnComplete = isSuccessfulComplete || isCancelled || isPromptFailure;
  return {
    isSuccessfulComplete,
    isCancelled,
    isPromptFailure,
    isTurnComplete,
    wouldNotifySuccess: isSuccessfulComplete || isCancelled,
  };
}
