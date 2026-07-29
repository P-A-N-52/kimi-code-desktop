import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GoalItem } from "@/lib/goal";
import { GoalCard } from "./goal-card";

const GOAL: GoalItem = {
  objective: "Ship native Goal parity",
  status: "active",
  turnsUsed: 2,
  tokensUsed: 500,
  wallClockMs: 2000,
  budget: {
    tokenBudgetReached: false,
    turnBudgetReached: false,
    wallClockBudgetReached: false,
    overBudget: false,
  },
};

describe("GoalCard", () => {
  it("does not expose a manual clear action for transient completed Goals", () => {
    render(
      <GoalCard
        goal={{ ...GOAL, status: "complete" }}
        onControl={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText("已完成")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("清除")).toBeNull();
  });
});
