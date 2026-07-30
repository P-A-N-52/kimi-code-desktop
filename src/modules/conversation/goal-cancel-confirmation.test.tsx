import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GoalCancelConfirmation } from "./goal-cancel-confirmation";

describe("GoalCancelConfirmation", () => {
  it("requires an explicit confirmation before cancelling", () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <GoalCancelConfirmation
        open
        objective="Ship native Goal parity"
        pending={false}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("dialog", { name: "取消当前 Goal？" })).toBeTruthy();
    expect(screen.getByText("Ship native Goal parity")).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认取消" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("does not close while cancellation is pending", () => {
    const onOpenChange = vi.fn();
    render(<GoalCancelConfirmation open pending onOpenChange={onOpenChange} onConfirm={vi.fn()} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "正在取消…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
