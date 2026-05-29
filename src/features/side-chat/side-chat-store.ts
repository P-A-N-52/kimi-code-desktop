import { create } from "zustand";

export interface SideChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

type SideChatStore = {
  isOpen: boolean;
  messages: SideChatMessage[];
  inputText: string;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setInputText: (text: string) => void;
  addMessage: (message: Omit<SideChatMessage, "id" | "timestamp">) => void;
  clearMessages: () => void;
};

export const useSideChatStore = create<SideChatStore>((set) => ({
  isOpen: false,
  messages: [],
  inputText: "",
  setOpen: (open) => set({ isOpen: open }),
  toggleOpen: () => set((s) => ({ isOpen: !s.isOpen })),
  setInputText: (text) => set({ inputText: text }),
  addMessage: (message) =>
    set((s) => ({
      messages: [
        ...s.messages,
        {
          ...message,
          id: crypto.randomUUID(),
          timestamp: Date.now(),
        },
      ],
    })),
  clearMessages: () => set({ messages: [] }),
}));
