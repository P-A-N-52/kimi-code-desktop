import { useCallback } from "react";
import { useSideChatStore } from "./side-chat-store";

export function useSideChat() {
  const store = useSideChatStore();

  const sendMessage = useCallback(
    (content: string) => {
      if (!content.trim()) return;
      store.addMessage({ role: "user", content: content.trim() });
      store.setInputText("");

      // TODO: wire up to real WebSocket/backend
      // For now, echo a placeholder response after a short delay
      window.setTimeout(() => {
        store.addMessage({
          role: "assistant",
          content: "This is a placeholder response from Side Chat.",
        });
      }, 600);
    },
    [store],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage(store.inputText);
      }
    },
    [sendMessage, store.inputText],
  );

  return {
    isOpen: store.isOpen,
    messages: store.messages,
    inputText: store.inputText,
    setOpen: store.setOpen,
    toggleOpen: store.toggleOpen,
    setInputText: store.setInputText,
    sendMessage,
    handleKeyDown,
    clearMessages: store.clearMessages,
  };
}
