import type { ReactNode } from "react";
import type { MessageAttachmentPart } from "@/hooks/types";
import { Attachments } from "./attachments";

export function UserMessage({
  children,
  attachments,
  label,
}: {
  children: ReactNode;
  attachments?: MessageAttachmentPart[];
  label?: string;
}) {
  return (
    <div className="group my-5 flex min-w-0 justify-end">
      <div className="relative max-w-[min(82%,100%)] min-w-0 break-words whitespace-pre-wrap rounded-r3 border border-line bg-secondary px-3.5 py-2.5 text-[14px]">
        {label ? (
          <div className="mb-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.1em] text-faint">
            {label}
          </div>
        ) : null}
        {children}
        <Attachments parts={attachments} />
      </div>
    </div>
  );
}
