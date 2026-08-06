import { describe, expect, it } from "vitest";
import type { Session, SessionStatus } from "@/lib/api/models";
import {
  getSessionRuntimeIndicator,
  summarizeSessionRuntimeIndicators,
} from "./session-runtime-indicator";

function session(id: string, state?: SessionStatus["state"], isRunning = false): Session {
  return {
    sessionId: id,
    title: id,
    lastUpdated: new Date("2026-08-03T00:00:00Z"),
    isRunning,
    status: state
      ? {
          sessionId: id,
          state,
          seq: 1,
          updatedAt: new Date("2026-08-03T00:00:00Z"),
        }
      : undefined,
  };
}

describe("session runtime indicator", () => {
  it("maps busy, idle, stopped, and error to distinct visual states", () => {
    expect(getSessionRuntimeIndicator(session("busy", "busy"))).toBe("working");
    expect(getSessionRuntimeIndicator(session("idle", "idle"))).toBe("connected");
    expect(getSessionRuntimeIndicator(session("stopped", "stopped", true))).toBe("hidden");
    expect(getSessionRuntimeIndicator(session("error", "error", true))).toBe("error");
  });

  it("uses a running worker as a connected fallback before status arrives", () => {
    expect(getSessionRuntimeIndicator(session("connected", undefined, true))).toBe("connected");
    expect(getSessionRuntimeIndicator(session("absent"))).toBe("hidden");
  });

  it("prioritizes active work, then errors, then idle connections", () => {
    expect(
      summarizeSessionRuntimeIndicators([
        session("idle", "idle"),
        session("error", "error"),
        session("busy", "busy"),
      ]),
    ).toBe("working");
    expect(
      summarizeSessionRuntimeIndicators([session("idle", "idle"), session("error", "error")]),
    ).toBe("error");
  });
});
