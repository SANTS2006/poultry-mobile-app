import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { describeError } from '../lib/errors';
import { authenticateLocally } from '../services/biometrics';
import { useApp } from '../state/app';
import { useAppStore } from '../state/store';
import { Button, Text } from '../ui/components';
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
      <Text size="h1" bold>Locked</Text>
      <Text muted style={{ textAlign: 'center' }}>{user?.fullName ?? 'Makarifor Poultry'} — unlock with your fingerprint, face or phone passcode.</Text>
      {failed ? <Text color={c.danger}>Could not verify you. Try again.</Text> : null}
      <Button title="Unlock" onPress={() => void unlock()} />
      {signOutError ? <Text color={c.danger} style={{ textAlign: 'center' }}>{signOutError}</Text> : null}
      <Button
        title="Sign out instead" variant="ghost"
        onPress={() => { services.session.logout().catch((e: unknown) => setSignOutError(describeError(e))); }}
      />
    </View>
  );
}
