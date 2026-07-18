import { describe, expect, it, vi } from "vitest";
import {
  KIMI_CODE_URL,
  openKimiCodeWebsite,
  shouldInterceptKimiCodeLink,
} from "./kimi-code-link";

vi.mock("@/lib/tauri-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri-api")>();
  return {
    ...actual,
    isTauri: vi.fn(() => false),
    openExternal: vi.fn(() => Promise.resolve()),
  };
});

describe("kimi-code-link", () => {
  describe("KIMI_CODE_URL", () => {
    it("is the expected URL", () => {
      expect(KIMI_CODE_URL).toBe("https://www.kimi.com/code");
    });
  });

  describe("shouldInterceptKimiCodeLink", () => {
    it("returns false when not in Tauri", () => {
      expect(shouldInterceptKimiCodeLink()).toBe(false);
    });
  });

  describe("openKimiCodeWebsite", () => {
    it("opens via window.open when not in Tauri", () => {
      const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
      openKimiCodeWebsite();
      expect(openSpy).toHaveBeenCalledWith(KIMI_CODE_URL, "_blank", "noopener,noreferrer");
      openSpy.mockRestore();
    });
  });
});
