import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { describeError } from '../../lib/errors';
import { validatePassword } from '../../lib/password';
import { useApp } from '../../state/app';
import { Button, Card, Field, Screen, Text } from '../../ui/components';

/** Opened from the e-mailed link (makarifor://reset-password?token=…) or by pasting the token from the e-mail. */
export default function ResetPassword() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const { services } = useApp();
  const [token, setToken] = useState(typeof params.token === 'string' ? params.token : '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const problems = validatePassword(password);
    if (!token.trim()) return setError('Paste the reset code from your email.');
    if (problems.length) return setError(problems[0]);
    if (password !== confirm) return setError('The two passwords do not match.');
    setBusy(true); setError(null);
    try {
      await services.pub.post('/v1/auth/reset-password', { token: token.trim(), newPassword: password });
      setDone(true);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Screen>
        <Card tone="ok"><Text bold>Password changed</Text><Text>All your other sessions were signed out. Sign in with the new password.</Text></Card>
        <Button title="Go to sign in" onPress={() => router.replace('/login')} />
      </Screen>
    );
  }
  return (
    <Screen>
      <Field label="Reset code" value={token} onChangeText={setToken} autoCapitalize="none" autoCorrect={false} />
      <Field label="New password" value={password} onChangeText={setPassword} secureTextEntry hint="At least 12 characters. A few random words works well." textContentType="newPassword" />
      <Field label="Repeat new password" value={confirm} onChangeText={setConfirm} secureTextEntry textContentType="newPassword" error={error} />
      <Button title="Change password" onPress={() => void submit()} busy={busy} />
    </Screen>
  );
}
