/** Pure helpers for composer `@` workspace file mentions (CLI-aligned insert). */

export type FileMentionEntry = {
  name: string;
  type: "directory" | "file";
  size?: number;
};

export type FileMentionOption = {
  id: string;
  label: string;
  insertValue: string;
  isDirectory: boolean;
  size?: number;
};

export type MentionRange = {
  start: number;
  end: number;
  query: string;
};

const STOP_CHARS = /[\s,;:!?,()[\]{}<>"'`]/;
const MENTION_TRIGGER_PREFIX = /[\s([{]/;
const LEADING_DOT_SLASH = /^\.\//;

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".venv",
  "__pycache__",
  "build",
  "dist",
  "node_modules",
  "target",
  "venv",
]);

export function detectMention(text: string, caret: number | null): MentionRange | null {
  const safeCaret = Math.max(0, Math.min(text.length, caret ?? text.length));
  const upToCaret = text.slice(0, safeCaret);
  const asciiTrigger = upToCaret.lastIndexOf("@");
  const fullwidthTrigger = upToCaret.lastIndexOf("＠");
  const triggerIndex = Math.max(asciiTrigger, fullwidthTrigger);
  if (triggerIndex === -1) return null;

  if (triggerIndex > 0) {
    const previousChar = upToCaret[triggerIndex - 1];
    if (previousChar && !MENTION_TRIGGER_PREFIX.test(previousChar)) return null;
  }

  const query = upToCaret.slice(triggerIndex + 1);
  if (STOP_CHARS.test(query)) return null;

  return { start: triggerIndex, end: safeCaret, query };
}

export function normalizeRelPath(value: string): string {
  if (value === "." || value === "./" || value === "") return ".";
  return value.replace(LEADING_DOT_SLASH, "").replace(/\\/g, "/");
}

/** Directory to list for a mention query (`src/foo` → `src`). */
export function mentionListPath(query: string): string | undefined {
  const normalized = query.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return undefined;
  const dir = normalized.slice(0, slash);
  return dir === "" ? undefined : dir;
}

/** Filter segment after the last `/` (or whole query). */
export function mentionFilterSegment(query: string): string {
  const normalized = query.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return (slash < 0 ? normalized : normalized.slice(slash + 1)).toLowerCase();
}

export function shouldIgnoreDirectory(name: string): boolean {
  return IGNORED_DIRECTORY_NAMES.has(name);
}

export function entriesToMentionOptions(
  entries: FileMentionEntry[],
  basePath?: string,
): FileMentionOption[] {
  const base = basePath && basePath !== "." ? normalizeRelPath(basePath) : ".";
  const options: FileMentionOption[] = [];
  for (const entry of entries) {
    if (entry.type === "directory" && shouldIgnoreDirectory(entry.name)) continue;
    const fullPath = base === "." ? entry.name : `${base}/${entry.name}`;
    const isDirectory = entry.type === "directory";
    const insertValue = isDirectory ? `${fullPath}/` : fullPath;
    options.push({
      id: `${entry.type}:${fullPath}`,
      label: isDirectory ? `${entry.name}/` : entry.name,
      insertValue,
      isDirectory,
      size: entry.size,
    });
  }
  return options.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
}

export function filterMentionOptions(
  options: FileMentionOption[],
  query: string,
): FileMentionOption[] {
  const segment = mentionFilterSegment(query);
  if (!segment) return options;
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(segment) ||
      option.insertValue.toLowerCase().includes(segment),
  );
}

/** CLI-style mention token: `@path` or `@"path with spaces"`. */
export function formatMentionToken(insertValue: string): string {
  if (/\s/.test(insertValue)) return `@"${insertValue}"`;
  return `@${insertValue}`;
}

export function applyMentionSelection(args: {
  text: string;
  range: MentionRange;
  option: FileMentionOption;
}): { nextText: string; nextCaret: number; keepOpen: boolean; nextQuery: string } {
  const mentionText = formatMentionToken(args.option.insertValue);
  const before = args.text.slice(0, args.range.start);
  const after = args.text.slice(args.range.end);
  const keepOpen = args.option.isDirectory;
  const needsSpace =
    keepOpen || (after.length > 0 && /^\S/.test(after)) ? "" : " ";
  const nextText = `${before}${mentionText}${needsSpace}${after}`;
  const nextCaret = before.length + mentionText.length + needsSpace.length;
  return {
    nextText,
    nextCaret,
    keepOpen,
    nextQuery: keepOpen ? args.option.insertValue : "",
  };
}
