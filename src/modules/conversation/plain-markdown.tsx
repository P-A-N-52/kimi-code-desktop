import { cn } from "@/lib/utils";

/** Keep history readable without importing streamdown or Mermaid on legacy WebViews. */
export function PlainMarkdown({ content, className }: { content: string; className?: string }) {
  return (
    <div
      className={cn(
        "min-w-0 break-words whitespace-pre-wrap text-[14px] leading-[1.65]",
        className,
      )}
    >
      {content}
    </div>
  );
}
