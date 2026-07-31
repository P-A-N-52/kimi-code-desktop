import { describe, expect, it } from "vitest";
import type { LiveMessage } from "@/hooks/types";
import { findLastAiMessageText } from "./copy-last-ai-message";

function assistant(overrides: Partial<LiveMessage> = {}): LiveMessage {
  return {
    id: overrides.id ?? "a1",
    role: "assistant",
    content: "hello",
    ...overrides,
  };
}

describe("findLastAiMessageText", () => {
  it("returns the last assistant text message", () => {
    const messages: LiveMessage[] = [
      { id: "u1", role: "user", content: "question" },
      assistant({ id: "a1", content: "first reply" }),
      assistant({
        id: "a2",
        variant: "tool",
        toolCall: { title: "Read", type: "tool-Read", state: "output-available" },
      }),
      assistant({ id: "a3", content: "final reply" }),
    ];
    expect(findLastAiMessageText(messages)).toBe("final reply");
  });

  it("skips thinking, tool, and status assistant rows", () => {
    const messages: LiveMessage[] = [
      assistant({ id: "a1", variant: "thinking", thinking: "hmm" }),
      assistant({ id: "a2", variant: "status", content: "Working…" }),
      assistant({ id: "a3", content: "done" }),
    ];
    expect(findLastAiMessageText(messages)).toBe("done");
  });

  it("returns null when no copyable assistant text exists", () => {
    expect(findLastAiMessageText([])).toBeNull();
    expect(
      findLastAiMessageText([
        { id: "u1", role: "user", content: "hi" },
        assistant({
          id: "a1",
          variant: "tool",
          toolCall: { title: "Shell", type: "tool-Shell", state: "output-available" },
        }),
      ]),
    ).toBeNull();
  });
});
