import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { useUnreadCount } from '../../../queries/hooks';
import { useAppStore, useCan, useCanAny } from '../../../state/store';
import { Avatar, Badge, Card, NavRow, Screen, SectionHeader, Text } from '../../../ui/components';
import { Icon } from '../../../ui/icon';
import { space, useColors } from '../../../ui/theme';

const role = (r: string) => r.toLowerCase().replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());

/** Grouped by intent: what you do, what needs checking, administration, your account. */
export default function More() {
  const router = useRouter();
  const c = useColors();
  const user = useAppStore((s) => s.user);
  const sync = useAppStore((s) => s.sync);
  const unread = useUnreadCount().data?.unread ?? 0;
  const attention = sync ? sync.conflict + sync.rejected + sync.blocked : 0;
  const waiting = sync ? sync.pending + sync.syncing : 0;
  const canCustomers = useCan('customers.read');
  const canExpenses = useCan('expenses.read');
  const canReports = useCan('reports.read');
  const canAdmin = useCanAny('users.manage', 'audit.read', 'prices.manage', 'notifications.manage');
  const group = { padding: 0, gap: 0, overflow: 'hidden' } as const;

  return (
    <Screen>
      <Pressable accessibilityRole="button" accessibilityLabel="Open my profile and settings" onPress={() => router.push('/settings')}>
        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Avatar name={user?.fullName ?? '?'} uri={user?.avatar} size={56} />
          <View style={{ flex: 1, gap: space.xs }}>
            <Text variant="heading" numberOfLines={1}>{user?.fullName}</Text>
            <Text variant="caption" muted numberOfLines={1}>{user?.email}</Text>
            <Badge tone="muted" label={user?.roles.map(role).join(', ') ?? ''} />
          </View>
          <Icon name="chevron-forward" size="sm" color={c.muted} />
        </Card>
      </Pressable>

      <View style={{ gap: space.md }}>
        <SectionHeader title="Keep on top of things" />
        <Card style={group}>
          <NavRow icon="notifications-outline" title="Notifications" subtitle="Alerts and daily summary" to="/notifications" badge={unread > 0 ? <Badge tone="info" label={`${unread} unread`} /> : undefined} />
          <NavRow icon="sync-outline" title="Sync" subtitle="Records saved on this phone" to="/sync" badge={attention > 0 ? <Badge tone="danger" label={`${attention} need attention`} /> : waiting > 0 ? <Badge tone="info" label={`${waiting} waiting to send`} /> : undefined} />
        </Card>
      </View>

      {(canCustomers || canExpenses || canReports) ? (
        <View style={{ gap: space.md }}>
          <SectionHeader title="Business" />
          <Card style={group}>
            {canCustomers ? <NavRow icon="people-outline" title="Customers" subtitle="Contacts, credit and balances" to="/customers" /> : null}
            {canExpenses ? <NavRow icon="wallet-outline" title="Expenses" subtitle="Feed, labour, transport and more" to="/expenses" /> : null}
            {canReports ? <NavRow icon="stats-chart-outline" title="Reports" subtitle="Production, sales, stock and cash flow" to="/reports" /> : null}
          </Card>
        </View>
      ) : null}

      {canAdmin ? (
        <View style={{ gap: space.md }}>
          <SectionHeader title="Administration" />
          <Card style={group}><NavRow icon="settings-outline" title="Administration" subtitle="Users, prices, audit log, notification rules" to="/admin" /></Card>
        </View>
      ) : null}

      <View style={{ gap: space.md }}>
        <SectionHeader title="Account" />
        <Card style={group}><NavRow icon="shield-checkmark-outline" title="Settings and security" subtitle="Password, two-step sign-in, devices, app lock" to="/settings" /></Card>
      </View>
    </Screen>
  );
}
