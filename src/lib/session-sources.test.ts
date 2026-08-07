import { describe, expect, it } from "vitest";
import type { LiveMessage } from "@/hooks/types";
import { deriveSessionSources } from "./session-sources";

describe("deriveSessionSources", () => {
  it("keeps first occurrence order, labels origins, and deduplicates media", () => {
    const messages: LiveMessage[] = [
      {
        id: "user-1",
        role: "user",
        turnIndex: 0,
        attachments: [
          { type: "file", filename: "input.png", mediaType: "image/png", url: "blob:first" },
          { type: "file", filename: "input.png", mediaType: "image/png", url: "blob:first" },
        ],
      },
      {
        id: "tool-1",
        role: "assistant",
        turnIndex: 0,
        toolCall: {
          title: "media",
          type: "tool-media",
          state: "output-available",
          mediaParts: [
            { type: "image_url", url: "https://example.com/result.png" },
            { type: "audio_url", url: "https://example.com/result.mp3" },
          ],
        },
      },
    ];

    expect(deriveSessionSources(messages)).toMatchObject([
      { label: "input.png", origin: "user-input", turnIndex: 0 },
      { label: "result.png", origin: "model-output", mediaType: "image/*" },
      { label: "result.mp3", origin: "model-output", mediaType: "audio/*" },
    ]);
  });

  it("rejects unsafe and malformed model media URLs", () => {
    const messages: LiveMessage[] = [
      {
        id: "tool-1",
        role: "assistant",
        toolCall: {
          title: "media",
          type: "tool-media",
          state: "output-available",
          mediaParts: [
            { type: "image_url", url: "javascript:alert(1)" },
            { type: "video_url", url: "not a url" },
          ],
        },
      },
    ];

    expect(deriveSessionSources(messages)).toEqual([]);
  });
});
