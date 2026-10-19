import { Stack, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import type { Page } from '../../../api/types';
import { formatInt } from '../../../lib/format';
import { listTime, typingText } from '../../../lib/chat/messages';
import type { ConversationSummary } from '../../../lib/chat/types';
import { useEndpoints } from '../../../state/app';
import { useTypingNames } from '../../../state/chat-live';
import { useCan } from '../../../state/store';
import { SearchBar, Text } from '../../../ui/components';
import { ChatAvatar } from '../../../ui/chat/chat-avatar';
import { Icon } from '../../../ui/icon';
import { PagedList } from '../../../ui/paged-list';
import { radius, space, useColors } from '../../../ui/theme';
import { chatKeys } from '../../../services/chat-events';

function Row({ c: conv }: { c: ConversationSummary }) {
  const router = useRouter();
  const c = useColors();
  const typing = useTypingNames(conv.id);
  const mine = conv.lastMessage?.senderName;
  const preview = typing.length ? typingText(typing) : conv.lastMessage ? `${conv.type === 'GROUP' && mine && conv.lastMessage.kind !== 'SYSTEM' ? `${mine}: ` : ''}${conv.lastMessage.preview}` : 'No messages yet';
  const unread = conv.unread > 0;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${conv.title}. ${unread ? `${conv.unread} unread. ` : ''}${preview}`} onPress={() => router.push({ pathname: '/messages/[id]', params: { id: conv.id } } as never)}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md, minHeight: 72, backgroundColor: pressed ? c.primarySoft : 'transparent', borderBottomWidth: 1, borderColor: c.border })}>
      <ChatAvatar name={conv.title ?? '?'} userId={conv.type === 'DIRECT' ? conv.peerId : null} groupId={conv.type === 'GROUP' ? conv.id : undefined} hasAvatar={conv.hasAvatar} version={conv.avatarVersion} online={conv.peerOnline} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Text variant="bodyStrong" numberOfLines={1} style={{ flex: 1 }}>{conv.title}</Text>
          <Text variant="caption" color={unread ? c.primary : c.muted}>{listTime(conv.lastMessageAt)}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Text variant="caption" color={typing.length ? c.primary : unread ? c.text : c.textSecondary} numberOfLines={1} style={{ flex: 1, fontWeight: unread ? '700' : '400' }}>{preview}</Text>
          {conv.muted ? <Icon name="notifications-off-outline" size={14} color={c.muted} /> : null}
          {unread ? <View style={{ minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: radius.pill, backgroundColor: conv.muted ? c.muted : c.primary, alignItems: 'center', justifyContent: 'center' }}><Text variant="caption" bold color={c.onPrimary} style={{ fontSize: 11, lineHeight: 14 }}>{conv.unread > 99 ? '99+' : formatInt(conv.unread)}</Text></View> : null}
        </View>
      </View>
    </Pressable>
  );
}

/** The inbox: newest conversation first, unread counts, live typing and previews. Updates as messages arrive. */
export default function Messages() {
  const api = useEndpoints();
  const router = useRouter();
  const c = useColors();
  const [search, setSearch] = useState('');
  const term = search.trim();
  const canGroups = useCan('chat.groups.create');
  // memoized: fresh header functions on every render make the navigator re-render this screen in a loop
  const headerOptions = useMemo(() => ({
        title: 'Messages',
        headerRight: () => (
          <View style={{ flexDirection: 'row', gap: space.xs }}>
            <Pressable accessibilityRole="button" accessibilityLabel="Call history" hitSlop={8} onPress={() => router.push('/calls' as never)} style={{ padding: space.sm }}><Icon name="call-outline" size="md" color={c.text} /></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Message settings" hitSlop={8} onPress={() => router.push('/messages/settings' as never)} style={{ padding: space.sm }}><Icon name="settings-outline" size="md" color={c.text} /></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="New message" hitSlop={8} onPress={() => router.push('/messages/new' as never)} style={{ padding: space.sm }}><Icon name="create-outline" size="md" color={c.text} /></Pressable>
          </View>
        ),
      }), [router, c]);
  return (
    <>
      <Stack.Screen options={headerOptions} />
      <PagedList<ConversationSummary & { id: string }>
        queryKey={term ? [...chatKeys.conversations, 'search', term] : chatKeys.conversations}
        fetchPage={(page, limit): Promise<Page<ConversationSummary>> => api.chat.conversations({ page, limit, search: term || undefined })}
        renderItem={(item) => <Row c={item} />}
        header={<View style={{ padding: space.lg, paddingBottom: space.sm }}><SearchBar value={search} onChangeText={setSearch} placeholder="Search conversations" /></View>}
        emptyIcon="chatbubbles-outline" emptyTitle={term ? 'No conversations found' : 'No conversations yet'}
        emptyHint={term ? 'Try a different name.' : canGroups ? 'Start a chat with a colleague or create a group for your team.' : 'Start a chat with a colleague.'}
        emptyAction={term ? undefined : { label: 'New message', icon: 'create-outline', onPress: () => router.push('/messages/new' as never) }}
        limit={25}
      />
    </>
  );
}
