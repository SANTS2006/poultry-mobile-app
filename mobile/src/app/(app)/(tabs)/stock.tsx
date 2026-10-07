import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { describeError } from '../../../lib/errors';
import { eggBreakdown, formatInt } from '../../../lib/format';
import { useApp, useEndpoints } from '../../../state/app';
import { useAppStore, useCan } from '../../../state/store';
import { estimateStockEggs } from '../../../sync';
import { Badge, Card, ErrorView, ListRow, Loading, Row, Screen, Text } from '../../../ui/components';
import { Icon } from '../../../ui/icon';
import { useColors } from '../../../ui/theme';
import { useEffect, useState } from 'react';

/** Current stock straight from the append-only ledger; offline it shows the last known value plus records waiting to be sent. */
export default function StockTab() {
  const api = useEndpoints();
  const { services } = useApp();
  const router = useRouter();
  const c = useColors();
  const canAdjust = useCan('inventory.adjust');
  const sync = useAppStore((s) => s.sync);
  const q = useQuery({ queryKey: ['inventory', 'current'], queryFn: () => api.inventory.current() });
  const recon = useQuery({ queryKey: ['inventory', 'recon'], queryFn: () => api.inventory.reconciliation(), enabled: canAdjust });
  const [estimate, setEstimate] = useState<number | null>(null);

  useEffect(() => {
    const base = q.data?.quantityEggs ?? services.refData.current?.inventory?.quantityEggs;
    if (base === undefined) return;
    const unitEggs = Object.fromEntries((services.refData.current?.units ?? []).map((u) => [u.code, u.eggsPerUnit]));
    void services.engine.list().then((all) => setEstimate(estimateStockEggs(base, unitEggs, all)));
  }, [q.data, services, sync]);

  const s = q.data;
  const unsent = estimate !== null && s ? estimate - s.quantityEggs : 0;
  return (
    <Screen refreshing={q.isRefetching} onRefresh={() => { void q.refetch(); void recon.refetch(); }}>
      {q.isLoading ? <Loading /> : null}
      {q.error && !s ? <ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /> : null}
      {s ? (
        <Card tone={s.lowStock ? 'warn' : undefined}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text variant="label" muted>Eggs in stock</Text>
            {s.lowStock ? <Badge tone="warn" label="Low stock" /> : <Badge tone="ok" label="Healthy" />}
          </Row>
          <Text variant="display" accessibilityRole="header">{formatInt(s.quantityEggs)}</Text>
          <Text muted>{eggBreakdown(s.quantityEggs)}</Text>
          {s.lowStock ? <Text variant="caption" muted>Below your alert level of {formatInt(s.lowStockThresholdEggs)} eggs.</Text> : null}
          {unsent !== 0 ? <Text variant="caption" muted>With records waiting to be sent from this phone: about {formatInt(estimate)} eggs.</Text> : null}
        </Card>
      ) : null}

      <Card style={{ padding: 0, gap: 0, overflow: 'hidden' }}>
        <ListRow icon="time-outline" title="Stock history" subtitle="Every production, sale and adjustment" onPress={() => router.push('/inventory/history')} />
        {canAdjust ? <ListRow icon="construct-outline" title="Adjust or record a loss" subtitle="Broken, lost, own use or a recount" onPress={() => router.push('/inventory/adjust')} /> : null}
      </Card>

      {canAdjust && recon.data ? (
        <Card tone={recon.data.consistent ? 'ok' : 'danger'}>
          <Row><Icon name={recon.data.consistent ? 'checkmark-circle' : 'alert-circle'} size="md" color={recon.data.consistent ? c.ok : c.danger} /><Text variant="heading" style={{ flex: 1 }}>{recon.data.consistent ? 'Stock ledger checks out' : 'Ledger mismatch, contact support'}</Text></Row>
          <Text variant="caption" muted>Balance {formatInt(recon.data.balanceEggs)} · movements add up to {formatInt(recon.data.ledgerSumEggs)}</Text>
        </Card>
      ) : null}
      <Text variant="caption" muted>Stock only changes through recorded production, sales and adjustments. It is never typed in directly.</Text>
    </Screen>
  );
}
