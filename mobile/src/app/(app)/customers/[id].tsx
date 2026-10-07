import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { describeError } from '../../../lib/errors';
import { formatDate, formatMoney } from '../../../lib/format';
import { useEndpoints } from '../../../state/app';
import { useCan } from '../../../state/store';
import { Badge, Button, Card, ErrorView, ListRow, Loading, Row, Screen, SectionTitle, Text } from '../../../ui/components';

export default function CustomerDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useEndpoints();
  const router = useRouter();
  const canPay = useCan('payments.create');
  const q = useQuery({ queryKey: ['customers', 'detail', id], queryFn: () => api.customers.get(id) });
  const sales = useQuery({ queryKey: ['sales', 'customer', id], queryFn: () => api.sales.list({ customerId: id, limit: 20 }) });
  const c = q.data;
  if (q.isLoading) return <Screen><Loading /></Screen>;
  if (!c) return <Screen><ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /></Screen>;
  const owes = c.outstandingBalance !== undefined && Number(c.outstandingBalance) > 0;
  return (
    <Screen refreshing={q.isRefetching} onRefresh={() => { void q.refetch(); void sales.refetch(); }}>
      <Card>
        <Text size="title" bold>{c.name}</Text>
        <Text muted>{c.type === 'WHOLESALE' ? 'Wholesale' : 'Regular'}{c.phone ? ` · ${c.phone}` : ''}</Text>
        {c.address ? <Text>{c.address}</Text> : null}
      </Card>
      {c.outstandingBalance !== undefined ? (
        <Card tone={owes ? 'warn' : 'ok'}>
          <Row style={{ justifyContent: 'space-between' }}><Text bold>{owes ? 'Owes' : 'Nothing owed'}</Text><Text size="title" bold>{formatMoney(c.outstandingBalance)}</Text></Row>
          <Text size="small" muted>Credit {c.creditAllowed ? `allowed up to ${formatMoney(c.creditLimit)}` : 'not allowed'}</Text>
          {owes && canPay ? <Button title="Record payment from this customer" onPress={() => router.push({ pathname: '/payments/new', params: { customerId: c.id, owed: c.outstandingBalance } })} /> : null}
        </Card>
      ) : null}
      <SectionTitle>Recent sales</SectionTitle>
      {sales.data?.items.length ? sales.data.items.map((s) => (
        <ListRow key={s.id} title={formatMoney(s.total)} subtitle={`${formatDate(s.saleDate)} · ${s.number}`} onPress={() => router.push(`/sales/${s.id}`)} badge={<Badge tone={s.paymentStatus === 'PAID' ? 'ok' : 'warn'} label={s.paymentStatus.toLowerCase()} />} />
      )) : <Text muted>No sales yet.</Text>}
    </Screen>
  );
}
