import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { describeError } from '../../lib/errors';
import { newPassword, required, sameAs, useForm } from '../../lib/validation';
import { useApp } from '../../state/app';
import { AuthShell } from '../../ui/auth-shell';
import { SuccessPanel } from '../../ui/brand';
import { Button, Field, InlineError } from '../../ui/components';
import { space } from '../../ui/theme';

/** Opened from the e-mailed link (makarifor://reset-password?token=…) or by pasting the code from the e-mail. */
export default function ResetPassword() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const { services } = useApp();
  const form = useForm(
    { token: typeof params.token === 'string' ? params.token : '', password: '', confirm: '' },
    {
      token: [required('Paste the reset code from your email.')],
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
      await services.pub.post('/v1/auth/reset-password', { token: form.values.token.trim(), newPassword: form.values.password });
      setDone(true);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell back compact title={done ? 'Password changed' : 'Choose a new password'} subtitle={done ? undefined : 'Use at least 12 characters. A few unrelated words are easy to remember and hard to guess.'}>
      {done ? (
        <SuccessPanel title="You’re all set" body="Your other devices were signed out. Sign in with your new password.">
          <View style={{ alignSelf: 'stretch' }}><Button pill title="Go to sign in" icon="log-in-outline" onPress={() => router.replace('/login')} /></View>
        </SuccessPanel>
      ) : (
        <View style={{ gap: space.lg }}>
          <Field pill label="Reset code" icon="key-outline" {...form.field('token')} placeholder="Paste the code from your email" autoCapitalize="none" autoCorrect={false} />
          <Field pill label="New password" icon="lock-closed-outline" {...form.field('password')} placeholder="At least 12 characters" secureTextEntry textContentType="newPassword" />
          <Field pill label="Repeat new password" icon="lock-closed-outline" {...form.field('confirm')} placeholder="Repeat the new password" secureTextEntry textContentType="newPassword" returnKeyType="done" onSubmitEditing={() => void submit()} />
          <InlineError message={error} />
          <Button pill title="Change password" icon="checkmark" onPress={() => void submit()} busy={busy} />
        </View>
      )}
    </AuthShell>
  );
}
