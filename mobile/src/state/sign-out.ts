import { useState } from 'react';
import { Alert } from 'react-native';
import { describeError } from '../lib/errors';
import { unregisterPush } from '../services/push';
import { UnsyncedDataError } from '../services/session-manager';
import { useApp, useEndpoints } from './app';

/**
 * Signs out, refusing (with an explicit choice) while records saved on this phone have not been sent yet. Shared by Settings and the
 * profile menu so both behave identically.
 */
export function useSignOut(): { signOut: () => void; busy: boolean } {
  const { services } = useApp();
  const api = useEndpoints();
  const [busy, setBusy] = useState(false);

  async function run(discard: boolean): Promise<void> {
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
          { text: 'Sign out and discard them', style: 'destructive', onPress: () => void run(true) },
        ]);
      } else Alert.alert('Could not sign out', describeError(e));
    } finally { setBusy(false); }
  }

  return { signOut: () => { void run(false); }, busy };
}
