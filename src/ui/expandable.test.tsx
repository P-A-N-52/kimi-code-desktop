import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Expandable } from "./expandable";

describe("Expandable", () => {
  it("lazy mounts children on first open and keeps them mounted when closed", () => {
    const view = render(
      <Expandable open={false} data-slot="expandable">
        <div data-testid="expandable-body">large body</div>
      </Expandable>,
    );

    expect(screen.queryByTestId("expandable-body")).toBeNull();
    expect(document.querySelector("[data-slot=expandable]")?.getAttribute("data-open")).toBe(
      "false",
    );

    view.rerender(
      <Expandable open data-slot="expandable">
        <div data-testid="expandable-body">large body</div>
      </Expandable>,
    );

    expect(screen.getByTestId("expandable-body")).toBeTruthy();

    view.rerender(
      <Expandable open={false} data-slot="expandable">
        <div data-testid="expandable-body">large body</div>
      </Expandable>,
    );

    expect(screen.getByTestId("expandable-body")).toBeTruthy();
  });
});
