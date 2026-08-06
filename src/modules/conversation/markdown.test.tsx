import { describe, expect, it } from "vitest";
import { prepareMarkdownContent } from "./markdown";

describe("prepareMarkdownContent", () => {
  it("keeps Mermaid diagrams on compatible WebViews", () => {
    const markdown = "```mermaid\nflowchart TD\n  A --> B\n```";

    expect(prepareMarkdownContent(markdown, true)).toBe(markdown);
  });

  it("downgrades Mermaid fences when the WebView cannot parse Mermaid regexes", () => {
    const markdown = "Before\n\n~~~MERMAID\nflowchart TD\n  A --> B\n~~~\n\nAfter";

    expect(prepareMarkdownContent(markdown, false)).toBe(
      "Before\n\n~~~text\nflowchart TD\n  A --> B\n~~~\n\nAfter",
    );
  });

  it("does not rewrite text inside another fenced code block", () => {
    const markdown = "```text\n```mermaid\nkeep this source\n```\n```";

    expect(prepareMarkdownContent(markdown, false)).toBe(markdown);
  });
});
