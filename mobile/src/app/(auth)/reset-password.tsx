import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { describeError } from '../../lib/errors';
import { validatePassword } from '../../lib/password';
import { useApp } from '../../state/app';
import { AuthHeader, SuccessPanel } from '../../ui/brand';
import { Button, Field, InlineError, Screen } from '../../ui/components';

/** Opened from the e-mailed link (makarifor://reset-password?token=…) or by pasting the token from the e-mail. */
export default function ResetPassword() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const { services } = useApp();
  const [token, setToken] = useState(typeof params.token === 'string' ? params.token : '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errs, setErrs] = useState<{ token?: string; password?: string; confirm?: string }>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const next = {
      token: token.trim() ? undefined : 'Paste the reset code from your email.',
      password: validatePassword(password)[0],
      confirm: password === confirm ? undefined : 'The two passwords don’t match.',
    };
    setErrs(next);
    if (next.token || next.password || next.confirm) return;
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
        <SuccessPanel title="Password changed" body="Your other devices were signed out. Sign in with your new password.">
          <Button title="Go to sign in" icon="log-in-outline" onPress={() => router.replace('/login')} />
        </SuccessPanel>
      </Screen>
    );
  }
  return (
    <Screen>
      <AuthHeader icon="lock-open-outline" title="Choose a new password" subtitle="Use at least 12 characters. A few unrelated words is easy to remember and hard to guess." />
      <Field label="Reset code" icon="key-outline" value={token} onChangeText={(t) => { setToken(t); setErrs((e) => ({ ...e, token: undefined })); }} error={errs.token} autoCapitalize="none" autoCorrect={false} />
      <Field label="New password" icon="lock-closed-outline" value={password} onChangeText={(t) => { setPassword(t); setErrs((e) => ({ ...e, password: undefined })); }} error={errs.password} secureTextEntry textContentType="newPassword" />
      <Field label="Repeat new password" icon="lock-closed-outline" value={confirm} onChangeText={(t) => { setConfirm(t); setErrs((e) => ({ ...e, confirm: undefined })); }} error={errs.confirm} secureTextEntry textContentType="newPassword" returnKeyType="done" onSubmitEditing={() => void submit()} />
      <InlineError message={error} />
      <Button title="Change password" icon="checkmark" onPress={() => void submit()} busy={busy} />
    </Screen>
  );
}
