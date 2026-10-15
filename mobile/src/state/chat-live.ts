import { create } from 'zustand';

interface TypingEntry { name: string; until: number }
interface ChatLive {
  /** conversation → who is typing now */
  typing: Record<string, Record<string, TypingEntry>>;
  /** user → online (from presence events and member lists) */
  online: Record<string, boolean>;
  /** the conversation screen that is open and in front (so new messages there are marked read at once) */
  openConversationId: string | null;
  setTyping(conversationId: string, userId: string, name: string, now?: number): void;
  clearTyping(conversationId: string, userId?: string): void;
  setOnline(userId: string, online: boolean): void;
  setOpen(id: string | null): void;
  reset(): void;
}

export const TYPING_MS = 5000;

export const useChatLive = create<ChatLive>((set) => ({
  typing: {}, online: {}, openConversationId: null,
  setTyping: (c, u, name, now = Date.now()) => set((s) => ({ typing: { ...s.typing, [c]: { ...s.typing[c], [u]: { name, until: now + TYPING_MS } } } })),
  clearTyping: (c, u) => set((s) => {
    if (!s.typing[c]) return s;
    if (!u) { const { [c]: _gone, ...rest } = s.typing; return { typing: rest }; }
    const { [u]: _x, ...left } = s.typing[c];
    return { typing: { ...s.typing, [c]: left } };
  }),
  setOnline: (u, online) => set((s) => ({ online: { ...s.online, [u]: online } })),
  setOpen: (id) => set({ openConversationId: id }),
  reset: () => set({ typing: {}, online: {}, openConversationId: null }),
}));

/** Names of people currently typing in a conversation (expired entries ignored). */
export const typingNames = (typing: ChatLive['typing'], conversationId: string, now = Date.now()): string[] =>
  Object.values(typing[conversationId] ?? {}).filter((t) => t.until > now).map((t) => t.name);
