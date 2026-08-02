import { describe, expect, it } from "vitest";
import {
  formatAgentModelDisplay,
  resolveAgentModelDisplay,
} from "./agent-model-display";

describe("resolveAgentModelDisplay", () => {
  it("returns null when runtime provides no model binding", () => {
    expect(resolveAgentModelDisplay({})).toBeNull();
    expect(resolveAgentModelDisplay({ boundModel: "", modelPreference: null })).toBeNull();
  });

  it("shows bound model alias when provided", () => {
    expect(
      resolveAgentModelDisplay({ boundModel: "kimi-code/kimi-k2.5" }),
    ).toEqual({
      modelLabel: "kimi-code/kimi-k2.5",
    });
  });

  it("shows unknown when preference exists without alias", () => {
    expect(resolveAgentModelDisplay({ modelPreference: "secondary" })).toEqual({
      preference: "secondary",
      modelLabel: "unknown",
    });
  });

  it("formats preference and alias together", () => {
    const display = resolveAgentModelDisplay({
      modelPreference: "primary",
      boundModel: "kimi",
    });
    expect(display).not.toBeNull();
    expect(formatAgentModelDisplay(display!)).toBe("primary · kimi");
  });
});
