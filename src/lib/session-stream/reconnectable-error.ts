import type { SessionStatus } from "@/lib/api/models";
import type { ConnectionPhase } from "./types";

const CONNECTION_ERROR_PATTERNS = [
  /acp session shutting down/i,
  /acp worker/i,
  /worker (?:was )?(?:replaced|disconnected|stopped)/i,
  /failed to connect/i,
  /connection (?:error|closed|failed|lost|refused)/i,
  /websocket/i,
  /network/i,
  /timed? out/i,
  /authentication|credential/i,
  /failed to (?:spawn|start|initialize).*acp/i,
];

export function isReconnectableStreamError({
  error,
  connectionPhase,
  sessionStatus,
}: {
  error: Error | null;
  connectionPhase?: ConnectionPhase;
  sessionStatus: SessionStatus | null;
}): boolean {
  if (!error) return false;
  if (connectionPhase === "disconnected" || connectionPhase === "reconnecting") return true;
  if (sessionStatus?.state === "error" || sessionStatus?.state === "restarting") return true;
  return CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(error.message));
}
