import type { ReactNode } from "react";
import type { MessageAttachmentPart } from "@/hooks/types";
import { Attachments } from "./attachments";
import { Markdown } from "./markdown";

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
    <div className="my-5 flex gap-3">
      <div
        data-slot="assistant-avatar"
        className="mt-[3px] flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-bright font-mono text-[10px] font-semibold text-background"
      >
        K
      </div>
      <div className="min-w-0 flex-1">
        {content ? <Markdown content={content} /> : null}
        <Attachments parts={attachments} />
        {children}
      </div>
    </div>
  );
}
