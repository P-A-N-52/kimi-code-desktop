import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type GoalQueueItem, GoalQueueManager } from "./goal-queue-manager";

const goals: GoalQueueItem[] = [
  {
    id: "goal-1",
    objective: "Ship the desktop",
    createdAt: "2026-07-29T08:00:00Z",
    updatedAt: "2026-07-29T08:30:00Z",
  },
  {
    id: "goal-2",
    objective: "Verify the release",
    createdAt: "2026-07-29T09:00:00Z",
    updatedAt: "2026-07-29T09:30:00Z",
  },
  {
    id: "goal-3",
    objective: "Publish the notes",
    createdAt: "2026-07-29T10:00:00Z",
    updatedAt: "2026-07-29T10:30:00Z",
  },
];

const baseProps = {
  open: true,
  goals,
  onOpenChange: vi.fn(),
  onMove: vi.fn(),
  onDelete: vi.fn(),
  onEdit: vi.fn(),
};

describe("GoalQueueManager", () => {
  it("shows an empty state", () => {
    render(<GoalQueueManager {...baseProps} goals={[]} />);

    expect(screen.getByRole("dialog", { name: "管理 Goal 队列" })).toBeTruthy();
    expect(screen.getByText("当前没有排队的 Goal。")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Goal 队列" })).toBeNull();
  });

  it("moves goals and disables movement at the queue boundaries", () => {
    const onMove = vi.fn();
    render(<GoalQueueManager {...baseProps} onMove={onMove} />);

    expect(
      (screen.getByRole("button", { name: "上移 Ship the desktop" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "下移 Publish the notes" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "上移 Verify the release" }));
    fireEvent.click(screen.getByRole("button", { name: "下移 Verify the release" }));

    expect(onMove.mock.calls).toEqual([
      ["goal-2", "up"],
      ["goal-2", "down"],
    ]);
  });

  it("saves a trimmed inline edit and cancels without saving", () => {
    const onEdit = vi.fn();
    render(<GoalQueueManager {...baseProps} onEdit={onEdit} />);

    fireEvent.click(screen.getByRole("button", { name: "编辑 Ship the desktop" }));
    const firstEditor = screen.getByRole("textbox", { name: "编辑 Goal：Ship the desktop" });
    fireEvent.change(firstEditor, { target: { value: "  Ship the polished desktop  " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onEdit).toHaveBeenCalledWith("goal-1", "Ship the polished desktop");
    expect(screen.getByRole("textbox", { name: "编辑 Goal：Ship the desktop" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    fireEvent.click(screen.getByRole("button", { name: "编辑 Verify the release" }));
    fireEvent.change(screen.getByRole("textbox", { name: "编辑 Goal：Verify the release" }), {
      target: { value: "Do not save this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Verify the release")).toBeTruthy();
  });

  it("deletes a queued Goal", () => {
    const onDelete = vi.fn();
    render(<GoalQueueManager {...baseProps} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole("button", { name: "删除 Verify the release" }));
    expect(onDelete).toHaveBeenCalledWith("goal-2");
  });

  it("locks the whole queue while one mutation is pending", () => {
    const onOpenChange = vi.fn();
    render(<GoalQueueManager {...baseProps} pendingGoalId="goal-2" onOpenChange={onOpenChange} />);

    expect(screen.getByRole("status", { name: "正在处理 Verify the release" })).toBeTruthy();
    for (const name of [
      "上移 Verify the release",
      "下移 Verify the release",
      "编辑 Verify the release",
      "删除 Verify the release",
    ]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(
      (screen.getByRole("button", { name: "编辑 Ship the desktop" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
