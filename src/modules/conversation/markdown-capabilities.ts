type RegExpFactory = (source: string, flags?: string) => RegExp;

const createRegExp: RegExpFactory = (source, flags) => new RegExp(source, flags);

/**
 * Mermaid 11 uses Unicode-aware lookbehind and named capture groups. Keep
 * this probe in a module that does not import streamdown, because importing
 * the renderer can load Mermaid before the markdown content is inspected.
 */
export function canCompileMermaidRegexes(regExpFactory: RegExpFactory = createRegExp): boolean {
  try {
    regExpFactory("(?<=^|\\s|\\p{P}|\\p{S})", "gu");
    regExpFactory("(?<named>.)");
    return true;
  } catch {
    return false;
  }
}

export const supportsMermaidRuntime = canCompileMermaidRegexes();
