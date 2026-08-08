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
  id: string,
  origin: SessionSource["origin"],
  turnIndex?: number,
): SessionSource {
  if ("type" in part && part.type === "file") {
    const label = part.filename || "attachment";
    const url = part.url && isSafeBrowserUrl(part.url) ? part.url : undefined;
    return {
      id,
      label,
      mediaType: part.mediaType,
      url,
      origin,
      turnIndex,
    };
  }
  const label = part.filename || "attachment";
  return {
    id,
    label,
    mediaType: "mediaType" in part ? part.mediaType : "application/octet-stream",
    origin,
    turnIndex,
  };
}

export function deriveSessionSources(messages: LiveMessage[]): SessionSource[] {
  const result: SessionSource[] = [];

  for (const message of messages) {
    const origin = message.role === "user" ? "user-input" : "model-output";
    for (const [index, part] of (message.attachments ?? []).entries()) {
      result.push(
        attachmentSource(
          part,
          `${message.id}:attachment:${index}`,
          origin,
          message.turnIndex,
        ),
      );
    }
    for (const [index, media] of (message.toolCall?.mediaParts ?? []).entries()) {
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
      result.push({
        id: `${message.id}:tool-media:${index}`,
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
