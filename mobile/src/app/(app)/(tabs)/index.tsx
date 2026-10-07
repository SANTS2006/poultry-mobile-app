import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { describeError } from '../../../lib/errors';
import { eggBreakdown, formatDate, formatInt, formatMoney, greeting } from '../../../lib/format';
import { useDashboard } from '../../../queries/hooks';
import { useAppStore, useCan } from '../../../state/store';
import { BarChart } from '../../../ui/charts';
import { ActionTile, Avatar, Badge, Card, EmptyState, ErrorView, ListRow, Loading, Row, Screen, SectionHeader, StatTile, Text } from '../../../ui/components';
import { Icon } from '../../../ui/icon';
import { space, useColors } from '../../../ui/theme';

export default function Home() {
  const router = useRouter();
  const c = useColors();
  const user = useAppStore((s) => s.user);
  const sync = useAppStore((s) => s.sync);
  const canDash = useCan('dashboard.read');
  const canProd = useCan('production.create');
  const canSale = useCan('sales.create');
  const canExpense = useCan('expenses.create');
  const canReports = useCan('reports.read');
  const q = useDashboard();
  const d = q.data;
  const cur = d?.currency ?? '';
  const name = user?.fullName ?? 'there';

  const missing = d?.production?.notRecordedToday ?? [];
  const reviewCount = Object.values(d?.needsReview ?? {}).reduce<number>((a, n) => a + (n ?? 0), 0);
  const syncAttention = sync ? sync.conflict + sync.rejected + sync.blocked : 0;

  return (
    <Screen refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
      <Row style={{ gap: space.md }}>
        <Avatar name={user?.fullName ?? '?'} uri={user?.avatar} size={48} />
        <View style={{ flex: 1 }}>
          <Text variant="title" accessibilityRole="header" numberOfLines={1}>{greeting()}, {name}</Text>
          <Text variant="caption" muted>{d ? formatDate(d.businessDate) : formatDate(new Date().toISOString().slice(0, 10))}</Text>
        </View>
      </Row>

      {(canProd || canSale || canExpense) ? (
        <View style={{ gap: space.md }}>
          <SectionHeader title="Quick actions" />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
            {canProd ? <ActionTile icon="egg" label="Record production" onPress={() => router.push('/production/new')} /> : null}
            {canSale ? <ActionTile icon="receipt" label="New sale" tone="accent" onPress={() => router.push('/sales/new')} /> : null}
            {canExpense ? <ActionTile icon="wallet" label="Add expense" tone="accent" onPress={() => router.push('/expenses/new')} /> : null}
            {canReports ? <ActionTile icon="stats-chart" label="Reports" onPress={() => router.push('/reports')} /> : null}
          </View>
        </View>
      ) : null}

      {(missing.length > 0 || syncAttention > 0 || d?.inventory?.lowStock || reviewCount > 0) ? (
        <View style={{ gap: space.md }}>
          <SectionHeader title="Needs your attention" />
          <Card style={{ padding: 0, overflow: 'hidden', gap: 0 }}>
            {missing.length > 0 ? (
              <ListRow icon="time-outline" title={`${missing.length} shift${missing.length === 1 ? '' : 's'} not recorded today`} subtitle={missing.slice(0, 3).map((m) => `${m.coop} · ${m.shift.toLowerCase()}`).join(', ') + (missing.length > 3 ? '…' : '')} onPress={canProd ? () => router.push('/production/new') : undefined} />
            ) : null}
            {syncAttention > 0 ? <ListRow icon="sync-outline" title={`${syncAttention} record${syncAttention === 1 ? '' : 's'} need a decision`} subtitle="Saved on this phone, refused or waiting on the server" onPress={() => router.push('/sync')} /> : null}
            {d?.inventory?.lowStock ? <ListRow icon="warning-outline" title="Stock is running low" subtitle={`${formatInt(d.inventory.quantityEggs)} eggs left`} onPress={() => router.push('/inventory/history')} /> : null}
            {reviewCount > 0 ? <ListRow icon="flag-outline" title={`${reviewCount} imported record${reviewCount === 1 ? '' : 's'} to check`} subtitle="Flagged during the move from Excel" /> : null}
          </Card>
        </View>
      ) : null}

      {!canDash ? (
        <EmptyState icon="lock-closed-outline" title="Your dashboard is limited" hint="Your role records data but doesn’t include summary figures. Use the tabs below." />
      ) : q.isLoading ? <Loading label="Loading today’s numbers" /> : q.error && !d ? <ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /> : null}

      {d ? (
        <View style={{ gap: space.lg }}>
          <SectionHeader title="Today" />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
            {d.production ? <StatTile icon="egg-outline" label="Eggs collected" value={formatInt(d.production.todayEggs)} hint={eggBreakdown(d.production.todayEggs)} /> : null}
            {d.inventory ? <StatTile icon="cube-outline" label="In stock" value={formatInt(d.inventory.quantityEggs)} hint={d.inventory.lowStock ? 'Low stock' : eggBreakdown(d.inventory.quantityEggs)} tone={d.inventory.lowStock ? 'warn' : undefined} /> : null}
            {d.sales ? <StatTile icon="receipt-outline" label="Sales" value={formatMoney(d.sales.todayRevenue, cur)} hint={`${d.sales.todayCount} sale${d.sales.todayCount === 1 ? '' : 's'} · ${formatInt(d.sales.todayEggsSold)} eggs`} /> : null}
            {d.cash ? <StatTile icon="cash-outline" label="Net cash flow" value={formatMoney(d.cash.netCashFlowToday, cur)} hint="Cash in minus expenses. Not profit." /> : d.expenses ? <StatTile icon="wallet-outline" label="Expenses this month" value={formatMoney(d.expenses.monthToDateTotal, cur)} /> : null}
          </View>

          {d.production ? (
            <Card>
              <Row style={{ justifyContent: 'space-between' }}><Text variant="heading">Eggs, last 14 days</Text>{missing.length === 0 ? <Badge tone="ok" label="All shifts in" /> : null}</Row>
              <BarChart label="Eggs collected per day, last 14 days" data={d.production.last14Days.map((x) => ({ label: formatDate(x.date, false), value: x.eggs }))} />
            </Card>
          ) : null}

          {d.sales ? (
            <Card>
              <Text variant="heading">Sales, last 14 days</Text>
              <BarChart label="Sales value per day, last 14 days" data={d.sales.last14Days.map((x) => ({ label: formatDate(x.date, false), value: Number(x.revenue) }))} />
            </Card>
          ) : null}

          {d.receivables ? (
            <Card>
              <Row><Icon name="people-outline" size="md" /><Text variant="heading" style={{ flex: 1 }}>Owed by customers</Text></Row>
              <Text variant="title" color={Number(d.receivables.outstandingTotal) > 0 ? c.warn : c.ok}>{formatMoney(d.receivables.outstandingTotal, cur)}</Text>
              <Text variant="caption" muted>{d.receivables.customersWithBalance} customer{d.receivables.customersWithBalance === 1 ? '' : 's'} with a balance</Text>
            </Card>
          ) : null}
          <Text variant="caption" muted style={{ textAlign: 'center' }}>{q.isError ? 'Offline — showing the last loaded numbers' : 'Pull down to refresh'}</Text>
        </View>
      ) : null}
    </Screen>
  );
}
