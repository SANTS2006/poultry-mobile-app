import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { describeError } from '../../../lib/errors';
import { eggBreakdown, formatInt } from '../../../lib/format';
import { useApp, useEndpoints } from '../../../state/app';
import { useAppStore, useCan } from '../../../state/store';
import { estimateStockEggs } from '../../../sync';
import { Badge, Button, Card, ErrorView, Loading, Row, Screen, Text } from '../../../ui/components';
import { useEffect, useState } from 'react';

/** Current stock straight from the append-only ledger; offline it shows the last known value plus records waiting to be sent. */
export default function StockTab() {
  const api = useEndpoints();
  const { services } = useApp();
  const router = useRouter();
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
          <Text muted>Eggs in stock (server)</Text>
          <Text size="big" bold accessibilityRole="header">{formatInt(s.quantityEggs)}</Text>
          <Text muted>{eggBreakdown(s.quantityEggs)}</Text>
          {s.lowStock ? <Badge tone="warn" label={`Low stock (below ${formatInt(s.lowStockThresholdEggs)})`} /> : null}
          {unsent !== 0 ? <Text size="small" muted>With records waiting to be sent from this phone: about {formatInt(estimate)} eggs.</Text> : null}
        </Card>
      ) : null}
      {canAdjust && recon.data ? (
        <Card tone={recon.data.consistent ? 'ok' : 'danger'}>
          <Text bold>{recon.data.consistent ? 'Ledger check passed' : 'Ledger mismatch — contact support'}</Text>
          <Text size="small">Balance {formatInt(recon.data.balanceEggs)} · movements add up to {formatInt(recon.data.ledgerSumEggs)}</Text>
        </Card>
      ) : null}
      <Row style={{ flexWrap: 'wrap' }}>
        <Button title="Stock history" variant="secondary" onPress={() => router.push('/inventory/history')} />
        {canAdjust ? <Button title="Adjust / record loss" variant="secondary" onPress={() => router.push('/inventory/adjust')} /> : null}
      </Row>
      <Text size="small" muted>Stock only changes through recorded production, sales and adjustments. It is never typed in directly.</Text>
    </Screen>
  );
}
