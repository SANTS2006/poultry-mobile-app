import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';
import { describeError } from '../../../lib/errors';
import { formatDateTime } from '../../../lib/format';
import { categoryName, CATEGORY_ICON } from '../../../lib/notification-meta';
import { relatedRoute } from '../../../services/push';
import { useEndpoints } from '../../../state/app';
import { Badge, Button, Card, ErrorView, IconTile, Loading, Row, Text } from '../../../ui/components';
import { SheetScreen } from '../../../ui/sheet-screen';
import { space } from '../../../ui/theme';

/** One notification in full. Opening it marks it read, which updates the bell's count everywhere. */
export default function NotificationDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useEndpoints();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notifications', 'detail', id], queryFn: () => api.notifications.get(id) });
  const n = q.data;
  const unread = !!n && !n.readAt;

  useEffect(() => {
    if (!unread) return;
    void api.notifications.read(id).then(() => qc.invalidateQueries({ queryKey: ['notifications'] })).catch(() => undefined);
    void api.notifications.opened(id).catch(() => undefined);
  }, [unread, id, api, qc]);

  if (q.isLoading) return <SheetScreen title="Notification"><Loading /></SheetScreen>;
  if (!n) return <SheetScreen title="Notification"><ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /></SheetScreen>;
  const related = relatedRoute(n);
  return (
    <SheetScreen title="Notification" refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
      <Card style={{ gap: space.lg }}>
        <Row style={{ gap: space.md }}>
          <IconTile name={CATEGORY_ICON[n.category] ?? 'notifications-outline'} />
          <View style={{ flex: 1, gap: space.xs }}>
            <Text variant="caption" muted>{categoryName(n.category)}</Text>
            <Text variant="caption" muted>{formatDateTime(n.createdAt)}</Text>
          </View>
          <Badge tone={n.readAt ? 'muted' : 'info'} label={n.readAt ? 'Read' : 'New'} />
        </Row>
        <Text variant="title" accessibilityRole="header">{n.title}</Text>
        <Text>{n.body}</Text>
      </Card>

      {related ? <Button title={related.label} icon="open-outline" onPress={() => router.push(related.path as never)} /> : null}
      <Button title="Notification settings" icon="options-outline" variant="secondary" onPress={() => router.push('/notifications/preferences')} />
    </SheetScreen>
  );
}
