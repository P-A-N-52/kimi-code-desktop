import { describe, expect, it } from "vitest";
import { isNewerDesktopVersion } from "./desktop-update";

describe("isNewerDesktopVersion", () => {
  it("detects a newer release tag", () => {
    expect(isNewerDesktopVersion("v1.2.0", "1.1.2")).toBe(true);
    expect(isNewerDesktopVersion("2.0.0", "1.9.9")).toBe(true);
  });

  it("does not report equal, older, or malformed versions", () => {
    expect(isNewerDesktopVersion("v1.1.2", "1.1.2")).toBe(false);
    expect(isNewerDesktopVersion("1.1.1", "1.1.2")).toBe(false);
    expect(isNewerDesktopVersion("1.0.9", "1.1.0")).toBe(false);
    expect(isNewerDesktopVersion("latest", "1.1.2")).toBe(false);
  });
});
