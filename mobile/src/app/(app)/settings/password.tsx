import { useState } from 'react';
import { Alert } from 'react-native';
import { describeError } from '../../../lib/errors';
import { validatePassword } from '../../../lib/password';
import { useApp, useEndpoints } from '../../../state/app';
import { useAppStore } from '../../../state/store';
import { Button, Card, Field, Screen, Text } from '../../../ui/components';

export default function ChangePassword() {
  const api = useEndpoints();
  const { services } = useApp();
  const email = useAppStore((s) => s.user?.email);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const problems = validatePassword(next, email);
    if (!current) return setError('Enter your current password.');
    if (problems.length) return setError(problems[0]);
    if (next !== again) return setError('The two new passwords do not match.');
    setBusy(true); setError(null);
    try {
      await api.account.changePassword(current, next);
      // The server signs every session out when the password changes; sign in again with the new one.
      Alert.alert('Password changed', 'For your security you have been signed out everywhere. Sign in again with the new password.');
      await services.session.sessionEnded();
    } catch (e) {
      setError(describeError(e));
    } finally { setBusy(false); }
  }

  return (
    <Screen>
      <Card tone="info"><Text>Changing your password signs you out on every device.</Text></Card>
      <Field label="Current password" value={current} onChangeText={setCurrent} secureTextEntry textContentType="password" />
      <Field label="New password" value={next} onChangeText={setNext} secureTextEntry textContentType="newPassword" hint="At least 12 characters." />
      <Field label="Repeat new password" value={again} onChangeText={setAgain} secureTextEntry textContentType="newPassword" error={error} />
      <Button title="Change password" onPress={() => void save()} busy={busy} />
    </Screen>
  );
}
