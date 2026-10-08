import { useRouter } from 'expo-router';
import { useState } from 'react';
import { describeError } from '../../lib/errors';
import { minLength, required, useForm, type Rule } from '../../lib/validation';
import { useApp } from '../../state/app';
import { useAuthFlow } from '../../state/auth-flow';
import { AuthHeader } from '../../ui/brand';
import { Button, Field, InlineError, Screen } from '../../ui/components';

export default function MfaVerify() {
  const router = useRouter();
  const { services } = useApp();
  const flow = useAuthFlow();
  const [recovery, setRecovery] = useState(false);
  const sixDigits: Rule = (v) => (!v.trim() || /^\d{6}$/.test(v.trim()) ? null : 'The code is 6 digits, like 123456.');
  const form = useForm({ code: '' }, { code: [required(recovery ? 'Enter one of your recovery codes.' : 'Enter the 6-digit code from your authenticator app.'), recovery ? minLength(8, 'A recovery code is at least 8 characters.') : sixDigits] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const token = flow.mfaToken;
    if (!token) { router.replace('/login'); return; }
    if (!form.submit()) return;
    const value = form.values.code.trim();
    setBusy(true); setError(null);
    try {
      await services.session.verifyMfa(token, recovery ? { recoveryCode: value } : { code: value });
      flow.clear();
    } catch (e) {
      setError(describeError(e));
      form.set('code', '');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <AuthHeader
        icon={recovery ? 'document-lock-outline' : 'shield-checkmark-outline'} title={recovery ? 'Use a recovery code' : 'Two-step verification'}
        subtitle={recovery ? 'Each recovery code works only once.' : 'Open your authenticator app and enter the 6-digit code shown for Makarifor.'}
      />
      <Field
        label={recovery ? 'Recovery code' : '6-digit code'} icon={recovery ? 'key-outline' : 'keypad-outline'} {...form.field('code')} onChangeText={(t) => { form.field('code').onChangeText(t); setError(null); }} autoFocus autoCapitalize="none" autoCorrect={false}
        keyboardType={recovery ? 'default' : 'number-pad'} maxLength={recovery ? 32 : 6} textContentType="oneTimeCode" autoComplete="one-time-code"
        onSubmitEditing={() => void submit()}
      />
      <InlineError message={error} />
      <Button title="Verify and sign in" icon="checkmark" onPress={() => void submit()} busy={busy} />
      <Button title={recovery ? 'Use authenticator code instead' : 'Use a recovery code'} variant="ghost" onPress={() => { setRecovery(!recovery); form.reset(); setError(null); }} />
      <Button title="Cancel" variant="ghost" onPress={() => { flow.clear(); router.replace('/login'); }} />
    </Screen>
  );
}
