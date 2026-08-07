import type { LiveMessage, MessageAttachmentPart } from "@/hooks/types";
import { isSafeBrowserUrl } from "@/lib/safe-url";

export type SessionSource = {
  id: string;
  label: string;
  mediaType: string;
  url?: string;
  origin: "user-input" | "model-output";
  turnIndex?: number;
};

function attachmentSource(
  part: MessageAttachmentPart,
  origin: SessionSource["origin"],
  turnIndex?: number,
): SessionSource {
  if ("type" in part && part.type === "file") {
    const label = part.filename || "attachment";
    const url = part.url && isSafeBrowserUrl(part.url) ? part.url : undefined;
    return {
      id: url || label,
      label,
      mediaType: part.mediaType,
      url,
      origin,
      turnIndex,
    };
  }
  const label = part.filename || "attachment";
  return {
    id: label,
    label,
    mediaType: "mediaType" in part ? part.mediaType : "application/octet-stream",
    origin,
    turnIndex,
  };
}

export function deriveSessionSources(messages: LiveMessage[]): SessionSource[] {
  const result: SessionSource[] = [];
  const seen = new Set<string>();
  const add = (source: SessionSource) => {
    if (seen.has(source.id)) return;
    seen.add(source.id);
    result.push(source);
  };

  for (const message of messages) {
    const origin = message.role === "user" ? "user-input" : "model-output";
    for (const part of message.attachments ?? []) {
      add(attachmentSource(part, origin, message.turnIndex));
    }
    for (const media of message.toolCall?.mediaParts ?? []) {
      if (!isSafeBrowserUrl(media.url)) continue;
      let label =
        media.type === "image_url"
          ? "生成的图片"
          : media.type === "video_url"
            ? "生成的视频"
            : "生成的音频";
      try {
        label = new URL(media.url).pathname.split("/").pop() || label;
      } catch {
        // Keep the semantic fallback label for data/blob URLs or malformed input.
      }
      add({
        id: media.url,
        label,
        mediaType:
          media.type === "image_url"
            ? "image/*"
            : media.type === "video_url"
              ? "video/*"
              : "audio/*",
        url: media.url,
        origin: "model-output",
        turnIndex: message.turnIndex,
      });
    }
  }
  return result;
}
