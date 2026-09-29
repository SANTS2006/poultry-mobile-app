import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import type { Customer } from '../../../api/types';
import { formatMoney } from '../../../lib/format';
import { useEndpoints } from '../../../state/app';
import { useCan } from '../../../state/store';
import { Badge, Button, Field, ListRow, Text } from '../../../ui/components';
import { PagedList } from '../../../ui/paged-list';
import { space } from '../../../ui/theme';

export default function Customers() {
  const router = useRouter();
  const api = useEndpoints();
  const canCreate = useCan('customers.create');
  const [q, setQ] = useState('');
  return (
    <PagedList<Customer>
      queryKey={['customers', 'list', q]}
      fetchPage={(page, limit) => api.customers.list({ page, limit, q: q.trim() || undefined })}
      emptyTitle="No customers found"
      header={(
        <View style={{ padding: space.lg, gap: space.sm }}>
          <Field label="Search" value={q} onChangeText={setQ} autoCorrect={false} />
          {canCreate ? <Button title="Add customer" variant="secondary" onPress={() => router.push('/customers/new')} /> : null}
        </View>
      )}
      renderItem={(c) => (
        <ListRow
          title={c.name} subtitle={[c.type === 'WHOLESALE' ? 'Wholesale' : 'Regular', c.phone].filter(Boolean).join(' · ')}
          badge={c.outstandingBalance && Number(c.outstandingBalance) > 0 ? <Badge tone="warn" label={`Owes ${formatMoney(c.outstandingBalance)}`} /> : undefined}
          onPress={() => router.push(`/customers/${c.id}`)} right={<Text muted>›</Text>}
        />
      )}
    />
  );
}
