import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { describeError } from '../../lib/errors';
import { newPassword, required, sameAs, useForm } from '../../lib/validation';
import { useApp } from '../../state/app';
import { useAuthFlow } from '../../state/auth-flow';
import { AuthShell } from '../../ui/auth-shell';
import { Button, Card, Field, InlineError, Text } from '../../ui/components';
import { space } from '../../ui/theme';

/**
 * First sign-in with the temporary password from the invitation e-mail. The temporary password never opens a session: it only allows
 * choosing a new one here. Afterwards sign-in continues as usual (authenticator step or a session).
 */
export default function FirstPassword() {
  const router = useRouter();
  const { services } = useApp();
  const flow = useAuthFlow();
  const form = useForm(
    { password: '', confirm: '' },
    { password: [required('Choose a new password.'), newPassword()], confirm: [required('Repeat the new password.'), sameAs('password', 'The two passwords don’t match.')] },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = flow.passwordToken;

  useEffect(() => { if (!token) router.replace('/login'); }, [token, router]);

  async function submit() {
    if (!token || !form.submit()) return;
    setBusy(true); setError(null);
    try {
      const out = await services.session.completeFirstPassword(token, form.values.password);
      flow.clear();
      if (out.kind === 'mfa_required') { flow.startMfa(out.mfaToken); router.replace('/mfa'); }
      else if (out.kind === 'mfa_setup_required') { flow.startSetup(out.setupToken); router.replace('/mfa-setup'); }
      // 'authenticated': the route guard switches to the app
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell compact title="Choose your own password" subtitle="You signed in with a temporary password. Pick a new one to finish setting up your account.">
      <Card tone="info"><Text>Use at least 12 characters. A few unrelated words are easy to remember and hard to guess. The temporary password stops working once you do this.</Text></Card>
      <View style={{ gap: space.lg }}>
        <Field pill label="New password" icon="lock-closed-outline" {...form.field('password')} placeholder="At least 12 characters" secureTextEntry textContentType="newPassword" />
        <Field pill label="Repeat new password" icon="lock-closed-outline" {...form.field('confirm')} placeholder="Repeat the new password" secureTextEntry textContentType="newPassword" returnKeyType="done" onSubmitEditing={() => void submit()} />
        <InlineError message={error} />
        <Button pill title="Save and continue" icon="checkmark" onPress={() => void submit()} busy={busy} />
        <Button pill title="Cancel" variant="ghost" onPress={() => { flow.clear(); router.replace('/login'); }} />
      </View>
    </AuthShell>
  );
}
