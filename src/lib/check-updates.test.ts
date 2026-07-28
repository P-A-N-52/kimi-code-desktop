import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  checkAllUpdates,
  compareVersions,
  normalizeVersion,
} from "./check-updates";

describe("normalizeVersion", () => {
  it("parses desktop and CLI release tags", () => {
    expect(normalizeVersion("0.1.11")).toBe("0.1.11");
    expect(normalizeVersion("v0.1.11")).toBe("0.1.11");
    expect(normalizeVersion("@moonshot-ai/kimi-code@0.29.1")).toBe("0.29.1");
    expect(normalizeVersion("dev")).toBeNull();
    expect(normalizeVersion("—")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders dotted versions", () => {
    expect(compareVersions("0.1.11", "0.1.10")).toBeGreaterThan(0);
    expect(compareVersions("0.29.1", "0.29.1")).toBe(0);
    expect(compareVersions("0.28.0", "0.29.1")).toBeLessThan(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });
});

describe("checkAllUpdates", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("kimi-code-desktop")) {
          return new Response(
            JSON.stringify({
              tag_name: "v0.1.12",
              html_url:
                "https://github.com/P-A-N-52/kimi-code-desktop/releases/tag/v0.1.12",
              prerelease: false,
              draft: false,
            }),
            { status: 200 },
          );
        }
        if (url.includes("MoonshotAI/kimi-code")) {
          return new Response(
            JSON.stringify({
              tag_name: "@moonshot-ai/kimi-code@0.30.0",
              html_url:
                "https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai/kimi-code%400.30.0",
              prerelease: false,
              draft: false,
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports updates for both desktop and CLI", async () => {
    const result = await checkAllUpdates({
      desktopVersion: "0.1.11",
      cliVersion: "0.29.1",
    });
    expect(result.desktop.status).toBe("update-available");
    expect(result.desktop.latest).toBe("0.1.12");
    expect(result.cli.status).toBe("update-available");
    expect(result.cli.latest).toBe("0.30.0");
  });

  it("reports up-to-date when versions match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("kimi-code-desktop")) {
          return new Response(
            JSON.stringify({
              tag_name: "v0.1.11",
              html_url: "https://example.com/desktop",
              prerelease: false,
              draft: false,
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            tag_name: "@moonshot-ai/kimi-code@0.29.1",
            html_url: "https://example.com/cli",
            prerelease: false,
            draft: false,
          }),
          { status: 200 },
        );
      }),
    );

    const result = await checkAllUpdates({
      desktopVersion: "0.1.11",
      cliVersion: "0.29.1",
    });
    expect(result.desktop.status).toBe("up-to-date");
    expect(result.cli.status).toBe("up-to-date");
  });
});
