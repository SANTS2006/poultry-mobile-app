import { useRouter } from 'expo-router';
import { View } from 'react-native';
import type { Sale } from '../../../api/types';
import { formatDate, formatMoney } from '../../../lib/format';
import { useEndpoints } from '../../../state/app';
import { useCan } from '../../../state/store';
import { Badge, Button, ListRow } from '../../../ui/components';
import { PagedList } from '../../../ui/paged-list';
import { space } from '../../../ui/theme';

const TONE = { PAID: 'ok', PARTIAL: 'warn', UNPAID: 'danger' } as const;

export default function SalesTab() {
  const router = useRouter();
  const api = useEndpoints();
  const canCreate = useCan('sales.create');
  return (
    <PagedList<Sale>
      queryKey={['sales', 'list']}
      fetchPage={(page, limit) => api.sales.list({ page, limit })}
      emptyIcon="receipt-outline" emptyTitle="No sales yet" emptyHint="Record a sale and it appears here, with what is paid and what is owed."
      emptyAction={canCreate ? { label: 'New sale', icon: 'add', onPress: () => router.push('/sales/new') } : undefined}
      header={canCreate ? <View style={{ padding: space.lg }}><Button title="New sale" icon="add" onPress={() => router.push('/sales/new')} /></View> : undefined}
      renderItem={(s) => (
        <ListRow
          icon="receipt-outline" title={`${formatMoney(s.total)} · ${s.customer?.name ?? 'Walk-in'}`} subtitle={`${formatDate(s.saleDate)} · ${s.number}`}
          onPress={() => router.push(`/sales/${s.id}`)}
          badge={s.status === 'VOIDED' ? <Badge tone="danger" label="Voided" /> : <Badge tone={TONE[s.paymentStatus]} label={s.paymentStatus === 'PAID' ? 'Paid' : s.paymentStatus === 'PARTIAL' ? `Owes ${formatMoney(s.outstanding)}` : 'Unpaid'} />}
                  />
      )}
    />
  );
}
