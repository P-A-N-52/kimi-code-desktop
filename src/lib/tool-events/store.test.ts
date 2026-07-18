import { beforeEach, describe, expect, it } from "vitest";
import { handleToolResult, useToolEventsStore } from "./store";

describe("tool event store", () => {
  beforeEach(() => {
    useToolEventsStore.setState({ newFiles: [], todoItems: [], currentGoal: null });
  });

  it("restores goal lifecycle state during replay", () => {
    handleToolResult(
      "CreateGoal",
      JSON.stringify({
        objective: "Ship event UI coverage",
        completionCriterion: "All focused tests pass",
      }),
      false,
      true,
    );
    handleToolResult(
      "UpdateGoal",
      JSON.stringify({ status: "complete" }),
      false,
      true,
    );

    expect(useToolEventsStore.getState().currentGoal).toEqual({
      objective: "Ship event UI coverage",
      completionCriterion: "All focused tests pass",
      status: "complete",
    });
  });

  it("tracks files written by the current Write tool", () => {
    handleToolResult("Write", JSON.stringify({ path: "src/new.ts" }), false, false);
    expect(useToolEventsStore.getState().newFiles).toEqual(["src/new.ts"]);
  });

  it("restores TodoList state during replay", () => {
    handleToolResult(
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
    expect(useToolEventsStore.getState().todoItems).toEqual([
      { title: "Inspect", status: "done" },
      { title: "Implement", status: "in_progress" },
    ]);
    expect(useToolEventsStore.getState().newFiles).toEqual([]);
  });
});
