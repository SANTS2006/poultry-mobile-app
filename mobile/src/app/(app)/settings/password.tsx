import { useState } from 'react';
import { describeError } from '../../../lib/errors';
import { differentFrom, newPassword, required, sameAs, useForm } from '../../../lib/validation';
import { useApp, useEndpoints } from '../../../state/app';
import { useDialog } from '../../../ui/dialog';
import { useAppStore } from '../../../state/store';
import { Button, Card, Field, InlineError, Text } from '../../../ui/components';
import { useSecureScreen } from '../../../ui/secure-screen';
import { SheetScreen } from '../../../ui/sheet-screen';

export default function ChangePassword() {
  useSecureScreen();
  const api = useEndpoints();
  const { services } = useApp();
  const dialog = useDialog();
  const email = useAppStore((s) => s.user?.email);
  const form = useForm(
    { current: '', next: '', again: '' },
    {
      current: [required('Enter your current password.')],
      next: [required('Choose a new password.'), newPassword(() => email), differentFrom('current', 'Choose a password different from your current one.')],
      again: [required('Repeat the new password.'), sameAs('next', 'The two new passwords don’t match.')],
    },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!form.submit()) return;
    setBusy(true); setError(null);
    try {
      await api.account.changePassword(form.values.current, form.values.next);
      // The server signs every session out when the password changes; sign in again with the new one.
      await dialog.notify({ title: 'Password changed', message: 'For your security you have been signed out everywhere. Sign in again with the new password.', tone: 'success' });
      await services.session.sessionEnded();
    } catch (e) {
      setError(describeError(e));
    } finally { setBusy(false); }
  }

  return (
    <SheetScreen title="Change password">
      <Card tone="info"><Text>Changing your password signs you out on every device.</Text></Card>
      <Field label="Current password" icon="lock-closed-outline" {...form.field('current')} secureTextEntry textContentType="password" />
      <Field label="New password" icon="key-outline" {...form.field('next')} secureTextEntry textContentType="newPassword" hint="At least 12 characters." />
      <Field label="Repeat new password" icon="key-outline" {...form.field('again')} secureTextEntry textContentType="newPassword" returnKeyType="done" onSubmitEditing={() => void save()} />
      <InlineError message={error} />
      <Button title="Change password" onPress={() => void save()} busy={busy} />
    </SheetScreen>
  );
}
