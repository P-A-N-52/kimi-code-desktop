import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetThemeTransitionForTests, useTheme } from "./use-theme";

function ThemeProbe({ id }: { id: string }) {
  const { theme, setTheme, toggleThemeWithTransition } = useTheme();

  return (
    <div>
      <output aria-label={`theme-${id}`}>{theme}</output>
      <button type="button" onClick={() => setTheme("dark")}>
        dark-{id}
      </button>
      <button type="button" onClick={() => setTheme("light")}>
        light-{id}
      </button>
      <button type="button" onClick={() => void toggleThemeWithTransition()}>
        toggle-transition-{id}
      </button>
    </div>
  );
}

describe("useTheme", () => {
  beforeEach(() => {
    __resetThemeTransitionForTests();
    window.localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.style.colorScheme = "";
    document.documentElement.removeAttribute("data-theme-switching");
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("shares theme state across hook users and applies it to the document", async () => {
    const user = userEvent.setup();
    render(
      <>
        <ThemeProbe id="a" />
        <ThemeProbe id="b" />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "dark-a" }));

    await waitFor(() => {
      expect(screen.getByLabelText("theme-a").textContent).toBe("dark");
      expect(screen.getByLabelText("theme-b").textContent).toBe("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      expect(window.localStorage.getItem("kimi-theme")).toBe("dark");
    });

    await user.click(screen.getByRole("button", { name: "light-b" }));

    await waitFor(() => {
      expect(screen.getByLabelText("theme-a").textContent).toBe("light");
      expect(screen.getByLabelText("theme-b").textContent).toBe("light");
      expect(document.documentElement.classList.contains("dark")).toBe(false);
      expect(window.localStorage.getItem("kimi-theme")).toBe("light");
    });
  });

  it("queues a second transition toggle while one is in flight", async () => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const finished = Promise.resolve();

    const startViewTransition = vi.fn((callback: () => void) => {
      callback();
      return {
        ready,
        finished,
        updateCallbackDone: Promise.resolve(),
        skipTransition: () => {},
      };
    });
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: startViewTransition,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });

    const user = userEvent.setup();
    render(<ThemeProbe id="guard" />);

    await user.click(screen.getByRole("button", { name: "toggle-transition-guard" }));
    await user.click(screen.getByRole("button", { name: "toggle-transition-guard" }));

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(document.documentElement.style.getPropertyValue("--kimi-theme-duration")).toBe(
      "450ms",
    );

    resolveReady();
    await waitFor(() => {
      expect(document.documentElement.hasAttribute("data-theme-switching")).toBe(false);
    });
  });

  it("keeps View Transitions enabled under Tauri", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const startViewTransition = vi.fn((callback: () => void) => {
      callback();
      return {
        ready: Promise.resolve(),
        finished: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        skipTransition: () => {},
      };
    });
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: startViewTransition,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: () => ({
        matches: false,
        media: "",
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });

    const user = userEvent.setup();
    render(<ThemeProbe id="tauri" />);
    await user.click(screen.getByRole("button", { name: "toggle-transition-tauri" }));

    await waitFor(() => {
      expect(startViewTransition).toHaveBeenCalled();
      expect(screen.getByLabelText("theme-tauri").textContent).toBe("dark");
    });
  });
});
