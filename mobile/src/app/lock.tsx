import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { describeError } from '../lib/errors';
import { authenticateLocally } from '../services/biometrics';
import { useApp } from '../state/app';
import { useAppStore } from '../state/store';
import { BrandMark } from '../ui/brand';
import { Button, InlineError, Text } from '../ui/components';
import { space, useColors } from '../ui/theme';

/** Shown instead of the app while the biometric lock is engaged. Data is not rendered behind it. */
export default function LockScreen() {
  const c = useColors();
  const { services } = useApp();
  const user = useAppStore((s) => s.user);
  const [failed, setFailed] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const unlock = async () => {
    const ok = await authenticateLocally();
    setFailed(!ok);
    if (ok) useAppStore.getState().setLocked(false);
  };

  useEffect(() => {
    let live = true;
    void authenticateLocally().then((ok) => { if (!live) return; setFailed(!ok); if (ok) useAppStore.getState().setLocked(false); });
    return () => { live = false; };
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.lg }}>
      <BrandMark size={72} />
      <Text variant="title" accessibilityRole="header">App locked</Text>
      <Text muted style={{ textAlign: 'center' }}>{user?.fullName ?? 'Makarifor Poultry'}, unlock with your fingerprint, face or phone passcode.</Text>
      <InlineError message={failed ? 'We couldn’t verify you. Try again.' : null} />
      <Button title="Unlock" icon="finger-print-outline" onPress={() => void unlock()} />
      <InlineError message={signOutError} />
      <Button title="Sign out instead" variant="ghost" onPress={() => { services.session.logout().catch((e: unknown) => setSignOutError(describeError(e))); }} />
    </View>
  );
}
