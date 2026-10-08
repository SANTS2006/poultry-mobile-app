import { useRouter } from 'expo-router';
import { Pressable, Switch, View } from 'react-native';
import { APP_ENV, APP_VERSION } from '../../../config';
import { IS_EXPO_GO } from '../../../lib/runtime';
import { authenticateLocally, biometricsAvailable } from '../../../services/biometrics';
import { useApp } from '../../../state/app';
import { useSignOut } from '../../../state/sign-out';
import { useDialog } from '../../../ui/dialog';
import type { ThemeMode } from '../../../state/theme-pref';
import { useThemeMode } from '../../../state/use-theme-mode';
import { useAppStore } from '../../../state/store';
import { Avatar, Badge, Button, Card, ListRow, Screen, SectionHeader, Segmented, Text } from '../../../ui/components';
import { Icon } from '../../../ui/icon';
import { space, useColors } from '../../../ui/theme';

const BIOMETRIC_PREF = 'pref.biometricLock';

export default function Settings() {
  const router = useRouter();
  const c = useColors();
  const { services } = useApp();
  const user = useAppStore((s) => s.user);
  const bio = useAppStore((s) => s.biometricLock);
  const { signOut, busy } = useSignOut();
  const theme = useThemeMode();
  const dialog = useDialog();
  const group = { padding: 0, gap: 0, overflow: 'hidden' } as const;

  async function toggleBiometric(on: boolean) {
    if (on) {
      if (!(await biometricsAvailable())) return void dialog.notify({ title: 'Not available', message: 'Set up a fingerprint, face or screen lock in your phone settings first.', tone: 'warn' });
      if (!(await authenticateLocally('Confirm to turn on the app lock'))) return;
    }
    await services.secure.set(BIOMETRIC_PREF, on ? '1' : '0');
    useAppStore.getState().setBiometricLock(on);
  }

  return (
    <Screen>
      <Pressable accessibilityRole="button" accessibilityLabel="Edit my profile" onPress={() => router.push('/settings/profile' as never)}>
        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Avatar name={user?.fullName ?? '?'} uri={user?.avatar} size={64} />
          <View style={{ flex: 1, gap: space.xs }}>
            <Text variant="heading" numberOfLines={1}>{user?.fullName}</Text>
            <Text variant="caption" muted numberOfLines={1}>{user?.email}</Text>
            <Badge tone={user?.mfaEnabled ? 'ok' : 'warn'} label={user?.mfaEnabled ? 'Two-step sign-in on' : 'Two-step sign-in off'} />
          </View>
          <Icon name="chevron-forward" size="sm" color={c.muted} />
        </Card>
      </Pressable>

      {IS_EXPO_GO || !services.dbEncrypted ? (
        <Card tone="warn">
          <Text variant="heading">{IS_EXPO_GO ? 'Running in Expo Go (testing only)' : 'Local database is not encrypted'}</Text>
          <Text>{services.dbEncrypted ? '' : 'Records saved on this phone are stored unencrypted. '}Remote push notifications are unavailable. Use a development or store build for real work.</Text>
        </Card>
      ) : null}

      <View style={{ gap: space.md }}>
        <SectionHeader title="Account" />
        <Card style={group}>
          <ListRow icon="person-outline" title="Edit profile" subtitle="Photo and name" onPress={() => router.push('/settings/profile' as never)} />
          <ListRow icon="mail-outline" title="Email address" subtitle={user?.pendingEmail ? `Waiting to confirm ${user.pendingEmail}` : user?.email} onPress={() => router.push('/settings/email' as never)} />
          <ListRow icon="key-outline" title="Change password" subtitle="Signs you out on every device" onPress={() => router.push('/settings/password')} />
        </Card>
      </View>

      <View style={{ gap: space.md }}>
        <SectionHeader title="Security" />
        <Card style={group}>
          <ListRow icon="shield-checkmark-outline" title="Two-step sign-in" subtitle={user?.mfaEnabled ? 'On · manage recovery codes' : 'Off · add an authenticator app'} onPress={() => router.push('/settings/mfa')} />
          <ListRow icon="phone-portrait-outline" title="Devices and sessions" subtitle="See where you are signed in" onPress={() => router.push('/settings/sessions')} />
          <ListRow
            icon="finger-print-outline" title="App lock" subtitle="Ask for fingerprint or face when you return"
            right={<Switch value={bio} onValueChange={(v) => void toggleBiometric(v)} trackColor={{ true: c.primary }} accessibilityLabel="Biometric app lock" />}
          />
        </Card>
      </View>

      <View style={{ gap: space.md }}>
        <SectionHeader title="Appearance" />
        <Card style={{ gap: space.md }}>
          <Segmented<ThemeMode> label="Theme" value={theme.mode} onChange={theme.setMode} options={[{ value: 'system', label: 'Same as phone' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
          <Text variant="caption" muted>Dark mode is easier on the eyes at night and saves battery on OLED screens.</Text>
        </Card>
      </View>

      <View style={{ gap: space.md }}>
        <SectionHeader title="Notifications" />
        <Card style={group}><ListRow icon="notifications-outline" title="Notification settings" subtitle="Choose what you hear about" onPress={() => router.push('/notifications/preferences')} /></Card>
      </View>

      <Button title="Sign out" variant="secondary" icon="log-out-outline" onPress={signOut} busy={busy} />
      <View style={{ alignItems: 'center', gap: space.xs }}>
        <Icon name="egg" size="sm" color={c.muted} />
        <Text variant="caption" muted>Makarifor Poultry {APP_VERSION}{APP_ENV !== 'production' ? ` · ${APP_ENV}` : ''}</Text>
      </View>
    </Screen>
  );
}
