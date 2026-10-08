import { create } from 'zustand';

/** The newest notification that arrived while the app was open. The toaster shows it once and the bell count updates through the query cache. */
interface LiveNotice {
  latest: { id: string; title: string } | null;
  announce(n: { id: string; title: string }): void;
}

export const useLiveNotice = create<LiveNotice>((set, get) => ({
  latest: null,
  announce: (n) => { if (get().latest?.id !== n.id) set({ latest: n }); },
}));
