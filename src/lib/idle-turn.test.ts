import { describe, expect, it } from "vitest";
import { classifyIdleReason } from "./idle-turn";

describe("classifyIdleReason", () => {
  it("treats finished as successful turn complete (notifies)", () => {
    const c = classifyIdleReason("finished");
    expect(c.isTurnComplete).toBe(true);
    expect(c.isSuccessfulComplete).toBe(true);
    expect(c.wouldNotifySuccess).toBe(true);
    expect(c.isPromptFailure).toBe(false);
  });

  it("treats cancelled as turn complete (notifies cancel)", () => {
    const c = classifyIdleReason("cancelled");
    expect(c.isTurnComplete).toBe(true);
    expect(c.isCancelled).toBe(true);
    expect(c.wouldNotifySuccess).toBe(true);
  });

  it("treats prompt_* failures as turn complete without success notify", () => {
    const c = classifyIdleReason("prompt_error");
    expect(c.isTurnComplete).toBe(true);
    expect(c.isPromptFailure).toBe(true);
    expect(c.wouldNotifySuccess).toBe(false);
  });

  it("ignores connect/init reasons (old bug used prompt_* only)", () => {
    expect(classifyIdleReason("acp_connected").isTurnComplete).toBe(false);
    expect(classifyIdleReason("initialized").isTurnComplete).toBe(false);
    expect(classifyIdleReason("").isTurnComplete).toBe(false);
  });

  it("does not treat finished as prompt_* failure", () => {
    // Regression: previous gate was reason.startsWith("prompt_") only
    expect("finished".startsWith("prompt_")).toBe(false);
    expect(classifyIdleReason("finished").isTurnComplete).toBe(true);
  });
});
