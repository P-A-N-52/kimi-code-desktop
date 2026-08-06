import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TermView } from "./term-view";

describe("TermView", () => {
  it("can expand and collapse truncated output while preserving expansion on updates", async () => {
    const user = userEvent.setup();
    const output = Array.from({ length: 2001 }, (_, index) => `line-${index}`).join("\n");
    const { rerender } = render(<TermView output={output} />);

    expect(screen.getByText("line-0")).toBeTruthy();
    expect(screen.getByText("line-1999")).toBeTruthy();
    expect(screen.queryByText("line-2000")).toBeNull();
    expect(screen.getByText("输出已截断（共 2001 行）")).toBeTruthy();
    expect(screen.getByRole("button", { name: "显示完整输出" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "显示完整输出" }));
    expect(screen.getByText("line-2000")).toBeTruthy();
    expect(screen.queryByText("输出已截断（共 2001 行）")).toBeNull();
    expect(screen.getByRole("button", { name: "收起" })).toBeTruthy();

    rerender(
      <TermView
        output={Array.from({ length: 2002 }, (_, index) => `line-${index}`).join("\n")}
      />,
    );
    expect(screen.getByText("line-2001")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.queryByText("line-2000")).toBeNull();
    expect(screen.getByText("输出已截断（共 2002 行）")).toBeTruthy();
  });
});
