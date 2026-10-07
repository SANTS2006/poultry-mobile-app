import { useRouter } from 'expo-router';
import { View } from 'react-native';
import type { Expense } from '../../../api/types';
import { formatDate, formatMoney } from '../../../lib/format';
import { useEndpoints } from '../../../state/app';
import { useCan } from '../../../state/store';
import { Badge, Button, ListRow } from '../../../ui/components';
import { PagedList } from '../../../ui/paged-list';
import { space } from '../../../ui/theme';

export default function Expenses() {
  const router = useRouter();
  const api = useEndpoints();
  const canCreate = useCan('expenses.create');
  return (
    <PagedList<Expense>
      queryKey={['expenses', 'list']}
      fetchPage={(page, limit) => api.expenses.list({ page, limit })}
      emptyIcon="wallet-outline" emptyTitle="No expenses yet" emptyHint="Record feed, labour and other costs to see where the money goes."
      emptyAction={canCreate ? { label: 'Add expense', icon: 'add', onPress: () => router.push('/expenses/new') } : undefined}
      header={canCreate ? <View style={{ padding: space.lg }}><Button title="Add expense" icon="add" onPress={() => router.push('/expenses/new')} /></View> : undefined}
      renderItem={(e) => (
        <ListRow
          icon="wallet-outline" title={`${formatMoney(e.total)} · ${e.category.name}`} subtitle={`${e.expenseDate ? formatDate(e.expenseDate) : 'No date'} · ${e.description}${e.supplier ? ` · ${e.supplier.name}` : ''}`}
          badge={e.needsReview ? <Badge tone="warn" label="Needs review" /> : undefined}
        />
      )}
    />
  );
}
