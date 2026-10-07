import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Switch, View } from 'react-native';
import { APP_ENV, APP_VERSION } from '../../../config';
import { describeError } from '../../../lib/errors';
import { IS_EXPO_GO } from '../../../lib/runtime';
import { authenticateLocally, biometricsAvailable } from '../../../services/biometrics';
import { unregisterPush } from '../../../services/push';
import { UnsyncedDataError } from '../../../services/session-manager';
import { useApp, useEndpoints } from '../../../state/app';
import { useAppStore } from '../../../state/store';
import { Avatar, Badge, Button, Card, ListRow, Screen, SectionHeader, Text } from '../../../ui/components';
import { Icon } from '../../../ui/icon';
import { space, useColors } from '../../../ui/theme';

const BIOMETRIC_PREF = 'pref.biometricLock';

export default function Settings() {
  const router = useRouter();
  const c = useColors();
  const { services } = useApp();
  const api = useEndpoints();
  const user = useAppStore((s) => s.user);
  const bio = useAppStore((s) => s.biometricLock);
  const [busy, setBusy] = useState(false);
  const group = { padding: 0, gap: 0, overflow: 'hidden' } as const;

  async function toggleBiometric(on: boolean) {
    if (on) {
      if (!(await biometricsAvailable())) return Alert.alert('Not available', 'Set up a fingerprint, face or screen lock in your phone settings first.');
      if (!(await authenticateLocally('Confirm to turn on the app lock'))) return;
    }
    await services.secure.set(BIOMETRIC_PREF, on ? '1' : '0');
    useAppStore.getState().setBiometricLock(on);
  }

  async function signOut(discard = false) {
    setBusy(true);
    try {
      // Check for unsent records BEFORE touching anything, so a refused sign-out leaves the session (and push) intact.
      const { unsynced } = await services.engine.summary();
      if (unsynced > 0 && !discard) throw new UnsyncedDataError(unsynced, false);
      await unregisterPush(api);
      await services.session.logout({ discardUnsynced: discard });
    } catch (e) {
      if (e instanceof UnsyncedDataError) {
        Alert.alert('Records not sent yet', e.message, [
          { text: 'Stay signed in', style: 'cancel' },
          { text: 'Sign out and discard them', style: 'destructive', onPress: () => void signOut(true) },
        ]);
      } else Alert.alert('Could not sign out', describeError(e));
    } finally { setBusy(false); }
  }

  return (
    <Screen>
      <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <Avatar name={user?.fullName ?? '?'} size={60} />
        <View style={{ flex: 1, gap: space.xs }}>
          <Text variant="heading" numberOfLines={1}>{user?.fullName}</Text>
          <Text variant="caption" muted numberOfLines={1}>{user?.email}</Text>
          <Badge tone={user?.mfaEnabled ? 'ok' : 'warn'} label={user?.mfaEnabled ? 'Two-step sign-in on' : 'Two-step sign-in off'} />
        </View>
      </Card>

      {IS_EXPO_GO || !services.dbEncrypted ? (
        <Card tone="warn">
          <Text variant="heading">{IS_EXPO_GO ? 'Running in Expo Go (testing only)' : 'Local database is not encrypted'}</Text>
          <Text>{services.dbEncrypted ? '' : 'Records saved on this phone are stored unencrypted. '}Remote push notifications are unavailable. Use a development or store build for real work.</Text>
        </Card>
      ) : null}

      <View style={{ gap: space.md }}>
        <SectionHeader title="Security" />
        <Card style={group}>
          <ListRow icon="key-outline" title="Change password" subtitle="Signs you out on every device" onPress={() => router.push('/settings/password')} />
          <ListRow icon="shield-checkmark-outline" title="Two-step sign-in" subtitle={user?.mfaEnabled ? 'On · manage recovery codes' : 'Off · add an authenticator app'} onPress={() => router.push('/settings/mfa')} />
          <ListRow icon="phone-portrait-outline" title="Devices and sessions" subtitle="See where you are signed in" onPress={() => router.push('/settings/sessions')} />
          <ListRow
            icon="finger-print-outline" title="App lock" subtitle="Ask for fingerprint or face when you return"
            right={<Switch value={bio} onValueChange={(v) => void toggleBiometric(v)} trackColor={{ true: c.primary }} accessibilityLabel="Biometric app lock" />}
          />
        </Card>
      </View>

      <View style={{ gap: space.md }}>
        <SectionHeader title="Notifications" />
        <Card style={group}><ListRow icon="notifications-outline" title="Notification settings" subtitle="Choose what you hear about" onPress={() => router.push('/notifications/preferences')} /></Card>
      </View>

      <Button title="Sign out" variant="secondary" icon="log-out-outline" onPress={() => void signOut()} busy={busy} />
      <View style={{ alignItems: 'center', gap: space.xs }}>
        <Icon name="egg" size="sm" color={c.muted} />
        <Text variant="caption" muted>Makarifor Poultry {APP_VERSION}{APP_ENV !== 'production' ? ` · ${APP_ENV}` : ''}</Text>
      </View>
    </Screen>
  );
}
