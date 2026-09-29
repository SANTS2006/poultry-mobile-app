import { useRouter } from 'expo-router';
import { useCan } from '../../../state/store';
import { ListRow, Screen, Text } from '../../../ui/components';

const REPORTS = [
  { name: 'production', title: 'Production', subtitle: 'Eggs by day, coop and shift', needs: ['production.read'] },
  { name: 'sales', title: 'Sales', subtitle: 'Revenue, customers, credit', needs: ['sales.read'] },
  { name: 'expenses', title: 'Expenses', subtitle: 'By category and supplier', needs: ['expenses.read'] },
  { name: 'inventory', title: 'Stock', subtitle: 'Opening, movements and closing', needs: ['inventory.read'] },
  { name: 'financial', title: 'Cash flow', subtitle: 'Cash received minus expenses (not profit)', needs: ['sales.read', 'expenses.read', 'payments.read'] },
] as const;

export default function Reports() {
  const router = useRouter();
  const perms = {
    'production.read': useCan('production.read'), 'sales.read': useCan('sales.read'), 'expenses.read': useCan('expenses.read'),
    'inventory.read': useCan('inventory.read'), 'payments.read': useCan('payments.read'),
  } as Record<string, boolean>;
  const visible = REPORTS.filter((r) => r.needs.every((p) => perms[p]));
  return (
    <Screen padded={false}>
      {visible.map((r) => <ListRow key={r.name} title={r.title} subtitle={r.subtitle} onPress={() => router.push(`/reports/${r.name}`)} right={<Text muted>›</Text>} />)}
      {!visible.length ? <Text muted style={{ padding: 16 }}>Your role does not include any reports.</Text> : null}
    </Screen>
  );
}
