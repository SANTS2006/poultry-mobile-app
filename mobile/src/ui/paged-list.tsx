import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { FlatList } from 'react-native';
import type { Page } from '../api/types';
import { describeError } from '../lib/errors';
import { Button, EmptyState, ErrorView, Loading } from './components';
import { StatusBanners } from './status-banners';
import { useColors } from './theme';

/** Infinite, pull-to-refresh list over the API's `{items, page, limit, total}` pages. Keeps showing loaded rows when offline. */
export function PagedList<T extends { id: string }>({
  queryKey, fetchPage, renderItem, header, emptyTitle, emptyHint, limit = 25,
}: {
  queryKey: QueryKey;
  fetchPage: (page: number, limit: number) => Promise<Page<T>>;
  renderItem: (item: T) => ReactElement;
  header?: ReactNode;
  emptyTitle: string;
  emptyHint?: string;
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
    <>
      <StatusBanners />
      <FlatList
        style={{ backgroundColor: c.bg }} data={items} keyExtractor={(i) => i.id} renderItem={({ item }) => renderItem(item)}
        refreshing={q.isRefetching && !q.isFetchingNextPage} onRefresh={() => void q.refetch()}
        onEndReached={() => { if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage(); }} onEndReachedThreshold={0.4}
        ListHeaderComponent={<>{header}{q.error && !items.length ? <ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /> : null}</>}
        ListEmptyComponent={q.isLoading ? <Loading /> : q.error ? null : <EmptyState title={emptyTitle} hint={emptyHint} />}
        ListFooterComponent={q.isFetchingNextPage ? <Loading /> : q.hasNextPage ? <Button title="Load more" variant="ghost" onPress={() => void q.fetchNextPage()} /> : null}
        contentContainerStyle={{ paddingBottom: 48 }}
      />
    </>
  );
}
