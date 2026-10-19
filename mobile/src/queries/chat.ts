import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { API_URL } from '../config';
import { chatKeys } from '../services/chat-events';
import { useApp, useEndpoints } from '../state/app';
import { useAppStore, useCan } from '../state/store';
import type { ChatMessage } from '../lib/chat/types';

/** Total unread messages (muted chats excluded) for the badge on the header's Messages button. */
export function useChatUnread(): number {
  const api = useEndpoints();
  const allowed = useCan('chat.use');
  const online = useAppStore((s) => (s.sync ? s.sync.online : true));
  const q = useQuery({
    queryKey: chatKeys.unread, enabled: allowed && online, refetchInterval: 120_000,
    queryFn: async () => (await api.chat.conversations({ page: 1, limit: 100 })).items.reduce((n, c) => n + (c.muted ? 0 : c.unread), 0),
  });
  return q.data ?? 0;
}

/** Messages of one conversation, newest page first in the cache; `messages` is oldest → newest for display. */
export function useMessages(conversationId: string) {
  const api = useEndpoints();
  const q = useInfiniteQuery({
    queryKey: chatKeys.messages(conversationId), initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api.chat.messages(conversationId, { before: pageParam, limit: 30 }),
    getNextPageParam: (last) => (last.hasMore ? last.nextBefore ?? undefined : undefined),
  });
  const messages: ChatMessage[] = q.data ? [...q.data.pages].reverse().flatMap((p) => p.items) : [];
  return { ...q, messages };
}

/** Header for authenticated image requests (profile pictures are served only to signed-in chat users). */
export function useBearer(): Record<string, string> | undefined {
  const { services } = useApp();
  const [h, setH] = useState<Record<string, string> | undefined>();
  useEffect(() => {
    let live = true;
    const load = () => services.tokens.getAccessToken().then((t) => { if (live) setH((old) => (old?.Authorization === `Bearer ${t}` ? old : { Authorization: `Bearer ${t}` })); }).catch(() => undefined);
    void load();
    const t = setInterval(load, 8 * 60_000);
    return () => { live = false; clearInterval(t); };
  }, [services]);
  return h;
}

export const avatarUrl = (kind: 'user' | 'group', id: string, version: number): string => `${API_URL}/v1/chat/${kind === 'user' ? 'users' : 'conversations'}/${id}/avatar?v=${version}`;
