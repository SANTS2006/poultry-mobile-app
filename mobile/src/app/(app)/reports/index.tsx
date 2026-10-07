import { useCan } from '../../../state/store';
import { Card, EmptyState, NavRow, Screen } from '../../../ui/components';
import type { IconName } from '../../../ui/icon';

const REPORTS: { name: string; title: string; subtitle: string; icon: IconName; needs: string[] }[] = [
  { name: 'production', title: 'Production', subtitle: 'Eggs by day, coop and shift', icon: 'egg-outline', needs: ['production.read'] },
  { name: 'sales', title: 'Sales', subtitle: 'Revenue, customers and credit', icon: 'receipt-outline', needs: ['sales.read'] },
  { name: 'expenses', title: 'Expenses', subtitle: 'By category and supplier', icon: 'wallet-outline', needs: ['expenses.read'] },
  { name: 'inventory', title: 'Stock', subtitle: 'Opening, movements and closing', icon: 'cube-outline', needs: ['inventory.read'] },
  { name: 'financial', title: 'Cash flow', subtitle: 'Cash received minus expenses (not profit)', icon: 'cash-outline', needs: ['sales.read', 'expenses.read', 'payments.read'] },
];

export default function Reports() {
  const perms = {
    'production.read': useCan('production.read'), 'sales.read': useCan('sales.read'), 'expenses.read': useCan('expenses.read'),
    'inventory.read': useCan('inventory.read'), 'payments.read': useCan('payments.read'),
  } as Record<string, boolean>;
  const visible = REPORTS.filter((r) => r.needs.every((p) => perms[p]));
  return (
    <Screen>
      {visible.length ? (
        <Card style={{ padding: 0, gap: 0, overflow: 'hidden' }}>
          {visible.map((r) => <NavRow key={r.name} icon={r.icon} title={r.title} subtitle={r.subtitle} to={`/reports/${r.name}`} />)}
        </Card>
      ) : <EmptyState icon="lock-closed-outline" title="No reports for your role" hint="Ask an administrator if you need access." />}
    </Screen>
  );
}
