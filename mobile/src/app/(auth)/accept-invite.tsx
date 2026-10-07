import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { describeError } from '../../lib/errors';
import { validatePassword } from '../../lib/password';
import { useApp } from '../../state/app';
import { AuthHeader, SuccessPanel } from '../../ui/brand';
import { Button, Field, InlineError, Screen } from '../../ui/components';

/** New staff accounts are created by an administrator; the invitation link lets the person choose their own password. */
export default function AcceptInvite() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const { services } = useApp();
  const [token, setToken] = useState(typeof params.token === 'string' ? params.token : '');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errs, setErrs] = useState<{ token?: string; password?: string; confirm?: string }>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const next = {
      token: token.trim() ? undefined : 'Paste the invitation code from your email.',
      password: validatePassword(password)[0],
      confirm: password === confirm ? undefined : 'The two passwords don’t match.',
    };
    setErrs(next);
    if (next.token || next.password || next.confirm) return;
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
        <SuccessPanel title="Your account is ready" body="Sign in with your email and the password you just chose.">
          <Button title="Go to sign in" icon="log-in-outline" onPress={() => router.replace('/login')} />
        </SuccessPanel>
      </Screen>
    );
  }
  return (
    <Screen>
      <AuthHeader icon="mail-open-outline" title="Welcome to the team" subtitle="Paste the code from your invitation e-mail and choose your own password." />
      <Field label="Invitation code" icon="key-outline" value={token} onChangeText={(t) => { setToken(t); setErrs((e) => ({ ...e, token: undefined })); }} error={errs.token} autoCapitalize="none" autoCorrect={false} />
      <Field label="Your full name (optional)" icon="person-outline" value={fullName} onChangeText={setFullName} autoCapitalize="words" />
      <Field label="Choose a password" icon="lock-closed-outline" value={password} onChangeText={(t) => { setPassword(t); setErrs((e) => ({ ...e, password: undefined })); }} error={errs.password} hint="At least 12 characters." secureTextEntry textContentType="newPassword" />
      <Field label="Repeat password" icon="lock-closed-outline" value={confirm} onChangeText={(t) => { setConfirm(t); setErrs((e) => ({ ...e, confirm: undefined })); }} error={errs.confirm} secureTextEntry textContentType="newPassword" returnKeyType="done" onSubmitEditing={() => void submit()} />
      <InlineError message={error} />
      <Button title="Create my account" icon="checkmark" onPress={() => void submit()} busy={busy} />
    </Screen>
  );
}
