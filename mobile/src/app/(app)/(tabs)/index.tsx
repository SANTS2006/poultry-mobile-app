import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { describeError } from '../../../lib/errors';
import { eggBreakdown, formatDate, formatInt, formatMoney, greeting } from '../../../lib/format';
import { useDashboard } from '../../../queries/hooks';
import { useAppStore, useCan } from '../../../state/store';
import { BarChart } from '../../../ui/charts';
import { ActionTile, Avatar, Badge, Card, ErrorView, ListRow, Loading, Row, Screen, SectionHeader, StatTile, Text } from '../../../ui/components';
import { Icon } from '../../../ui/icon';
import { space, useColors } from '../../../ui/theme';

export default function Home() {
  const router = useRouter();
  const c = useColors();
  const user = useAppStore((s) => s.user);
  const sync = useAppStore((s) => s.sync);
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

      {q.isLoading ? <Loading label="Loading your numbers" /> : q.error && !d ? <ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /> : null}

      {d ? (
        <View style={{ gap: space.xl }}>
          {d.production ? (
            <View style={{ gap: space.md }}>
              <SectionHeader title="Production" />
              <View style={tiles}>
                <StatTile icon="egg-outline" label="Eggs today" value={formatInt(d.production.todayEggs)} hint={eggBreakdown(d.production.todayEggs)} />
                <StatTile icon="calendar-outline" label="Yesterday" value={formatInt(d.production.yesterdayEggs)} hint={deltaHint(d.production.todayEggs, d.production.yesterdayEggs)} />
                <StatTile icon="stats-chart-outline" label="Last 7 days" value={formatInt(d.production.weekEggs)} hint={`About ${formatInt(d.production.averagePerDay7)} a day`} />
                <StatTile icon="calendar-number-outline" label="This month" value={formatInt(d.production.monthEggs)} hint={`${d.production.recordsMonth} record${d.production.recordsMonth === 1 ? '' : 's'}`} />
                <StatTile icon="create-outline" label="Records today" value={String(d.production.recordsToday)} hint={`${d.production.activeCoops} active coop${d.production.activeCoops === 1 ? '' : 's'}`} />
                {d.production.bestDay14 ? <StatTile icon="trophy-outline" label="Best day (14 days)" value={formatInt(d.production.bestDay14.eggs)} hint={formatDate(d.production.bestDay14.date)} /> : null}
              </View>
              {d.production.byCoop.length > 1 ? (
                <Card style={{ padding: 0, gap: 0, overflow: 'hidden' }}>
                  {d.production.byCoop.map((x) => <ListRow key={x.coopId} icon="home-outline" title={x.name} subtitle={`${formatInt(x.eggs)} eggs today`} />)}
                </Card>
              ) : null}
              <Card>
                <Row style={{ justifyContent: 'space-between' }}><Text variant="heading">Eggs, last 14 days</Text>{missing.length === 0 ? <Badge tone="ok" label="All shifts in" /> : null}</Row>
                <BarChart label="Eggs collected per day, last 14 days" data={d.production.last14Days.map((x) => ({ label: formatDate(x.date, false), value: x.eggs }))} />
              </Card>
            </View>
          ) : null}

          {d.inventory ? (
            <View style={{ gap: space.md }}>
              <SectionHeader title="Stock" />
              <View style={tiles}>
                <StatTile icon="cube-outline" label="In stock" value={formatInt(d.inventory.quantityEggs)} hint={d.inventory.lowStock ? 'Low stock' : eggBreakdown(d.inventory.quantityEggs)} tone={d.inventory.lowStock ? 'warn' : undefined} />
              </View>
            </View>
          ) : null}

          {d.sales ? (
            <View style={{ gap: space.md }}>
              <SectionHeader title="Sales" />
              <View style={tiles}>
                <StatTile icon="receipt-outline" label="Sales today" value={formatMoney(d.sales.todayRevenue, cur)} hint={`${d.sales.todayCount} sale${d.sales.todayCount === 1 ? '' : 's'} · ${formatInt(d.sales.todayEggsSold)} eggs`} />
                <StatTile icon="calendar-outline" label="Last 7 days" value={formatMoney(d.sales.weekRevenue, cur)} hint={`${d.sales.weekCount} sale${d.sales.weekCount === 1 ? '' : 's'}`} />
                <StatTile icon="calendar-number-outline" label="This month" value={formatMoney(d.sales.monthRevenue, cur)} hint={`${d.sales.monthCount} sale${d.sales.monthCount === 1 ? '' : 's'} · ${formatInt(d.sales.monthEggsSold)} eggs`} />
                <StatTile icon="pricetag-outline" label="Average sale" value={formatMoney(d.sales.averageSaleMonth, cur)} hint="This month" />
                <StatTile icon="hourglass-outline" label="Not fully paid" value={String(d.sales.unpaidSales)} hint={d.sales.unpaidSales ? 'Sales still owing money' : 'All sales paid'} tone={d.sales.unpaidSales ? 'warn' : undefined} />
              </View>
              {d.sales.topCustomersMonth.length ? (
                <Card style={{ padding: 0, gap: 0, overflow: 'hidden' }}>
                  <View style={{ padding: space.lg, paddingBottom: space.sm }}><Text variant="heading">Top customers this month</Text></View>
                  {d.sales.topCustomersMonth.map((x, i) => <ListRow key={`${x.name}-${i}`} icon="person-outline" title={x.name} subtitle={formatMoney(x.total, cur)} />)}
                </Card>
              ) : null}
              <Card>
                <Text variant="heading">Sales, last 14 days</Text>
                <BarChart label="Sales value per day, last 14 days" data={d.sales.last14Days.map((x) => ({ label: formatDate(x.date, false), value: Number(x.revenue) }))} />
              </Card>
            </View>
          ) : null}

          {d.customers ? (
            <View style={{ gap: space.md }}>
              <SectionHeader title="Customers" />
              <View style={tiles}>
                <StatTile icon="people-outline" label="Customers" value={String(d.customers.total)} hint={`${d.customers.regular} regular · ${d.customers.wholesale} wholesale`} />
                <StatTile icon="person-add-outline" label="New this month" value={String(d.customers.addedThisMonth)} />
              </View>
            </View>
          ) : null}

          {d.expenses || d.cash ? (
            <View style={{ gap: space.md }}>
              <SectionHeader title="Money" />
              <View style={tiles}>
                {d.cash ? <StatTile icon="cash-outline" label="Net cash flow today" value={formatMoney(d.cash.netCashFlowToday, cur)} hint="Cash in minus expenses. Not profit." /> : null}
                {d.expenses ? <StatTile icon="wallet-outline" label="Expenses this month" value={formatMoney(d.expenses.monthToDateTotal, cur)} hint={`Today ${formatMoney(d.expenses.todayTotal, cur)}`} /> : null}
              </View>
            </View>
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

const tiles = { flexDirection: 'row', flexWrap: 'wrap', gap: space.md } as const;

/** How today compares with yesterday, in words. */
function deltaHint(today: number, yesterday: number): string {
  if (yesterday === 0) return 'Nothing recorded yesterday';
  const pct = Math.round(((today - yesterday) / yesterday) * 100);
  return pct === 0 ? 'Today is level so far' : `Today is ${Math.abs(pct)}% ${pct > 0 ? 'ahead' : 'behind'} so far`;
}
