import { useRouter } from 'expo-router';
import { formatDate, formatInt } from '../../../lib/format';
import { useEndpoints } from '../../../state/app';
import { useCan } from '../../../state/store';
import type { ProductionRecord } from '../../../api/types';
import { Badge, Button, ListRow } from '../../../ui/components';
import { PagedList } from '../../../ui/paged-list';
import { View } from 'react-native';
import { space } from '../../../ui/theme';

export default function ProductionTab() {
  const router = useRouter();
  const api = useEndpoints();
  const canCreate = useCan('production.create');
  return (
    <PagedList<ProductionRecord>
      queryKey={['production', 'list']}
      fetchPage={(page, limit) => api.production.list({ page, limit })}
      emptyIcon="egg-outline" emptyTitle="No production recorded yet" emptyHint="Record each collection by coop and shift. Totals and stock update automatically."
      emptyAction={canCreate ? { label: 'Record production', icon: 'add', onPress: () => router.push('/production/new') } : undefined}
      header={canCreate ? <View style={{ padding: space.lg }}><Button title="Record production" icon="add" onPress={() => router.push('/production/new')} /></View> : undefined}
      renderItem={(r) => (
        <ListRow
          icon="egg-outline" title={`${formatInt(r.totalEggs)} eggs · ${r.coop.name}`} subtitle={`${formatDate(r.productionDate)} · ${r.shift.toLowerCase()}`}
          onPress={() => router.push(`/production/${r.id}`)}
          badge={r.needsReview ? <Badge tone="warn" label="Needs review" /> : undefined}
                  />
      )}
    />
  );
}
