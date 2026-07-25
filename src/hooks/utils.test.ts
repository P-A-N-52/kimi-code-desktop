import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./utils";

describe("formatRelativeTime", () => {
  it("formats recent timestamps in the selected UI language", () => {
    const now = Date.now();
    expect(formatRelativeTime(new Date(now), "en-US")).toBe("Just now");
    expect(formatRelativeTime(new Date(now), "zh-CN")).toBe("刚刚");
  });

  it("uses Intl relative-time formatting for older timestamps", () => {
    const ninetyMinutesAgo = new Date(Date.now() - 90 * 60 * 1000);
    expect(formatRelativeTime(ninetyMinutesAgo, "en-US")).toContain("hour");
    expect(formatRelativeTime(ninetyMinutesAgo, "zh-CN")).toContain("小时");
  });
});
