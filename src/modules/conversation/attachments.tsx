import { File, Film, Music } from "lucide-react";
import type { MessageAttachmentPart } from "@/hooks/types";
import { isSafeBrowserUrl } from "@/lib/safe-url";

function isFilePart(
  part: MessageAttachmentPart,
): part is Extract<MessageAttachmentPart, { type: "file" }> {
  return "type" in part && part.type === "file";
}

function attachmentName(part: MessageAttachmentPart): string {
  return "filename" in part && part.filename ? part.filename : "attachment";
}

function attachmentKey(part: MessageAttachmentPart): string {
  if (isFilePart(part) && part.url) return `${part.mediaType}:${part.url}`;
  return `${"kind" in part ? part.kind : "file"}:${attachmentName(part)}`;
}

function FileChip({ part }: { part: MessageAttachmentPart }) {
  const name = attachmentName(part);
  const Icon =
    "kind" in part && part.kind === "video-nopreview"
      ? Film
      : isFilePart(part) && part.mediaType.startsWith("audio/")
        ? Music
        : File;
  const content = (
    <>
      <Icon size={13} strokeWidth={1.5} className="shrink-0" />
      <span className="min-w-0 truncate">{name}</span>
    </>
  );

  if (isFilePart(part) && part.url && isSafeBrowserUrl(part.url)) {
    return (
      <a
        href={part.url}
        target="_blank"
        rel="noreferrer"
        className="flex max-w-full items-center gap-2 rounded-r1 border border-line bg-elevated px-2.5 py-1.5 font-mono text-[11px] text-muted transition-colors hover:border-line-strong hover:text-foreground"
      >
        {content}
      </a>
    );
  }

  return (
    <div className="flex max-w-full items-center gap-2 rounded-r1 border border-line bg-elevated px-2.5 py-1.5 font-mono text-[11px] text-muted">
      {content}
    </div>
  );
}

export function Attachments({ parts }: { parts?: MessageAttachmentPart[] }) {
  if (!parts?.length) return null;

  return (
    <div data-slot="message-attachments" className="mt-2 flex flex-wrap gap-2">
      {parts.map((part) => {
        const name = attachmentName(part);
        const key = attachmentKey(part);
        if (
          isFilePart(part) &&
          part.mediaType.startsWith("image/") &&
          part.url &&
          isSafeBrowserUrl(part.url)
        ) {
          return (
            <a
              key={key}
              href={part.url}
              target="_blank"
              rel="noreferrer"
              className="block max-w-full overflow-hidden rounded-r2 border border-line bg-elevated"
            >
              <img
                src={part.url}
                alt={name}
                loading="lazy"
                className="max-h-80 max-w-full object-contain"
              />
            </a>
          );
        }
        if (
          isFilePart(part) &&
          part.mediaType.startsWith("video/") &&
          part.url &&
          isSafeBrowserUrl(part.url)
        ) {
          return (
            // biome-ignore lint/a11y/useMediaCaption: Generated tool media does not include a caption track.
            <video
              key={key}
              controls
              preload="metadata"
              aria-label={name}
              className="max-h-80 max-w-full rounded-r2 border border-line bg-black"
            >
              <source src={part.url} type={part.mediaType} />
            </video>
          );
        }
        if (
          isFilePart(part) &&
          part.mediaType.startsWith("audio/") &&
          part.url &&
          isSafeBrowserUrl(part.url)
        ) {
          return (
            // biome-ignore lint/a11y/useMediaCaption: Generated tool media does not include a caption track.
            <audio
              key={key}
              controls
              preload="metadata"
              aria-label={name}
              className="h-9 max-w-full"
            >
              <source src={part.url} type={part.mediaType} />
            </audio>
          );
        }
        return <FileChip key={key} part={part} />;
      })}
    </div>
  );
}
