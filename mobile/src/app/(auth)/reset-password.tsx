import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { describeError } from '../../lib/errors';
import { digits, email as emailRule, newPassword, required, sameAs, useForm } from '../../lib/validation';
import { useApp } from '../../state/app';
import { AuthShell } from '../../ui/auth-shell';
import { SuccessPanel } from '../../ui/brand';
import { Button, Card, Field, InlineError, Text } from '../../ui/components';
import { useSecureScreen } from '../../ui/secure-screen';
import { space } from '../../ui/theme';

/**
 * Choose a new password with the 8-digit code from the email. The code works once, for that email address only, for 5 minutes, and is locked
 * after 5 wrong tries.
 */
export default function ResetPassword() {
  useSecureScreen();
  const router = useRouter();
  const params = useLocalSearchParams<{ email?: string }>();
  const { services } = useApp();
  const form = useForm(
    { email: typeof params.email === 'string' ? params.email : '', code: '', password: '', confirm: '' },
    {
      email: [required('Enter the email address the code was sent to.'), emailRule],
      code: [required('Enter the 8-digit code from the email.'), digits(8, 'The code is 8 digits, like 1234 5678.')],
      password: [required('Choose a new password.'), newPassword()],
      confirm: [required('Repeat the new password.'), sameAs('password', 'The two passwords don’t match.')],
    },
  );
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!form.submit()) return;
    setBusy(true); setError(null);
    try {
      await services.pub.post('/v1/auth/reset-password', { email: form.values.email.trim(), code: form.values.code.replace(/\s+/g, ''), newPassword: form.values.password });
      setDone(true);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const code = form.field('code');
  return (
    <AuthShell back compact title={done ? 'Password changed' : 'Choose a new password'} subtitle={done ? undefined : 'Enter the 8-digit code we emailed you. It works once and is valid for 5 minutes.'}>
      {done ? (
        <SuccessPanel title="You’re all set" body="Your other devices were signed out. Sign in with your new password.">
          <View style={{ alignSelf: 'stretch' }}><Button pill title="Go to sign in" icon="log-in-outline" onPress={() => router.replace('/login')} /></View>
        </SuccessPanel>
      ) : (
        <View style={{ gap: space.lg }}>
          <Field pill label="Email address" icon="mail-outline" {...form.field('email')} placeholder="The address the code was sent to" autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" />
          <Field pill label="Reset code" icon="keypad-outline" {...code} onChangeText={(t) => code.onChangeText(t.replace(/[^\d ]/g, ''))} placeholder="8 digits" keyboardType="number-pad" maxLength={9} textContentType="oneTimeCode" autoComplete="one-time-code" />
          <Field pill label="New password" icon="lock-closed-outline" {...form.field('password')} placeholder="At least 12 characters" secureTextEntry textContentType="newPassword" />
          <Field pill label="Repeat new password" icon="lock-closed-outline" {...form.field('confirm')} placeholder="Repeat the new password" secureTextEntry textContentType="newPassword" returnKeyType="done" onSubmitEditing={() => void submit()} />
          <Card tone="info"><Text variant="caption">After 5 wrong codes, or after 5 minutes, the code stops working and you need to ask for a new one.</Text></Card>
          <InlineError message={error} />
          <Button pill title="Change password" icon="checkmark" onPress={() => void submit()} busy={busy} />
          <Button pill title="Send me a new code" variant="ghost" onPress={() => router.replace('/forgot-password')} />
        </View>
      )}
    </AuthShell>
  );
}
