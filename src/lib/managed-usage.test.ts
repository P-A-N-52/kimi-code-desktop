import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatResetTime,
  formatStatusReport,
  formatTokenCount,
  formatUsageReport,
  parseManagedUsageFetchResult,
  parseManagedUsagePayload,
  renderProgressBar,
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

  it("formats compact token counts like the CLI TUI", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1024)).toBe("1k");
    expect(formatTokenCount(101 * 1024)).toBe("101k");
    expect(formatTokenCount(6.4 * 1024 * 1024)).toBe("6.4M");
  });

  it("renders CLI-style progress bars", () => {
    expect(renderProgressBar(0.4, 20)).toBe("████████░░░░░░░░░░░░");
  });

  it("parses fetch wrapper and formats usage report like CLI /usage", () => {
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
      session: {
        contextUsage: 0.4,
        contextTokens: 101 * 1024,
        maxContextTokens: 256 * 1024,
        modelLabel: "kimi-code/kimi-for-coding",
        tokenInput: 6.4 * 1024 * 1024,
        tokenOutput: 35.6 * 1024,
      },
    });
    expect(text).toContain("Session usage");
    expect(text).toContain(
      "kimi-code/kimi-for-coding  input 6.4M  output 35.6k  total 6.4M",
    );
    expect(text).toContain("Context window");
    expect(text).toContain("████████░░░░░░░░░░░░");
    expect(text).toContain("40%");
    expect(text).toContain("(101k / 256k)");
    expect(text).toContain("Plan usage");
    expect(text).toContain("Weekly limit");
    expect(text).toContain("5h limit");
    expect(text).toContain("% used");
    expect(text).not.toContain("Plan quotas:");
    expect(text).not.toContain("% left");
  });

  it("formats status report like CLI /status", () => {
    const text = formatStatusReport({
      managed: { kind: "error", message: "Run kimi login" },
      status: {
        version: "0.29.1",
        model: "kimi-for-coding",
        modelDisplayName: "K2.7 Coding",
        workDir: "C:\\Users\\administer\\Desktop",
        sessionId: "session_00a5a606-1377-4287-8c95-c85777eb0169",
        sessionTitle: "我的v2r代理好像坏了",
        permissionMode: "auto",
        planMode: false,
        thinkingEffort: "on",
      },
      session: {
        contextUsage: 0.4,
        contextTokens: 101 * 1024,
        maxContextTokens: 256 * 1024,
      },
    });
    expect(text).toContain(">_ Kimi Code (v0.29.1)");
    expect(text).toContain("Model");
    expect(text).toContain("K2.7 Coding (thinking on)");
    expect(text).toContain("Directory");
    expect(text).toContain("C:\\Users\\administer\\Desktop");
    expect(text).toContain("Permissions");
    expect(text).toContain("auto");
    expect(text).toContain("Plan mode");
    expect(text).toContain("off");
    expect(text).toContain("Session");
    expect(text).toContain("session_00a5a606-1377-4287-8c95-c85777eb0169");
    expect(text).toContain("Title");
    expect(text).toContain("我的v2r代理好像坏了");
    expect(text).toContain("Context window");
    expect(text).toContain("(101k / 256k)");
    expect(text).toContain("Plan usage");
    expect(text).toContain("Run kimi login");
    expect(text).not.toContain("Version:");
    expect(text).not.toContain("Swarm mode:");
  });

  it("formats reset hints and durations", () => {
    expect(formatDuration(3661)).toBe("1h 1m");
    expect(formatResetTime("2099-01-01T00:00:00Z", Date.parse("2098-12-31T00:00:00Z"))).toBe(
      "resets in 1d",
    );
  });
});
