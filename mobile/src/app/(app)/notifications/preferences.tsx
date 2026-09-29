import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Switch } from 'react-native';
import { describeError } from '../../../lib/errors';
import { registerForPush } from '../../../services/push';
import { useEndpoints } from '../../../state/app';
import { Button, Card, ErrorView, ListRow, Loading, Screen, SectionTitle, Text } from '../../../ui/components';
import { useColors } from '../../../ui/theme';

const NAMES: Record<string, string> = {
  PRODUCTION: 'Production', INVENTORY: 'Stock alerts', SALES: 'Sales', EXPENSES: 'Expenses', PAYMENTS: 'Payments', SYNC: 'Sync results',
  DAILY_SUMMARY: 'Daily summary', SECURITY: 'Security alerts', ADMIN: 'Administration', SYSTEM: 'System notices',
};

export default function NotificationPreferences() {
  const api = useEndpoints();
  const qc = useQueryClient();
  const c = useColors();
  const q = useQuery({ queryKey: ['notifications', 'preferences'], queryFn: () => api.notifications.preferences() });
  const [busy, setBusy] = useState(false);

  async function toggle(category: string, enabled: boolean) {
    try {
      await api.notifications.setPreferences([{ category, enabled }]);
      await qc.invalidateQueries({ queryKey: ['notifications', 'preferences'] });
    } catch (e) { Alert.alert('Could not save', describeError(e)); }
  }

  async function enablePush() {
    setBusy(true);
    const r = await registerForPush(api, true);
    setBusy(false);
    if (r.ok) {
      try { const t = await api.notifications.test(); Alert.alert('Push notifications are on', t.provider === 'none' ? 'This server is not configured to send push messages yet, but in-app notifications work.' : 'A test notification is on its way to this phone.'); }
      catch (e) { Alert.alert('Push is on', describeError(e)); }
    } else Alert.alert('Push notifications are not on', ({
      not_a_device: 'Push notifications need a real phone (not a simulator).', permission_denied: 'Notifications are blocked for this app. Turn them on in your phone settings.',
      no_project_id: 'This build has no push project configured. Ask your administrator.', error: r.detail ?? 'Something went wrong.',
    } as const)[r.reason]);
  }

  return (
    <Screen padded={false}>
      <Card style={{ margin: 16 }}>
        <Text bold>Push notifications on this phone</Text>
        <Text muted>Lock-screen messages are deliberately generic (no amounts or names). Details appear inside the app.</Text>
        <Button title="Turn on / send a test" variant="secondary" onPress={() => void enablePush()} busy={busy} />
      </Card>
      <SectionTitle>What you are notified about</SectionTitle>
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /> : null}
      {q.data?.preferences.map((p) => (
        <ListRow
          key={p.category} title={NAMES[p.category] ?? p.category} subtitle={p.mutable ? undefined : 'Always on for your safety'}
          right={<Switch value={p.enabled} disabled={!p.mutable} onValueChange={(v) => void toggle(p.category, v)} trackColor={{ true: c.primary }} accessibilityLabel={NAMES[p.category] ?? p.category} />}
        />
      ))}
    </Screen>
  );
}
