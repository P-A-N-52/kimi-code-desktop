import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SubagentStep } from "@/hooks/types";
import { SubagentSteps } from "./subagent-steps";

function makeSteps(count: number): SubagentStep[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "tool-call",
    toolCallId: `tool-${index}`,
    toolName: `tool-${index}`,
    status: "success",
    output: "done",
  }));
}

describe("SubagentSteps", () => {
  it("shows the latest 60 steps while keeping full tool counts", () => {
    const steps = makeSteps(63);

    render(<SubagentSteps steps={steps} defaultOpen />);

    expect(screen.getByRole("button", { name: "子代理 已完成 · 63/63 工具调用" })).toBeTruthy();
    expect(screen.getByText("… 其余 3 条")).toBeTruthy();
    expect(screen.queryByText("tool-2")).toBeNull();
    expect(screen.getByText("tool-3")).toBeTruthy();
    expect(screen.getByText("tool-62")).toBeTruthy();
  });

  it("expands all steps, preserves the choice during updates, and can collapse again", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<SubagentSteps steps={makeSteps(61)} defaultOpen />);

    await user.click(screen.getByRole("button", { name: "展开全部" }));
    expect(screen.getByText("tool-0")).toBeTruthy();
    expect(screen.getByText("tool-60")).toBeTruthy();
    expect(screen.getByRole("button", { name: "收起" })).toBeTruthy();

    rerender(<SubagentSteps steps={makeSteps(62)} defaultOpen />);
    expect(screen.getByText("tool-61")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.queryByText("tool-0")).toBeNull();
    expect(screen.getByText("tool-2")).toBeTruthy();
    expect(screen.getByText("tool-61")).toBeTruthy();
  });
});
