import type { StreamdownProps } from "streamdown";
import { defaultRehypePlugins, defaultRemarkPlugins, Streamdown } from "streamdown";
import { cn } from "@/lib/utils";
import { supportsMermaidRuntime } from "./markdown-capabilities";

const mathPlugin = defaultRemarkPlugins.math;
const remarkMathWithInline = (
  Array.isArray(mathPlugin)
    ? [mathPlugin[0], { ...mathPlugin[1], singleDollarTextMath: true }]
    : [mathPlugin, { singleDollarTextMath: true }]
) as typeof mathPlugin;

const remarkPlugins: StreamdownProps["remarkPlugins"] = [
  defaultRemarkPlugins.gfm,
  remarkMathWithInline,
  defaultRemarkPlugins.cjkFriendly,
];

const rehypePlugins: StreamdownProps["rehypePlugins"] = [defaultRehypePlugins.katex];

type FenceState = {
  character: "`" | "~";
  length: number;
  mermaid: boolean;
};

type FenceOpening = FenceState & {
  languageStart: number;
};

const readFenceOpening = (line: string): FenceOpening | null => {
  let index = 0;
  while (line[index] === " " || line[index] === "\t") {
    index += 1;
  }
  const character = line[index];
  if (character !== "`" && character !== "~") {
    return null;
  }
  const markerStart = index;
  while (line[index] === character) {
    index += 1;
  }
  const length = index - markerStart;
  if (length < 3) {
    return null;
  }
  let languageStart = index;
  while (line[languageStart] === " " || line[languageStart] === "\t") {
    languageStart += 1;
  }
  const language = line.slice(languageStart).split(/\s+/, 1)[0]?.toLowerCase();
  return {
    character,
    length,
    languageStart,
    mermaid: language === "mermaid",
  };
};

const isFenceClosing = (line: string, fence: FenceState): boolean => {
  const trimmed = line.trim();
  if (trimmed.length < fence.length || !trimmed.startsWith(fence.character)) {
    return false;
  }
  for (const character of trimmed) {
    if (character !== fence.character) {
      return false;
    }
  }
  return true;
};

/** Keep Mermaid source visible when the host WebView cannot parse Mermaid's regexes. */
export function prepareMarkdownContent(
  content: string,
  supportsMermaid = supportsMermaidRuntime,
): string {
  if (supportsMermaid) {
    return content;
  }

  let activeFence: FenceState | null = null;
  return content
    .split("\n")
    .map((line) => {
      const lineEnding = line.endsWith("\r") ? "\r" : "";
      const body = lineEnding ? line.slice(0, -1) : line;

      if (activeFence) {
        if (isFenceClosing(body, activeFence)) {
          activeFence = null;
        }
        return line;
      }

      const opening = readFenceOpening(body);
      if (!opening) {
        return line;
      }
      activeFence = opening;
      if (!opening.mermaid) {
        return line;
      }
      return `${body.slice(0, opening.languageStart)}text${body.slice(opening.languageStart + "mermaid".length)}${lineEnding}`;
    })
    .join("\n");
}

export function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div
      className={cn(
        "min-w-0 break-words text-[14px] leading-[1.65] [&_code]:rounded [&_code]:border [&_code]:border-line [&_code]:bg-secondary [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[12px] [&_p]:mb-2.5 [&_pre]:mb-3 [&_pre]:overflow-x-auto [&_pre]:rounded-r2 [&_pre]:border [&_pre]:border-line [&_pre]:bg-elevated [&_pre]:p-3 [&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
        className,
      )}
    >
      <Streamdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
        {prepareMarkdownContent(content)}
      </Streamdown>
    </div>
  );
}
