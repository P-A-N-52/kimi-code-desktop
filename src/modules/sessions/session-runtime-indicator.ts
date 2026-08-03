import type { Session } from "@/lib/api/models";

export type SessionRuntimeIndicator = "working" | "connected" | "error" | "hidden";

export function getSessionRuntimeIndicator(session: Session): SessionRuntimeIndicator {
  switch (session.status?.state) {
    case "busy":
      return "working";
    case "idle":
      return "connected";
    case "error":
      return "error";
    case "stopped":
    case "restarting":
      return "hidden";
    default:
      return session.isRunning ? "connected" : "hidden";
  }
}

export function summarizeSessionRuntimeIndicators(sessions: Session[]): SessionRuntimeIndicator {
  const indicators = sessions.map(getSessionRuntimeIndicator);
  if (indicators.includes("working")) return "working";
  if (indicators.includes("error")) return "error";
  if (indicators.includes("connected")) return "connected";
  return "hidden";
}

export function sessionRuntimeIndicatorLabel(indicator: SessionRuntimeIndicator): string {
  switch (indicator) {
    case "working":
      return "模型正在响应";
    case "connected":
      return "ACP 已连接";
    case "error":
      return "ACP 连接异常";
    default:
      return "ACP 未连接";
  }
}
