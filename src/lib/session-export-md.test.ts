import { describe, expect, it } from "vitest";
import type { LiveMessage } from "@/hooks/types";
import {
  defaultSessionExportFilename,
  messagesToSessionMarkdown,
  SESSION_EXPORT_LIMITS,
} from "./session-export-md";

describe("session-export-md", () => {
  it("documents export limits", () => {
    expect(SESSION_EXPORT_LIMITS.length).toBeGreaterThan(0);
  });

  it("exports rendered user and assistant text", () => {
    const markdown = messagesToSessionMarkdown({
      title: "Demo",
      sessionId: "sess-12345678",
      messages: [
        { id: "u1", role: "user", content: "Hello" },
        { id: "a1", role: "assistant", content: "Hi there" },
      ],
      exportedAt: new Date("2026-07-31T04:00:00.000Z"),
    });
    expect(markdown).toContain("# Demo");
    expect(markdown).toContain("sess-12345678");
    expect(markdown).toContain("## User");
    expect(markdown).toContain("Hello");
    expect(markdown).toContain("## Assistant");
    expect(markdown).toContain("Hi there");
    expect(markdown).toContain("Export limits");
  });

  it("includes tool summaries without inventing attachment bytes", () => {
    const markdown = messagesToSessionMarkdown({
      title: "Tools",
      messages: [
        {
          id: "a1",
          role: "assistant",
          variant: "tool",
          toolCall: {
            title: "ReadFile",
            type: "tool-ReadFile",
            state: "output-available",
            output: "file contents",
          },
        },
      ],
    });
    expect(markdown).toContain("### Tool: ReadFile");
    expect(markdown).toContain("file contents");
  });

  it("builds a safe default filename", () => {
    expect(defaultSessionExportFilename("My Chat!", "abcdef123456")).toMatch(
      /^My-Chat-abcdef12\.md$/,
    );
  });

  it("returns empty-session placeholder when nothing is exportable", () => {
    const markdown = messagesToSessionMarkdown({
      title: "Empty",
      messages: [{ id: "a1", role: "assistant", variant: "status", content: "…" } as LiveMessage],
    });
    expect(markdown).toContain("No exportable messages");
  });
});
