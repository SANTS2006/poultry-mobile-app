import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { describeError } from '../../../lib/errors';
import { formatDate, formatDateTime, formatMoney } from '../../../lib/format';
import { useEndpoints } from '../../../state/app';
import { useCan } from '../../../state/store';
import { Badge, Button, Card, ErrorView, Loading, Row, Screen, SectionHeader, Text } from '../../../ui/components';
import { Icon } from '../../../ui/icon';
import { ReasonModal } from '../../../ui/reason-modal';
import { space, useColors } from '../../../ui/theme';
import { useToast } from '../../../ui/toast';

export default function SaleDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useEndpoints();
  const router = useRouter();
  const qc = useQueryClient();
  const c = useColors();
  const toast = useToast();
  const canVoid = useCan('sales.delete');
  const canPay = useCan('payments.create');
  const [voiding, setVoiding] = useState(false);
  const q = useQuery({ queryKey: ['sales', 'detail', id], queryFn: () => api.sales.get(id) });
  const s = q.data;

  if (q.isLoading) return <Screen><Loading /></Screen>;
  if (!s) return <Screen><ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /></Screen>;
  const owes = Number(s.outstanding) > 0 && s.status === 'ACTIVE';
  const badge = s.status === 'VOIDED' ? <Badge tone="danger" label="Voided" /> : s.paymentStatus === 'PAID' ? <Badge tone="ok" label="Paid" /> : s.paymentStatus === 'PARTIAL' ? <Badge tone="warn" label="Part paid" /> : <Badge tone="danger" label="Unpaid" />;

  return (
    <Screen refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text variant="caption" muted>{s.number}</Text>{badge}
        </Row>
        <Text variant="display" adjustsFontSizeToFit numberOfLines={1}>{formatMoney(s.total)}</Text>
        <Row><Icon name="person-outline" size="sm" /><Text style={{ flex: 1 }}>{s.customer?.name ?? 'Walk-in customer'}</Text></Row>
        <Row><Icon name="calendar-outline" size="sm" /><Text style={{ flex: 1 }}>{formatDate(s.saleDate)}</Text></Row>
        {s.status === 'VOIDED' ? <Row><Icon name="close-circle" size="sm" color={c.danger} /><Text color={c.danger} style={{ flex: 1 }}>Voided: {s.voidReason}</Text></Row> : null}
      </Card>

      {owes ? (
        <Card tone="warn">
          <Row><Icon name="time-outline" size="md" color={c.warn} /><Text variant="heading" style={{ flex: 1 }}>{formatMoney(s.outstanding)} still owed</Text></Row>
          {canPay ? <Button title="Record a payment" icon="cash-outline" onPress={() => router.push({ pathname: '/payments/new', params: { saleId: s.id, owed: s.outstanding, label: s.number } })} /> : null}
        </Card>
      ) : null}

      <View style={{ gap: space.md }}>
        <SectionHeader title="Items" />
        <Card>
          {s.items.map((i) => (
            <Row key={i.unit} style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}><Text variant="bodyStrong">{i.quantity} × {i.unit.toLowerCase()}</Text><Text variant="caption" muted>{formatMoney(i.unitPrice)} each</Text></View>
              <Text variant="bodyStrong">{formatMoney(i.lineTotal)}</Text>
            </Row>
          ))}
          {Number(s.discount) > 0 ? <Row style={{ justifyContent: 'space-between' }}><Text muted>Discount</Text><Text>−{formatMoney(s.discount)}</Text></Row> : null}
          <View style={{ height: 1, backgroundColor: c.border, marginVertical: space.xs }} />
          <Row style={{ justifyContent: 'space-between' }}><Text variant="bodyStrong">Paid so far</Text><Text variant="bodyStrong">{formatMoney(s.paidAmount)}</Text></Row>
        </Card>
      </View>

      {s.payments.some((p) => p.status === 'ACTIVE') ? (
        <View style={{ gap: space.md }}>
          <SectionHeader title="Payments" />
          <Card>
            {s.payments.filter((p) => p.status === 'ACTIVE').map((p) => (
              <Row key={p.id} style={{ justifyContent: 'space-between' }}>
                <View><Text variant="bodyStrong">{formatMoney(p.amount)}</Text><Text variant="caption" muted>{p.method.replace('_', ' ').toLowerCase()}</Text></View>
                <Text variant="caption" muted>{formatDateTime(p.paidAt)}</Text>
              </Row>
            ))}
          </Card>
        </View>
      ) : null}

      <Text variant="caption" muted>Recorded {formatDateTime(s.createdAt)}</Text>
      {s.status === 'ACTIVE' && canVoid ? <Button title="Void this sale" variant="ghost" icon="trash-outline" onPress={() => setVoiding(true)} /> : null}

      <ReasonModal
        visible={voiding} title="Void this sale?" message="The eggs go back into stock and payments are reversed. The sale stays in the history; the reason goes to the audit log." confirmLabel="Void sale" danger
        onCancel={() => setVoiding(false)}
        onConfirm={async (reason) => {
          try {
            await api.sales.void(s.id, reason);
            setVoiding(false);
            await qc.invalidateQueries();
            toast.show('Sale voided');
          } catch (e) { setVoiding(false); toast.show(describeError(e), 'error'); }
        }}
      />
    </Screen>
  );
}
