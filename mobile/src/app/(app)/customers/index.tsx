import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import type { Customer } from '../../../api/types';
import { formatMoney } from '../../../lib/format';
import { useEndpoints } from '../../../state/app';
import { useCan } from '../../../state/store';
import { Badge, Button, ListRow, SearchBar } from '../../../ui/components';
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
      emptyIcon="people-outline" emptyTitle="No customers found" emptyHint={q ? 'Try a different name or phone number.' : 'Add your regular buyers to track credit and payments.'}
      header={(
        <View style={{ padding: space.lg, gap: space.sm }}>
          <SearchBar value={q} onChangeText={setQ} placeholder="Search customers" />
          {canCreate ? <Button title="Add customer" icon="person-add-outline" variant="secondary" onPress={() => router.push('/customers/new')} /> : null}
        </View>
      )}
      renderItem={(c) => (
        <ListRow
          icon="person-outline" title={c.name} subtitle={[c.type === 'WHOLESALE' ? 'Wholesale' : 'Regular', c.phone].filter(Boolean).join(' · ')}
          badge={c.outstandingBalance && Number(c.outstandingBalance) > 0 ? <Badge tone="warn" label={`Owes ${formatMoney(c.outstandingBalance)}`} /> : undefined}
          onPress={() => router.push(`/customers/${c.id}`)} 
        />
      )}
    />
  );
}
