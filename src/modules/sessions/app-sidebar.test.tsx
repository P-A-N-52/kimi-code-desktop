import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UpdateAvailableBadge } from "./app-sidebar";

describe("UpdateAvailableBadge", () => {
  it("renders the subtle blue update concept", () => {
    render(<UpdateAvailableBadge />);

    const badge = screen.getByText("可更新");
    expect(badge.className).toContain("bg-sky-400/15");
    expect(badge.className).toContain("text-sky-600");
  });
});
