import { describe, expect, it } from "vitest";
import { canCompileMermaidRegexes } from "./markdown-capabilities";

describe("canCompileMermaidRegexes", () => {
  it("probes Mermaid's Unicode-aware lookbehind and named groups", () => {
    const probes: Array<[string, string | undefined]> = [];
    const compile = (source: string, flags?: string) => {
      probes.push([source, flags]);
      return new RegExp(source, flags);
    };

    expect(canCompileMermaidRegexes(compile)).toBe(true);
    expect(probes).toEqual([
      ["(?<=^|\\s|\\p{P}|\\p{S})", "gu"],
      ["(?<named>.)", undefined],
    ]);
  });

  it("rejects a WebView that cannot compile Mermaid's full lookbehind", () => {
    const legacyWebKitRegExp = (source: string, flags?: string) => {
      if (source.includes("\\p{P}")) {
        throw new SyntaxError("Invalid regular expression");
      }
      return new RegExp(source, flags);
    };

    expect(canCompileMermaidRegexes(legacyWebKitRegExp)).toBe(false);
  });
});
