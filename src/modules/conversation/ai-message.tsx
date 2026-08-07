import { lazy, Suspense, type ReactNode } from "react";
import type { MessageAttachmentPart } from "@/hooks/types";
import { Attachments } from "./attachments";

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
        <Suspense
          fallback={
            <div className="min-w-0 break-words whitespace-pre-wrap text-[14px] leading-[1.65]">
              {content}
            </div>
          }
        >
          <LazyMarkdown content={content} />
        </Suspense>
      ) : null}
      <Attachments parts={attachments} />
      {children}
    </div>
  );
}
