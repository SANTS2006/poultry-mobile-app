import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Switch, View } from 'react-native';
import type { NotificationPreference } from '../../../api/types';
import { describeError } from '../../../lib/errors';
import { CATEGORY_ICON, CATEGORY_INFO, categoryName } from '../../../lib/notification-meta';
import { registerForPush } from '../../../services/push';
import { useEndpoints } from '../../../state/app';
import { Button, Card, ErrorView, ListRow, Loading, Screen, SectionHeader, Text } from '../../../ui/components';
import { space, useColors } from '../../../ui/theme';

export default function NotificationPreferences() {
  const api = useEndpoints();
  const qc = useQueryClient();
  const c = useColors();
  const q = useQuery({ queryKey: ['notifications', 'preferences'], queryFn: () => api.notifications.preferences() });
  const [busy, setBusy] = useState(false);

  /** Flips the switch straight away and puts it back if the server says no. */
  async function toggle(category: string, enabled: boolean) {
    const key = ['notifications', 'preferences'];
    const before = qc.getQueryData<{ preferences: NotificationPreference[] }>(key);
    qc.setQueryData(key, before && { preferences: before.preferences.map((p) => (p.category === category ? { ...p, enabled } : p)) });
    try {
      await api.notifications.setPreferences([{ category, enabled }]);
    } catch (e) {
      qc.setQueryData(key, before);
      Alert.alert('Could not save', describeError(e));
    }
  }

  async function enablePush() {
    setBusy(true);
    const r = await registerForPush(api, true);
    setBusy(false);
    if (r.ok) {
      try { const t = await api.notifications.test(); Alert.alert('Push notifications are on', t.provider === 'none' ? 'This server is not configured to send push messages yet, but in-app notifications work.' : 'A test notification is on its way to this phone.'); }
      catch (e) { Alert.alert('Push is on', describeError(e)); }
    } else Alert.alert('Push notifications are not on', ({
      expo_go: 'Push notifications do not work inside Expo Go (a limit of Expo Go). In-app notifications still work. Use a development build for push.', not_a_device: 'Push notifications need a real phone (not a simulator).', permission_denied: 'Notifications are blocked for this app. Turn them on in your phone settings.',
      no_project_id: 'This build has no push project configured. Ask your administrator.', error: r.detail ?? 'Something went wrong.',
    } as const)[r.reason]);
  }

  return (
    <Screen>
      <Card style={{ gap: space.md }}>
        <Text variant="heading">Push notifications on this phone</Text>
        <Text muted>Lock-screen messages are deliberately generic (no amounts or names). Details appear inside the app.</Text>
        <Button title="Turn on / send a test" icon="notifications-outline" variant="secondary" onPress={() => void enablePush()} busy={busy} />
      </Card>

      <View style={{ gap: space.md }}>
        <SectionHeader title="What you are notified about" />
        {q.isLoading ? <Loading /> : null}
        {q.error ? <ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /> : null}
        {q.data ? (
          <Card style={{ padding: 0, gap: 0, overflow: 'hidden' }}>
            {q.data.preferences.map((p) => (
              <ListRow
                key={p.category} icon={CATEGORY_ICON[p.category]} title={categoryName(p.category)}
                subtitle={p.mutable ? CATEGORY_INFO[p.category]?.hint : 'Always on for your safety'}
                right={<Switch value={p.enabled} disabled={!p.mutable} onValueChange={(v) => void toggle(p.category, v)} trackColor={{ true: c.primary }} accessibilityLabel={categoryName(p.category)} />}
              />
            ))}
          </Card>
        ) : null}
      </View>
    </Screen>
  );
}
