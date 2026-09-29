import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { describeError } from '../../lib/errors';
import { validatePassword } from '../../lib/password';
import { useApp } from '../../state/app';
import { Button, Card, Field, Screen, Text } from '../../ui/components';

/** New staff accounts are created by an administrator; the invitation link lets the person choose their own password. */
export default function AcceptInvite() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const { services } = useApp();
  const [token, setToken] = useState(typeof params.token === 'string' ? params.token : '');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const problems = validatePassword(password);
    if (!token.trim()) return setError('Paste the invitation code from your email.');
    if (problems.length) return setError(problems[0]);
    if (password !== confirm) return setError('The two passwords do not match.');
    setBusy(true); setError(null);
    try {
      await services.pub.post('/v1/auth/accept-invite', { token: token.trim(), password, ...(fullName.trim() ? { fullName: fullName.trim() } : {}) });
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
        <Card tone="ok"><Text bold>Account ready</Text><Text>You can now sign in with your email and the password you chose.</Text></Card>
        <Button title="Go to sign in" onPress={() => router.replace('/login')} />
      </Screen>
    );
  }
  return (
    <Screen>
      <Field label="Invitation code" value={token} onChangeText={setToken} autoCapitalize="none" autoCorrect={false} />
      <Field label="Your full name (optional)" value={fullName} onChangeText={setFullName} autoCapitalize="words" />
      <Field label="Choose a password" value={password} onChangeText={setPassword} secureTextEntry hint="At least 12 characters." textContentType="newPassword" />
      <Field label="Repeat password" value={confirm} onChangeText={setConfirm} secureTextEntry textContentType="newPassword" error={error} />
      <Button title="Create my account" onPress={() => void submit()} busy={busy} />
    </Screen>
  );
}
