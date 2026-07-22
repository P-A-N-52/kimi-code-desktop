import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandResultPanel } from "./command-result-panel";

describe("CommandResultPanel", () => {
  it("renders command content and closes on button click", () => {
    const onClose = vi.fn();
    render(
      <CommandResultPanel
        result={{ command: "usage", content: "Usage\nQuota ok", loading: false }}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole("dialog", { name: "/usage" })).toBeTruthy();
    expect(screen.getByText(/Quota ok/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <CommandResultPanel
        result={{ command: "status", content: "Status", loading: false }}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows loading placeholder", () => {
    render(
      <CommandResultPanel
        result={{ command: "usage", content: "", loading: true }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("查询中…")).toBeTruthy();
  });
});
