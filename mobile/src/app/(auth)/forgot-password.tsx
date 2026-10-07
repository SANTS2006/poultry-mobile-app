import { useRouter } from 'expo-router';
import { useState } from 'react';
import { describeError } from '../../lib/errors';
import { useApp } from '../../state/app';
import { AuthHeader, SuccessPanel } from '../../ui/brand';
import { Button, Field, InlineError, Screen } from '../../ui/components';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function ForgotPassword() {
  const router = useRouter();
  const { services } = useApp();
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!EMAIL_RE.test(email.trim())) { setFieldError('Enter the email address you sign in with.'); return; }
    setBusy(true); setError(null); setFieldError(null);
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
        <SuccessPanel title="Check your email" body="If an account exists for that address, we’ve sent a link to reset the password. The link works once and expires soon.">
          <Button title="I have a reset code" variant="secondary" icon="key-outline" onPress={() => router.replace('/reset-password')} />
          <Button title="Back to sign in" variant="ghost" onPress={() => router.replace('/login')} />
        </SuccessPanel>
      ) : (
        <>
          <AuthHeader icon="key-outline" title="Forgot your password?" subtitle="Enter your email and we’ll send you a link to choose a new one." />
          <Field label="Email" icon="mail-outline" value={email} onChangeText={(t) => { setEmail(t); setFieldError(null); }} error={fieldError} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" returnKeyType="send" onSubmitEditing={() => void submit()} autoFocus />
          <InlineError message={error} />
          <Button title="Send reset link" icon="paper-plane-outline" onPress={() => void submit()} busy={busy} />
        </>
      )}
    </Screen>
  );
}
