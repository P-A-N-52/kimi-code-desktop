import type { LiveMessage } from "@/hooks/types";

function isCopyableAssistantTextMessage(message: LiveMessage): boolean {
  if (message.role !== "assistant") return false;
  switch (message.variant) {
    case "message-id":
    case "status":
    case "tool":
    case "thinking":
    case "code":
    case "chain-of-thought":
      return false;
    default:
      return Boolean(message.content?.trim());
  }
}

/** Last rendered assistant text message (matches AiMessage content, not tools/thinking). */
export function findLastAiMessageText(messages: readonly LiveMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isCopyableAssistantTextMessage(message)) {
      return message.content?.trim() ?? null;
    }
  }
  return null;
}
