import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';
import { describeError } from '../../../lib/errors';
import { formatDate, formatDateTime, formatMoney } from '../../../lib/format';
import { useEndpoints } from '../../../state/app';
import { useCan } from '../../../state/store';
import { Badge, Button, Card, ErrorView, Loading, Row, Screen, SectionTitle, Text } from '../../../ui/components';
import { ReasonModal } from '../../../ui/reason-modal';

export default function SaleDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useEndpoints();
  const router = useRouter();
  const qc = useQueryClient();
  const canVoid = useCan('sales.delete');
  const canPay = useCan('payments.create');
  const [voiding, setVoiding] = useState(false);
  const q = useQuery({ queryKey: ['sales', 'detail', id], queryFn: () => api.sales.get(id) });
  const s = q.data;

  if (q.isLoading) return <Screen><Loading /></Screen>;
  if (!s) return <Screen><ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /></Screen>;
  const owes = Number(s.outstanding) > 0 && s.status === 'ACTIVE';

  return (
    <Screen refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
      <Card>
        <Row style={{ justifyContent: 'space-between' }}><Text size="title" bold>{formatMoney(s.total)}</Text>{s.status === 'VOIDED' ? <Badge tone="danger" label="Voided" /> : <Badge tone={s.paymentStatus === 'PAID' ? 'ok' : s.paymentStatus === 'PARTIAL' ? 'warn' : 'danger'} label={s.paymentStatus.toLowerCase()} />}</Row>
        <Text>{s.customer?.name ?? 'Walk-in customer'} · {formatDate(s.saleDate)}</Text>
        <Text size="small" muted>{s.number} · recorded {formatDateTime(s.createdAt)}</Text>
        {s.status === 'VOIDED' ? <Text color="#B42318">Voided: {s.voidReason}</Text> : null}
      </Card>

      <SectionTitle>Items</SectionTitle>
      <Card>
        {s.items.map((i) => <Row key={i.unit} style={{ justifyContent: 'space-between' }}><Text>{i.quantity} × {i.unit.toLowerCase()} @ {formatMoney(i.unitPrice)}</Text><Text>{formatMoney(i.lineTotal)}</Text></Row>)}
        {Number(s.discount) > 0 ? <Row style={{ justifyContent: 'space-between' }}><Text muted>Discount</Text><Text>−{formatMoney(s.discount)}</Text></Row> : null}
        <Row style={{ justifyContent: 'space-between' }}><Text bold>Paid</Text><Text bold>{formatMoney(s.paidAmount)}</Text></Row>
        {owes ? <Row style={{ justifyContent: 'space-between' }}><Text bold color="#B42318">Still owed</Text><Text bold color="#B42318">{formatMoney(s.outstanding)}</Text></Row> : null}
      </Card>

      {s.payments.length ? (
        <>
          <SectionTitle>Payments</SectionTitle>
          {s.payments.filter((p) => p.status === 'ACTIVE').map((p) => (
            <Card key={p.id}><Row style={{ justifyContent: 'space-between' }}><Text>{formatMoney(p.amount)} · {p.method.replace('_', ' ').toLowerCase()}</Text><Text muted>{formatDateTime(p.paidAt)}</Text></Row></Card>
          ))}
        </>
      ) : null}

      {owes && canPay ? <Button title="Record a payment" onPress={() => router.push({ pathname: '/payments/new', params: { saleId: s.id, owed: s.outstanding, label: s.number } })} /> : null}
      {s.status === 'ACTIVE' && canVoid ? <Button title="Void sale" variant="danger" onPress={() => setVoiding(true)} /> : null}

      <ReasonModal
        visible={voiding} title="Void this sale?" message="The eggs go back into stock and payments are reversed. The sale stays in the history; the reason goes to the audit log." confirmLabel="Void sale" danger
        onCancel={() => setVoiding(false)}
        onConfirm={async (reason) => {
          try {
            await api.sales.void(s.id, reason);
            setVoiding(false);
            await qc.invalidateQueries();
            Alert.alert('Sale voided');
          } catch (e) { setVoiding(false); Alert.alert('Could not void', describeError(e)); }
        }}
      />
    </Screen>
  );
}
