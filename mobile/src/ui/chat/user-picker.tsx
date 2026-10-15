import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import type { ChatUser } from '../../api/endpoints';
import { describeError } from '../../lib/errors';
import { useEndpoints } from '../../state/app';
import { EmptyState, ErrorView, Loading, SearchBar, Text } from '../components';
import { Icon } from '../icon';
import { radius, space, useColors } from '../theme';
import { ChatAvatar } from './chat-avatar';

/** Searchable list of people you can chat with. `selected` turns it into a multi-select (group creation / adding members). */
export function UserPicker({ onPick, selected, exclude = [], header }: { onPick: (u: ChatUser) => void; selected?: ReadonlySet<string>; exclude?: readonly string[]; header?: React.ReactNode }) {
  const api = useEndpoints();
  const c = useColors();
  const [search, setSearch] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['chat', 'users', search], initialPageParam: 1,
    queryFn: ({ pageParam }) => api.chat.users({ page: pageParam, limit: 30, search: search.trim() || undefined }),
    getNextPageParam: (last) => (last.page * last.limit < last.total ? last.page + 1 : undefined),
  });
  const items = (q.data?.pages.flatMap((p) => p.items) ?? []).filter((u) => !exclude.includes(u.id));
  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: space.lg, paddingBottom: space.sm }}><SearchBar value={search} onChangeText={setSearch} placeholder="Search people" /></View>
      {header}
      {q.isLoading ? <Loading /> : q.error && !items.length ? <ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /> : (
        <FlatList
          data={items} keyExtractor={(u) => u.id} keyboardShouldPersistTaps="handled"
          onEndReached={() => { if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage(); }} onEndReachedThreshold={0.4}
          ListEmptyComponent={<EmptyState icon="people-outline" title={search ? 'No one found' : 'No one to message yet'} hint={search ? 'Try a different name.' : 'People appear here once they have an active account.'} />}
          renderItem={({ item }) => {
            const on = selected?.has(item.id);
            return (
              <Pressable accessibilityRole={selected ? 'checkbox' : 'button'} accessibilityState={selected ? { checked: !!on } : undefined} accessibilityLabel={`${item.name}${item.role ? `, ${item.role}` : ''}`} onPress={() => onPick(item)}
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, minHeight: 64, backgroundColor: pressed ? c.primarySoft : 'transparent' })}>
                <ChatAvatar name={item.name} userId={item.id} hasAvatar={item.hasAvatar} version={item.avatarVersion} online={item.online} size={44} />
                <View style={{ flex: 1 }}><Text variant="bodyStrong" numberOfLines={1}>{item.name}</Text>{item.role ? <Text variant="caption" muted numberOfLines={1}>{item.role}</Text> : null}</View>
                {selected ? <View style={{ width: 26, height: 26, borderRadius: radius.pill, borderWidth: 2, borderColor: on ? c.primary : c.borderStrong, backgroundColor: on ? c.primary : 'transparent', alignItems: 'center', justifyContent: 'center' }}>{on ? <Icon name="checkmark" size={16} color={c.onPrimary} /> : null}</View> : null}
              </Pressable>
            );
          }}
          ListFooterComponent={<View style={{ height: space.xxxl }} />}
        />
      )}
    </View>
  );
}
