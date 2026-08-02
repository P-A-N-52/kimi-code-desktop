import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CUSTOM_SUBAGENTS_STORAGE_KEY } from "@/lib/features";
import { useCustomSubagentsEnabled } from "./useCustomSubagents";

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn() }));

vi.mock("@/lib/tauri-api", () => ({ isTauri: isTauriMock }));

function Probe({ id }: { id: string }) {
  const { enabled, setEnabled } = useCustomSubagentsEnabled();

  return (
    <div>
      <output aria-label={`custom-subagents-${id}`}>{enabled ? "on" : "off"}</output>
      <button type="button" onClick={() => setEnabled(!enabled)}>
        toggle-{id}
      </button>
    </div>
  );
}

describe("useCustomSubagentsEnabled", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true);
    window.localStorage.clear();
  });

  it("shares same-window changes immediately and persists them locally", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>,
    );

    expect(screen.getByLabelText("custom-subagents-a").textContent).toBe("off");
    expect(screen.getByLabelText("custom-subagents-b").textContent).toBe("off");

    await user.click(screen.getByRole("button", { name: "toggle-a" }));
    await waitFor(() => {
      expect(screen.getByLabelText("custom-subagents-a").textContent).toBe("on");
      expect(screen.getByLabelText("custom-subagents-b").textContent).toBe("on");
      expect(window.localStorage.getItem(CUSTOM_SUBAGENTS_STORAGE_KEY)).toBe("1");
    });

    await user.click(screen.getByRole("button", { name: "toggle-b" }));
    await waitFor(() => {
      expect(screen.getByLabelText("custom-subagents-a").textContent).toBe("off");
      expect(screen.getByLabelText("custom-subagents-b").textContent).toBe("off");
      expect(window.localStorage.getItem(CUSTOM_SUBAGENTS_STORAGE_KEY)).toBe("0");
    });
  });

  it("does not enable the experiment outside the desktop runtime", async () => {
    isTauriMock.mockReturnValue(false);
    window.localStorage.setItem(CUSTOM_SUBAGENTS_STORAGE_KEY, "1");
    render(<Probe id="web" />);

    expect(screen.getByLabelText("custom-subagents-web").textContent).toBe("off");
    await userEvent.setup().click(screen.getByRole("button", { name: "toggle-web" }));
    expect(screen.getByLabelText("custom-subagents-web").textContent).toBe("off");
  });
});
