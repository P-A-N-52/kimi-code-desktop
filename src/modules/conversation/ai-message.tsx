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
    <div className="my-5 min-w-0">
      {content ? <Markdown content={content} /> : null}
      <Attachments parts={attachments} />
      {children}
    </div>
  );
}
