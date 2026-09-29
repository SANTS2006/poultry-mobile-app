import { useRouter } from 'expo-router';
import { useState } from 'react';
import { describeError } from '../../lib/errors';
import { useApp } from '../../state/app';
import { useAuthFlow } from '../../state/auth-flow';
import { Button, Card, Field, Screen, Text } from '../../ui/components';

export default function MfaVerify() {
  const router = useRouter();
  const { services } = useApp();
  const flow = useAuthFlow();
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const token = flow.mfaToken;
    if (!token) { router.replace('/login'); return; }
    const value = code.trim();
    if (!recovery && !/^\d{6}$/.test(value)) { setError('Enter the 6-digit code from your authenticator app.'); return; }
    if (recovery && value.length < 8) { setError('Enter one of your recovery codes.'); return; }
    setBusy(true); setError(null);
    try {
      await services.session.verifyMfa(token, recovery ? { recoveryCode: value } : { code: value });
      flow.clear();
    } catch (e) {
      setError(describeError(e));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Card>
        <Text bold>{recovery ? 'Use a recovery code' : 'Enter your 6-digit code'}</Text>
        <Text muted>{recovery ? 'Each recovery code works once.' : 'Open your authenticator app and type the current code for Makarifor.'}</Text>
      </Card>
      <Field
        label={recovery ? 'Recovery code' : 'Code'} value={code} onChangeText={setCode} autoFocus autoCapitalize="none" autoCorrect={false}
        keyboardType={recovery ? 'default' : 'number-pad'} maxLength={recovery ? 32 : 6} textContentType="oneTimeCode" autoComplete="one-time-code" error={error}
        onSubmitEditing={() => void submit()}
      />
      <Button title="Verify" onPress={() => void submit()} busy={busy} />
      <Button title={recovery ? 'Use authenticator code instead' : 'Use a recovery code'} variant="ghost" onPress={() => { setRecovery(!recovery); setCode(''); setError(null); }} />
      <Button title="Cancel" variant="ghost" onPress={() => { flow.clear(); router.replace('/login'); }} />
    </Screen>
  );
}
