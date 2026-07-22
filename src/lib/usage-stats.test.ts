import { describe, expect, it } from "vitest";
import {
  formatCount,
  formatSeriesLabel,
  parseUsageStatsPayload,
} from "./usage-stats";

describe("usage-stats", () => {
  it("parses aggregate payload", () => {
    const parsed = parseUsageStatsPayload({
      range: "7d",
      summary: {
        requests: 2,
        inputOther: 15,
        output: 3,
        inputCacheRead: 1,
        inputCacheCreation: 3,
        totalTokens: 22,
      },
      series: [{ key: "2026-07-22", requests: 2, inputOther: 15, output: 3 }],
      byModel: [{ model: "kimi-k2", requests: 1, inputOther: 10, output: 2 }],
      scannedFiles: 4,
      recordCount: 2,
      startMs: 1,
      endMs: 2,
    });

    expect(parsed.range).toBe("7d");
    expect(parsed.summary.totalTokens).toBe(22);
    expect(parsed.series[0]?.key).toBe("2026-07-22");
    expect(parsed.byModel[0]?.model).toBe("kimi-k2");
    expect(parsed.recordCount).toBe(2);
  });

  it("fills missing totals from parts", () => {
    const parsed = parseUsageStatsPayload({
      range: "today",
      summary: {
        requests: 1,
        inputOther: 10,
        output: 5,
        inputCacheRead: 1,
        inputCacheCreation: 2,
      },
      series: [],
      byModel: [],
    });
    expect(parsed.summary.totalTokens).toBe(18);
  });

  it("formats labels and counts", () => {
    expect(formatCount(1234)).toBe("1,234");
    expect(formatSeriesLabel("today", "09")).toBe("09:00");
    expect(formatSeriesLabel("7d", "2026-07-22")).toBe("07-22");
  });
});
