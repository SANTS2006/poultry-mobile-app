import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import type { AppNotification } from '../../../api/types';
import { formatDateTime } from '../../../lib/format';
import { routeForNotification } from '../../../services/push';
import { useEndpoints } from '../../../state/app';
import { Badge, Button, ListRow, Row } from '../../../ui/components';
import { PagedList } from '../../../ui/paged-list';
import { space } from '../../../ui/theme';

export default function Notifications() {
  const api = useEndpoints();
  const router = useRouter();
  const qc = useQueryClient();
  return (
    <PagedList<AppNotification>
      queryKey={['notifications', 'list']}
      fetchPage={(page, limit) => api.notifications.list({ page, limit })}
      emptyTitle="No notifications" emptyHint="Alerts about sales, stock, sync and security appear here."
      header={(
        <View style={{ padding: space.lg }}>
          <Row style={{ flexWrap: 'wrap' }}>
            <Button title="Mark all read" variant="secondary" small onPress={() => void api.notifications.readAll().then(() => qc.invalidateQueries({ queryKey: ['notifications'] }))} />
            <Button title="Settings" variant="ghost" small onPress={() => router.push('/notifications/preferences')} />
          </Row>
        </View>
      )}
      renderItem={(n) => (
        <ListRow
          title={n.title} subtitle={`${n.body}\n${formatDateTime(n.createdAt)}`}
          badge={n.readAt ? undefined : <Badge tone="info" label="New" />}
          onPress={() => {
            if (!n.readAt) void api.notifications.read(n.id).then(() => qc.invalidateQueries({ queryKey: ['notifications'] })).catch(() => undefined);
            router.push(routeForNotification({ entityType: n.entityType, entityId: n.entityId }) as never);
          }}
        />
      )}
    />
  );
}
