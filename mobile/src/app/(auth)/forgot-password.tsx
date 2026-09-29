import { useRouter } from 'expo-router';
import { useState } from 'react';
import { describeError } from '../../lib/errors';
import { useApp } from '../../state/app';
import { Button, Card, Field, Screen, Text } from '../../ui/components';

export default function ForgotPassword() {
  const router = useRouter();
  const { services } = useApp();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!email.trim()) { setError('Enter your email address.'); return; }
    setBusy(true); setError(null);
    try {
      await services.pub.post('/v1/auth/forgot-password', { email: email.trim() });
      setSent(true);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      {sent ? (
        <Card tone="ok">
          <Text bold>Check your email</Text>
          <Text>If an account exists for that address, we have sent a link to reset the password. The link works once and expires soon.</Text>
          <Button title="I have a reset code" variant="secondary" onPress={() => router.replace('/reset-password')} />
        </Card>
      ) : (
        <>
          <Text muted>Enter the email address of your account. We will send a reset link if it exists.</Text>
          <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" error={error} />
          <Button title="Send reset link" onPress={() => void submit()} busy={busy} />
        </>
      )}
    </Screen>
  );
}
