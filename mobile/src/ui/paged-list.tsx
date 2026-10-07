import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { FlatList, View } from 'react-native';
import type { Page } from '../api/types';
import { describeError } from '../lib/errors';
import { Button, EmptyState, ErrorView, Skeleton } from './components';
import type { IconName } from './icon';
import { StatusBanners } from './status-banners';
import { space, useColors } from './theme';

function SkeletonRows() {
  const c = useColors();
  return (
    <View style={{ backgroundColor: c.card }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <View key={i} accessibilityElementsHidden style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderBottomWidth: 1, borderColor: c.border }}>
          <Skeleton height={40} width={40} radiusPx={12} />
          <View style={{ flex: 1, gap: space.sm }}><Skeleton height={14} width="60%" /><Skeleton height={12} width="85%" /></View>
        </View>
      ))}
    </View>
  );
}

/** Infinite, pull-to-refresh list over the API's `{items, page, limit, total}` pages. Keeps showing loaded rows when offline. */
export function PagedList<T extends { id: string }>({
  queryKey, fetchPage, renderItem, header, emptyTitle, emptyHint, emptyIcon, emptyAction, limit = 25,
}: {
  queryKey: QueryKey;
  fetchPage: (page: number, limit: number) => Promise<Page<T>>;
  renderItem: (item: T) => ReactElement;
  header?: ReactNode;
  emptyTitle: string;
  emptyHint?: string;
  emptyIcon?: IconName;
  /** a next step for an empty list, e.g. "Record production" */
  emptyAction?: { label: string; icon?: IconName; onPress: () => void };
  limit?: number;
}) {
  const c = useColors();
  const q = useInfiniteQuery({
    queryKey, initialPageParam: 1,
    queryFn: ({ pageParam }) => fetchPage(pageParam, limit),
    getNextPageParam: (last) => (last.page * last.limit < last.total ? last.page + 1 : undefined),
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <StatusBanners />
      <FlatList
        data={items} keyExtractor={(i) => i.id} renderItem={({ item }) => renderItem(item)} keyboardShouldPersistTaps="handled"
        refreshing={q.isRefetching && !q.isFetchingNextPage} onRefresh={() => void q.refetch()}
        onEndReached={() => { if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage(); }} onEndReachedThreshold={0.4}
        ListHeaderComponent={<>{header}{q.error && !items.length ? <View style={{ padding: space.lg }}><ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /></View> : null}</>}
        ListEmptyComponent={q.isLoading ? <SkeletonRows /> : q.error ? null : (
          <EmptyState icon={emptyIcon} title={emptyTitle} hint={emptyHint} action={emptyAction ? <Button title={emptyAction.label} icon={emptyAction.icon} onPress={emptyAction.onPress} small /> : undefined} />
        )}
        ListFooterComponent={q.isFetchingNextPage ? <SkeletonRows /> : q.hasNextPage ? <View style={{ padding: space.lg }}><Button title="Load more" variant="secondary" onPress={() => void q.fetchNextPage()} /></View> : null}
        contentContainerStyle={{ paddingBottom: space.xxxl + space.xl }}
      />
    </View>
  );
}
