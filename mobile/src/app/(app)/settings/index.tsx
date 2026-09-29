import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Switch } from 'react-native';
import { APP_ENV, APP_VERSION } from '../../../config';
import { describeError } from '../../../lib/errors';
import { authenticateLocally, biometricsAvailable } from '../../../services/biometrics';
import { unregisterPush } from '../../../services/push';
import { UnsyncedDataError } from '../../../services/session-manager';
import { useApp, useEndpoints } from '../../../state/app';
import { useAppStore } from '../../../state/store';
import { Button, Card, ListRow, Screen, SectionTitle, Text } from '../../../ui/components';
import { useColors } from '../../../ui/theme';

const BIOMETRIC_PREF = 'pref.biometricLock';

export default function Settings() {
  const router = useRouter();
  const c = useColors();
  const { services } = useApp();
  const api = useEndpoints();
  const user = useAppStore((s) => s.user);
  const bio = useAppStore((s) => s.biometricLock);
  const [busy, setBusy] = useState(false);

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
    <Screen padded={false}>
      <Card style={{ margin: 16 }}>
        <Text bold>{user?.fullName}</Text><Text muted>{user?.email}</Text>
        <Text muted>Two-step sign-in: {user?.mfaEnabled ? 'on' : 'off'}</Text>
      </Card>
      <SectionTitle>Security</SectionTitle>
      <ListRow title="Change password" onPress={() => router.push('/settings/password')} right={<Text muted>›</Text>} />
      <ListRow title="Two-step sign-in" subtitle={user?.mfaEnabled ? 'On — manage recovery codes' : 'Off — turn on with an authenticator app'} onPress={() => router.push('/settings/mfa')} right={<Text muted>›</Text>} />
      <ListRow title="Devices and sessions" subtitle="See where you are signed in" onPress={() => router.push('/settings/sessions')} right={<Text muted>›</Text>} />
      <ListRow title="Lock app with fingerprint / face" subtitle="Asks to unlock when you return to the app" right={<Switch value={bio} onValueChange={(v) => void toggleBiometric(v)} trackColor={{ true: c.primary }} accessibilityLabel="Biometric app lock" />} />
      <SectionTitle>Notifications</SectionTitle>
      <ListRow title="Notification settings" onPress={() => router.push('/notifications/preferences')} right={<Text muted>›</Text>} />
      <Card style={{ margin: 16 }}>
        <Button title="Sign out" variant="danger" onPress={() => void signOut()} busy={busy} />
        <Text size="small" muted>Version {APP_VERSION}{APP_ENV !== 'production' ? ` · ${APP_ENV}` : ''}</Text>
      </Card>
    </Screen>
  );
}
