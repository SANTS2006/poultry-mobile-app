import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { describeError } from '../../lib/errors';
import { email, required, useForm } from '../../lib/validation';
import { useApp } from '../../state/app';
import { AuthShell } from '../../ui/auth-shell';
import { SuccessPanel } from '../../ui/brand';
import { Button, Field, InlineError } from '../../ui/components';
import { space } from '../../ui/theme';

export default function ForgotPassword() {
  const router = useRouter();
  const { services } = useApp();
  const form = useForm({ email: '' }, { email: [required('Enter the email address you sign in with.'), email] });
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!form.submit()) return;
    setBusy(true); setError(null);
    try {
      await services.pub.post('/v1/auth/forgot-password', { email: form.values.email.trim() });
      setSent(true);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell back compact title={sent ? 'Check your email' : 'Forgot your password?'} subtitle={sent ? undefined : 'Enter your email and we’ll send you an 8-digit code, valid for 5 minutes.'}>
      {sent ? (
        <SuccessPanel title="Reset code sent" body="If an account exists for that address, we’ve emailed an 8-digit reset code. It works once, only for that address, and expires in 5 minutes.">
          <View style={{ alignSelf: 'stretch', gap: space.md }}>
            <Button pill title="I have a reset code" icon="key-outline" onPress={() => router.replace({ pathname: '/reset-password', params: { email: form.values.email.trim() } })} />
            <Button pill title="Back to sign in" variant="ghost" onPress={() => router.replace('/login')} />
          </View>
        </SuccessPanel>
      ) : (
        <View style={{ gap: space.lg }}>
          <Field pill label="Email address" icon="mail-outline" {...form.field('email')} placeholder="Enter your email address" autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" returnKeyType="send" onSubmitEditing={() => void submit()} />
          <InlineError message={error} />
          <Button pill title="Send reset code" icon="paper-plane-outline" onPress={() => void submit()} busy={busy} />
          <Button pill title="I already have a code" variant="ghost" onPress={() => router.replace('/reset-password')} />
        </View>
      )}
    </AuthShell>
  );
}
