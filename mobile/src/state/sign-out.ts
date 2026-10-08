import { useState } from 'react';
import { describeError } from '../lib/errors';
import { unregisterPush } from '../services/push';
import { UnsyncedDataError } from '../services/session-manager';
import { useDialog } from '../ui/dialog';
import { withBusyOverlay } from '../ui/loaders';
import { useApp, useEndpoints } from './app';

/**
 * Signs out, refusing (with an explicit choice) while records saved on this phone have not been sent yet. Shows a "Signing you out…"
 * overlay while it works. Shared by Settings and the profile menu so both behave identically.
 */
export function useSignOut(): { signOut: () => void; busy: boolean } {
  const { services } = useApp();
  const api = useEndpoints();
  const dialog = useDialog();
  const [busy, setBusy] = useState(false);

  async function run(): Promise<void> {
    setBusy(true);
    try {
      // Check for unsent records BEFORE touching anything, so a refused sign-out leaves the session (and push) intact.
      const { unsynced } = await services.engine.summary();
      let discard = false;
      if (unsynced > 0) {
        const go = await dialog.confirm({ title: 'Records not sent yet', message: new UnsyncedDataError(unsynced, false).message, tone: 'warn', confirmLabel: 'Sign out and discard them', cancelLabel: 'Stay signed in', destructive: true });
        if (!go) return;
        discard = true;
      }
      await withBusyOverlay('Signing you out…', async () => {
        await unregisterPush(api);
        await services.session.logout({ discardUnsynced: discard });
      });
    } catch (e) {
      await dialog.notify({ title: 'Could not sign out', message: describeError(e), tone: 'danger' });
    } finally { setBusy(false); }
  }

  return { signOut: () => { void run(); }, busy };
}
