import { lazy, type ReactNode, Suspense } from "react";
import type { MessageAttachmentPart } from "@/hooks/types";
import { Attachments } from "./attachments";
import { supportsMermaidRuntime } from "./markdown-capabilities";
import { PlainMarkdown } from "./plain-markdown";

const LazyMarkdown = lazy(() =>
  import("./markdown").then(({ Markdown }) => ({ default: Markdown })),
);

export function AiMessage({
  content,
  attachments,
  children,
}: {
  content?: string;
  attachments?: MessageAttachmentPart[];
  children?: ReactNode;
}) {
  return (
    <div className="my-5 min-w-0">
      {content ? (
        supportsMermaidRuntime ? (
          <Suspense
            fallback={
              <div className="min-w-0 break-words whitespace-pre-wrap text-[14px] leading-[1.65]">
                {content}
              </div>
            }
          >
            <LazyMarkdown content={content} />
          </Suspense>
        ) : (
          <PlainMarkdown content={content} />
        )
      ) : null}
      <Attachments parts={attachments} />
      {children}
    </div>
  );
}
