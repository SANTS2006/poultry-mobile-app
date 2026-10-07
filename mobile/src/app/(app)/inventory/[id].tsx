import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { describeError } from '../../../lib/errors';
import { eggBreakdown, formatDateTime, formatInt } from '../../../lib/format';
import { useEndpoints } from '../../../state/app';
import { useCan } from '../../../state/store';
import { Badge, Button, Card, ErrorView, IconTile, Loading, Row, Screen, SectionHeader, Text } from '../../../ui/components';
import { space, useColors } from '../../../ui/theme';

const LABEL: Record<string, string> = {
  OPENING: 'Opening stock', PRODUCTION: 'Production', SALE: 'Sale', USAGE: 'Own use', DAMAGE: 'Damaged', LOSS: 'Lost', ADJUSTMENT: 'Adjustment', TRANSFER: 'Transfer', CORRECTION: 'Correction',
};
const WHAT: Record<string, string> = {
  OPENING: 'The stock the farm started with.', PRODUCTION: 'Eggs added from a recorded collection.', SALE: 'Eggs taken out for a sale.', USAGE: 'Eggs taken for the farm’s own use.',
  DAMAGE: 'Eggs removed because they were damaged.', LOSS: 'Eggs removed because they were lost.', ADJUSTMENT: 'A manual recount or correction of the stock.', TRANSFER: 'Eggs moved between places.', CORRECTION: 'A correction to an earlier entry.',
};

/** One entry of the stock ledger. Entries are never edited: a mistake is fixed by a new, opposite entry. */
export default function StockMovement() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useEndpoints();
  const router = useRouter();
  const c = useColors();
  const canSales = useCan('sales.read');
  const canProd = useCan('production.read');
  const q = useQuery({ queryKey: ['inventory', 'tx', id], queryFn: () => api.inventory.transaction(id) });
  const t = q.data;
  if (q.isLoading) return <Screen><Loading /></Screen>;
  if (!t) return <Screen><ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /></Screen>;
  const up = t.quantityEggs > 0;
  const source = canSales && t.sourceType === 'sale' && t.sourceId ? { path: `/sales/${t.sourceId}`, label: 'Open the sale' }
    : canProd && t.sourceType === 'production_record' && t.sourceId ? { path: `/production/${t.sourceId}`, label: 'Open the production record' } : null;
  return (
    <Screen refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
      <Card style={{ gap: space.lg }}>
        <Row style={{ gap: space.md }}>
          <IconTile name={up ? 'arrow-up-circle-outline' : 'arrow-down-circle-outline'} tone={up ? 'primary' : 'accent'} />
          <View style={{ flex: 1 }}>
            <Text variant="heading">{LABEL[t.type] ?? t.type}</Text>
            <Text variant="caption" muted>{formatDateTime(t.occurredAt)}</Text>
          </View>
          {t.needsReview ? <Badge tone="warn" label="Needs review" /> : null}
        </Row>
        <Text variant="display" color={up ? c.ok : c.danger}>{up ? '+' : '−'}{formatInt(Math.abs(t.quantityEggs))} eggs</Text>
        <Text variant="caption" muted>{eggBreakdown(Math.abs(t.quantityEggs))}</Text>
        <Text>{WHAT[t.type] ?? ''}</Text>
      </Card>

      <View style={{ gap: space.md }}>
        <SectionHeader title="Details" />
        <Card style={{ gap: space.md }}>
          <Detail label="Stock afterwards" value={`${formatInt(t.balanceAfterEggs)} eggs`} />
          <Detail label="Happened" value={formatDateTime(t.occurredAt)} />
          <Detail label="Recorded" value={formatDateTime(t.recordedAt)} />
          <Detail label="Recorded by" value={t.createdByName ?? 'System'} />
          {t.reason ? <Detail label="Reason" value={t.reason} /> : null}
          <Detail label="Reference" value={t.id.slice(0, 8).toUpperCase()} />
        </Card>
      </View>

      {t.needsReview ? <Card tone="warn"><Text>This entry came from the Excel import and was flagged for a person to check.</Text></Card> : null}
      {source ? <Button title={source.label} icon="open-outline" onPress={() => router.push(source.path as never)} /> : null}
    </Screen>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: space.lg }}>
      <Text variant="caption" muted>{label}</Text>
      <Text variant="bodyStrong" style={{ flex: 1, textAlign: 'right' }}>{value}</Text>
    </Row>
  );
}
