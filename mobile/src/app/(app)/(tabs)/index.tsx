import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { describeError } from '../../../lib/errors';
import { eggBreakdown, formatDate, formatInt, formatMoney } from '../../../lib/format';
import { useDashboard } from '../../../queries/hooks';
import { useAppStore, useCan } from '../../../state/store';
import { BarChart } from '../../../ui/charts';
import { Badge, Button, Card, ErrorView, Loading, Row, Screen, SectionTitle, Text } from '../../../ui/components';
import { space } from '../../../ui/theme';

export default function Home() {
  const router = useRouter();
  const user = useAppStore((s) => s.user);
  const canDash = useCan('dashboard.read');
  const canProd = useCan('production.create');
  const canSale = useCan('sales.create');
  const canExpense = useCan('expenses.create');
  const q = useDashboard();
  const d = q.data;
  const cur = d?.currency ?? '';

  return (
    <Screen refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
      <Text size="title" bold accessibilityRole="header">Hello, {user?.fullName?.split(' ')[0] ?? 'there'}</Text>

      <Row style={{ flexWrap: 'wrap' }}>
        {canProd ? <Button title="🥚 Record production" onPress={() => router.push('/production/new')} /> : null}
        {canSale ? <Button title="🧾 New sale" onPress={() => router.push('/sales/new')} /> : null}
        {canExpense ? <Button title="Add expense" variant="secondary" onPress={() => router.push('/expenses/new')} /> : null}
      </Row>

      {!canDash ? <Card><Text muted>Your role does not include the dashboard. Use the tabs below to record and review your work.</Text></Card> : null}
      {canDash && q.isLoading ? <Loading label="Loading today's numbers" /> : null}
      {canDash && q.error && !d ? <ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /> : null}

      {d ? (
        <>
          <Text size="small" muted>Business date {formatDate(d.businessDate)}{q.isError ? ' · showing last loaded numbers (offline)' : ''}</Text>

          {d.production ? (
            <Card>
              <Text muted>Eggs collected today</Text>
              <Text size="big" bold accessibilityRole="header">{formatInt(d.production.todayEggs)}</Text>
              <Text muted>{eggBreakdown(d.production.todayEggs)}</Text>
              <BarChart label="Eggs collected per day, last 14 days" data={d.production.last14Days.map((x) => ({ label: formatDate(x.date, false), value: x.eggs }))} />
              {d.production.notRecordedToday.length > 0 ? (
                <View style={{ gap: space.xs }}>
                  <Text bold>Not recorded yet today</Text>
                  <Row style={{ flexWrap: 'wrap' }}>
                    {d.production.notRecordedToday.map((n) => <Badge key={`${n.coopId}-${n.shift}`} tone="warn" label={`${n.coop} · ${n.shift.toLowerCase()}`} />)}
                  </Row>
                </View>
              ) : <Badge tone="ok" label="All shifts recorded today" />}
            </Card>
          ) : null}

          {d.inventory ? (
            <Card tone={d.inventory.lowStock ? 'warn' : undefined}>
              <Text muted>Eggs in stock</Text>
              <Text size="big" bold>{formatInt(d.inventory.quantityEggs)}</Text>
              <Text muted>{eggBreakdown(d.inventory.quantityEggs)}</Text>
              {d.inventory.lowStock ? <Badge tone="warn" label="Low stock" /> : null}
            </Card>
          ) : null}

          {d.sales ? (
            <Card>
              <Text muted>Sales today</Text>
              <Text size="big" bold>{formatMoney(d.sales.todayRevenue, cur)}</Text>
              <Text muted>{d.sales.todayCount} sale{d.sales.todayCount === 1 ? '' : 's'} · {formatInt(d.sales.todayEggsSold)} eggs</Text>
              <BarChart label="Sales value per day, last 14 days" data={d.sales.last14Days.map((x) => ({ label: formatDate(x.date, false), value: Number(x.revenue) }))} />
            </Card>
          ) : null}

          {d.cash ? (
            <Card>
              <Text bold>Cash today (not profit)</Text>
              <Row style={{ justifyContent: 'space-between' }}><Text muted>Cash received</Text><Text>{formatMoney(d.cash.receivedToday, cur)}</Text></Row>
              <Row style={{ justifyContent: 'space-between' }}><Text muted>Expenses recorded</Text><Text>{formatMoney(d.cash.expensesToday, cur)}</Text></Row>
              <Row style={{ justifyContent: 'space-between' }}><Text bold>Net cash flow</Text><Text bold>{formatMoney(d.cash.netCashFlowToday, cur)}</Text></Row>
              <Text size="small" muted>Cash received minus expenses recorded today. It ignores cost of goods and stock value, so it is not profit.</Text>
            </Card>
          ) : d.expenses ? (
            <Card>
              <Text muted>Expenses this month</Text>
              <Text size="big" bold>{formatMoney(d.expenses.monthToDateTotal, cur)}</Text>
            </Card>
          ) : null}

          {d.receivables ? (
            <Card>
              <Text muted>Owed by customers</Text>
              <Text size="title" bold>{formatMoney(d.receivables.outstandingTotal, cur)}</Text>
              <Text muted>{d.receivables.customersWithBalance} customer{d.receivables.customersWithBalance === 1 ? '' : 's'} with a balance</Text>
            </Card>
          ) : null}

          {Object.values(d.needsReview).some((n) => (n ?? 0) > 0) ? (
            <>
              <SectionTitle>Needs review</SectionTitle>
              <Card tone="warn"><Text>Some records imported from the old spreadsheet are flagged for checking: {Object.entries(d.needsReview).filter(([, n]) => (n ?? 0) > 0).map(([k, n]) => `${n} ${k}`).join(', ')}.</Text></Card>
            </>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
