import { describe, expect, it } from "vitest";
import {
  applyMentionSelection,
  detectMention,
  entriesToMentionOptions,
  filterMentionOptions,
  formatMentionToken,
  mentionFilterSegment,
  mentionListPath,
} from "./file-mentions";

describe("detectMention", () => {
  it("opens after start, whitespace, or brackets", () => {
    expect(detectMention("@src", 4)?.query).toBe("src");
    expect(detectMention("see @foo", 8)?.query).toBe("foo");
    expect(detectMention("(@bar", 5)?.query).toBe("bar");
    expect(detectMention("a@b", 3)).toBeNull();
  });

  it("stops when query hits whitespace", () => {
    expect(detectMention("@foo bar", 4)?.query).toBe("foo");
    expect(detectMention("@foo bar", 8)).toBeNull();
  });
});

describe("path helpers", () => {
  it("splits list path and filter segment", () => {
    expect(mentionListPath("src/comp")).toBe("src");
    expect(mentionListPath("src/")).toBe("src");
    expect(mentionListPath("foo")).toBeUndefined();
    expect(mentionFilterSegment("src/Comp")).toBe("comp");
  });
});

describe("options and insert", () => {
  it("maps entries and filters ignored dirs", () => {
    const options = entriesToMentionOptions(
      [
        { name: "node_modules", type: "directory" },
        { name: "src", type: "directory" },
        { name: "readme.md", type: "file", size: 12 },
      ],
      undefined,
    );
    expect(options.map((o) => o.insertValue)).toEqual(["src/", "readme.md"]);
  });

  it("formats CLI mention tokens", () => {
    expect(formatMentionToken("src/a.ts")).toBe("@src/a.ts");
    expect(formatMentionToken("my file.ts")).toBe('@"my file.ts"');
  });

  it("keeps menu open for directories", () => {
    const applied = applyMentionSelection({
      text: "@",
      range: { start: 0, end: 1, query: "" },
      option: {
        id: "d",
        label: "src/",
        insertValue: "src/",
        isDirectory: true,
      },
    });
    expect(applied.nextText).toBe("@src/");
    expect(applied.keepOpen).toBe(true);
    expect(applied.nextQuery).toBe("src/");
  });

  it("filters by segment", () => {
    const options = entriesToMentionOptions(
      [
        { name: "alpha.ts", type: "file" },
        { name: "beta.ts", type: "file" },
      ],
      "src",
    );
    expect(filterMentionOptions(options, "src/al").map((o) => o.label)).toEqual([
      "alpha.ts",
    ]);
  });
});
