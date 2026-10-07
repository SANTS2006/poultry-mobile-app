import { useUnreadCount } from '../../../queries/hooks';
import { useAppStore, useCan, useCanAny } from '../../../state/store';
import { Badge, NavRow, Screen, SectionTitle, Text } from '../../../ui/components';
import { View } from 'react-native';

export default function More() {
  const user = useAppStore((s) => s.user);
  const sync = useAppStore((s) => s.sync);
  const unread = useUnreadCount().data?.unread ?? 0;
  const attention = sync ? sync.conflict + sync.rejected + sync.blocked : 0;
  const waiting = sync ? sync.pending + sync.syncing : 0;
  const canCustomers = useCan('customers.read');
  const canExpenses = useCan('expenses.read');
  const canReports = useCan('reports.read');
  const canAdmin = useCanAny('users.manage', 'audit.read', 'prices.manage', 'notifications.manage');

  return (
    <Screen padded={false}>
      <View style={{ padding: 16 }}><Text bold size="title">{user?.fullName}</Text><Text muted>{user?.email} · {user?.roles.join(', ').toLowerCase().replace(/_/g, ' ')}</Text></View>
      <NavRow title="Notifications" to="/notifications" badge={unread > 0 ? <Badge tone="info" label={`${unread} unread`} /> : undefined} />
      <NavRow title="Sync" subtitle="Records saved on this phone" to="/sync" badge={attention > 0 ? <Badge tone="danger" label={`${attention} need attention`} /> : waiting > 0 ? <Badge tone="info" label={`${waiting} waiting`} /> : undefined} />
      {canCustomers ? <NavRow title="Customers" to="/customers" /> : null}
      {canExpenses ? <NavRow title="Expenses" to="/expenses" /> : null}
      {canReports ? <NavRow title="Reports" subtitle="Production, sales, expenses, stock, cash flow" to="/reports" /> : null}
      {canAdmin ? <><SectionTitle>Administration</SectionTitle><NavRow title="Administration" subtitle="Users, prices, audit log, notification rules" to="/admin" /></> : null}
      <SectionTitle>Account</SectionTitle>
      <NavRow title="Settings and security" subtitle="Password, two-step sign-in, devices, biometric lock" to="/settings" />
    </Screen>
  );
}
