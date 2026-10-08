import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { describeError } from '../../../lib/errors';
import { formatInt } from '../../../lib/format';
import { useEndpoints } from '../../../state/app';
import { Badge, Button, Card, EmptyState, ErrorView, ListRow, Loading, Row, Screen, SectionHeader, StatTile } from '../../../ui/components';
import { space } from '../../../ui/theme';

/** Houses on the farm. Owners and super admins add a coop when the flock grows; retired coops stay in the history but leave the daily checklist. */
export default function Coops() {
  const api = useEndpoints();
  const router = useRouter();
  const q = useQuery({ queryKey: ['admin', 'coops'], queryFn: () => api.coops() });
  const coops = q.data ?? [];
  const active = coops.filter((c) => c.active !== false);
  const capacity = active.reduce((a, c) => a + (c.capacity ?? 0), 0);

  if (q.isLoading) return <Screen><Loading /></Screen>;
  if (q.error && !q.data) return <Screen><ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /></Screen>;
  return (
    <Screen refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
      <Row style={{ gap: space.md, alignItems: 'stretch' }}>
        <StatTile icon="home-outline" label="Active coops" value={String(active.length)} hint={coops.length > active.length ? `${coops.length - active.length} retired` : undefined} />
        <StatTile icon="egg-outline" label="Bird capacity" value={capacity ? formatInt(capacity) : '—'} hint="Where capacities are set" />
      </Row>
      <Button title="Add a coop" icon="add-circle-outline" onPress={() => router.push('/admin/coop' as never)} />
      <View style={{ gap: space.md }}>
        <SectionHeader title="All coops" />
        {coops.length === 0 ? <EmptyState icon="home-outline" title="No coops yet" hint="Add your first coop to start recording production." /> : (
          <Card style={{ padding: 0, gap: 0, overflow: 'hidden' }}>
            {coops.map((c) => (
              <ListRow
                key={c.id} icon="home-outline" title={c.name} subtitle={[c.capacity ? `${formatInt(c.capacity)} birds capacity` : 'Capacity not set', c.notes].filter(Boolean).join(' · ')}
                badge={<Badge tone={c.active === false ? 'muted' : 'ok'} label={c.active === false ? 'retired' : 'active'} />}
                onPress={() => router.push({ pathname: '/admin/coop', params: { id: c.id } } as never)}
              />
            ))}
          </Card>
        )}
      </View>
    </Screen>
  );
}
