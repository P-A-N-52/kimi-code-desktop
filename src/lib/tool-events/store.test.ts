import { beforeEach, describe, expect, it } from "vitest";
import { getToolEventsSnapshot, handleToolResult, useToolEventsStore } from "./store";

const SESSION_ID = "session-a";

describe("tool event store", () => {
  beforeEach(() => {
    useToolEventsStore.setState({ sessions: {} });
  });

  it("restores goal lifecycle state during replay", () => {
    handleToolResult(
      SESSION_ID,
      "CreateGoal",
      JSON.stringify({
        objective: "Ship event UI coverage",
        completionCriterion: "All focused tests pass",
      }),
      false,
      true,
    );
    handleToolResult(
      SESSION_ID,
      "UpdateGoal",
      JSON.stringify({ status: "complete" }),
      false,
      true,
    );

    expect(getToolEventsSnapshot(SESSION_ID).currentGoal).toEqual({
      objective: "Ship event UI coverage",
      completionCriterion: "All focused tests pass",
      status: "complete",
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      budget: {
        tokenBudgetReached: false,
        turnBudgetReached: false,
        wallClockBudgetReached: false,
        overBudget: false,
      },
    });
  });

  it("tracks files written by the current Write tool", () => {
    handleToolResult(SESSION_ID, "Write", JSON.stringify({ path: "src/new.ts" }), false, false);
    expect(getToolEventsSnapshot(SESSION_ID).newFiles).toEqual(["src/new.ts"]);
  });

  it("restores TodoList state during replay", () => {
    handleToolResult(
      SESSION_ID,
      "TodoList",
      JSON.stringify({
        todos: [
          { title: "Inspect", status: "done" },
          { title: "Implement", status: "in_progress" },
        ],
      }),
      false,
      true,
    );
    expect(getToolEventsSnapshot(SESSION_ID).todoItems).toEqual([
      { title: "Inspect", status: "done" },
      { title: "Implement", status: "in_progress" },
    ]);
    expect(getToolEventsSnapshot(SESSION_ID).newFiles).toEqual([]);
  });

  it("isolates background and replayed events by session", () => {
    handleToolResult(
      "foreground",
      "TodoList",
      JSON.stringify({ todos: [{ title: "Front", status: "in_progress" }] }),
      false,
      false,
    );
    handleToolResult(
      "background",
      "TodoList",
      JSON.stringify({ todos: [{ title: "Back", status: "done" }] }),
      false,
      true,
    );
    handleToolResult(
      "background",
      "Write",
      JSON.stringify({ path: "background.txt" }),
      false,
      false,
    );

    expect(getToolEventsSnapshot("foreground")).toMatchObject({
      todoItems: [{ title: "Front", status: "in_progress" }],
      newFiles: [],
    });
    expect(getToolEventsSnapshot("background")).toMatchObject({
      todoItems: [{ title: "Back", status: "done" }],
      newFiles: ["background.txt"],
    });

    useToolEventsStore.getState().clearSession("foreground");
    expect(getToolEventsSnapshot("foreground").todoItems).toEqual([]);
    expect(getToolEventsSnapshot("background").todoItems).toHaveLength(1);
  });
});
