import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GoalStartConfirmation } from "./goal-start-confirmation";

describe("GoalStartConfirmation", () => {
  it("offers the same permission choices as Kimi Code in Manual mode", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <GoalStartConfirmation
        objective="Ship the desktop"
        permissionMode="manual"
        replace={false}
        pending={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole("dialog", { name: "启动 Goal" })).toBeTruthy();
    expect(screen.getByText("Ship the desktop")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "切换 Auto 并开始" }));
    fireEvent.click(screen.getByRole("button", { name: "切换 YOLO 并开始" }));
    fireEvent.click(screen.getByRole("button", { name: "保持 Manual 并开始" }));
    fireEvent.click(screen.getByRole("button", { name: "不开始" }));

    expect(onConfirm.mock.calls).toEqual([["auto"], ["yolo"], ["manual"]]);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps YOLO or switches to Auto when the current mode is YOLO", () => {
    const onConfirm = vi.fn();
    render(
      <GoalStartConfirmation
        objective="Run the release"
        permissionMode="yolo"
        replace
        pending={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("替换并启动 Goal？")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "保持 Manual 并开始" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保持 YOLO 并开始" }));
    expect(onConfirm).toHaveBeenCalledWith("yolo");
  });

  it("disables every choice while the confirmed Goal is being submitted", () => {
    render(
      <GoalStartConfirmation
        objective="Verify the fix"
        permissionMode="manual"
        replace={false}
        pending
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    for (const button of screen.getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
