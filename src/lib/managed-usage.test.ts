import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatResetTime,
  formatStatusReport,
  formatUsageReport,
  parseManagedUsageFetchResult,
  parseManagedUsagePayload,
} from "./managed-usage";

describe("managed-usage", () => {
  it("parses weekly summary, 5h limit, and extra usage", () => {
    const parsed = parseManagedUsagePayload({
      usage: { used: 40, limit: 1000, name: "Weekly limit", resetAt: "2099-01-01T00:00:00.000Z" },
      limits: [
        {
          detail: { used: 10, limit: 100, name: "5h limit" },
          window: { duration: 5, timeUnit: "HOUR" },
        },
      ],
      boosterWallet: {
        balance: {
          type: "BOOSTER",
          amount: "20000000000",
          amountLeft: "10000000000",
        },
        monthlyChargeLimitEnabled: true,
        monthlyChargeLimit: { currency: "USD", priceInCents: "20000" },
        monthlyUsed: { currency: "USD", priceInCents: "5000" },
      },
    });

    expect(parsed.summary).toMatchObject({
      label: "Weekly limit",
      used: 40,
      limit: 1000,
    });
    expect(parsed.limits[0]).toMatchObject({
      label: "5h limit",
      used: 10,
      limit: 100,
    });
    expect(parsed.extraUsage).toMatchObject({
      balanceCents: 10000,
      totalCents: 20000,
      monthlyChargeLimitCents: 20000,
      monthlyUsedCents: 5000,
      currency: "USD",
    });
  });

  it("derives hour labels from window metadata", () => {
    const parsed = parseManagedUsagePayload({
      usage: { used: 1, limit: 10 },
      limits: [
        {
          detail: { used: 2, limit: 20 },
          window: { duration: 300, timeUnit: "MINUTE" },
        },
      ],
    });
    expect(parsed.limits[0]?.label).toBe("5h limit");
  });

  it("parses fetch wrapper and formats usage report with quotas", () => {
    const managed = parseManagedUsageFetchResult({
      kind: "ok",
      payload: {
        usage: { used: 25, limit: 100, name: "Weekly limit" },
        limits: [{ detail: { used: 5, limit: 50, name: "5h limit" } }],
      },
    });
    expect(managed.kind).toBe("ok");
    const text = formatUsageReport({
      managed,
      session: { contextUsage: 0.42, contextTokens: 4200, maxContextTokens: 10000 },
    });
    expect(text).toContain("Plan quotas:");
    expect(text).toContain("Weekly limit");
    expect(text).toContain("5h limit");
    expect(text).toContain("42%");
    expect(text).toContain("4,200 / 10,000");
  });

  it("formats status report with session metadata and quota error", () => {
    const text = formatStatusReport({
      managed: { kind: "error", message: "Run kimi login" },
      status: {
        version: "0.27.0",
        model: "kimi-for-coding",
        workDir: "C:\\proj",
        permissionMode: "manual",
        planMode: false,
        swarmMode: true,
      },
    });
    expect(text).toContain("Version: 0.27.0");
    expect(text).toContain("Swarm mode: on");
    expect(text).toContain("Run kimi login");
  });

  it("formats reset hints and durations", () => {
    expect(formatDuration(3661)).toBe("1h 1m");
    expect(formatResetTime("2099-01-01T00:00:00Z", Date.parse("2098-12-31T00:00:00Z"))).toBe(
      "resets in 1d",
    );
  });
});
