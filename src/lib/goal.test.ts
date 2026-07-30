import { describe, expect, it } from "vitest";
import { formatGoalStatus, type GoalItem, goalPromptForCommand, parseGoalCommand } from "./goal";

describe("goal commands", () => {
  it("parses CLI-compatible status and lifecycle controls", () => {
    expect(parseGoalCommand("")).toEqual({ kind: "status" });
    expect(parseGoalCommand("status")).toEqual({ kind: "status" });
    expect(parseGoalCommand("pause")).toEqual({ kind: "pause" });
    expect(parseGoalCommand("resume")).toEqual({ kind: "resume" });
    expect(parseGoalCommand("cancel")).toEqual({ kind: "cancel" });
  });

  it("parses create, next, and replace commands", () => {
    expect(parseGoalCommand("next run the release checks")).toEqual({
      kind: "create",
      objective: "run the release checks",
      replace: false,
    });
    expect(parseGoalCommand("ship the desktop")).toEqual({
      kind: "create",
      objective: "ship the desktop",
      replace: false,
    });
    const replace = parseGoalCommand("replace ship a safer desktop");
    expect(replace).toEqual({
      kind: "create",
      objective: "ship a safer desktop",
      replace: true,
    });
    expect(goalPromptForCommand(replace)).toEqual({
      action: "replace",
      text: "ship a safer desktop",
    });
  });

  it("matches Kimi command reservation and escape semantics", () => {
    expect(parseGoalCommand("replace").kind).toBe("invalid");
    expect(parseGoalCommand("budget")).toEqual({
      kind: "create",
      objective: "budget",
      replace: false,
    });
    expect(parseGoalCommand("help")).toEqual({
      kind: "create",
      objective: "help",
      replace: false,
    });

    expect(parseGoalCommand("STATUS")).toEqual({
      kind: "create",
      objective: "STATUS",
      replace: false,
    });
    expect(parseGoalCommand("pause now")).toEqual({
      kind: "create",
      objective: "pause now",
      replace: false,
    });
    expect(parseGoalCommand("-- pause")).toEqual({
      kind: "create",
      objective: "pause",
      replace: false,
    });
    expect(parseGoalCommand("next -- manage")).toEqual({
      kind: "create",
      objective: "manage",
      replace: false,
    });
  });
  it("formats the native snapshot and budgets", () => {
    const goal: GoalItem = {
      goalId: "goal-1",
      objective: "Ship Goal controls",
      status: "paused",
      turnsUsed: 2,
      tokensUsed: 1_200,
      wallClockMs: 90_000,
      terminalReason: "Paused from desktop",
      budget: {
        turnBudget: 5,
        tokenBudget: 2_000,
        wallClockBudgetMs: 300_000,
        tokenBudgetReached: false,
        turnBudgetReached: false,
        wallClockBudgetReached: false,
        overBudget: false,
      },
    };
    const report = formatGoalStatus(goal);
    expect(report).toContain("Status: paused");
    expect(report).toContain("Turns: 2 / 5");
    expect(report).toContain("Tokens: 1,200 / 2,000");
    expect(report).toContain("Time: 1m 30s / 5m");
  });
});
