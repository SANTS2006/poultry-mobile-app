import { useState } from 'react';
import { Alert, Image, Linking, View } from 'react-native';
import { RecoveryCodes } from '../../../features/RecoveryCodes';
import { describeError } from '../../../lib/errors';
import { useApp, useEndpoints } from '../../../state/app';
import { useAppStore } from '../../../state/store';
import { Button, Card, Field, Screen, SectionTitle, Text } from '../../../ui/components';
import { space } from '../../../ui/theme';

type Enrolment = { secret: string; otpauthUri: string; qrCodeDataUrl: string };

export default function MfaSettings() {
  const api = useEndpoints();
  const { services } = useApp();
  const user = useAppStore((s) => s.user);
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<null | 'disable' | 'codes'>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(describeError(e)); } finally { setBusy(false); }
  };

  if (codes) return <RecoveryCodes codes={codes} onDone={() => { setCodes(null); setMode(null); setCode(''); setPassword(''); }} />;

  if (!user?.mfaEnabled) {
    return (
      <Screen>
        <Card><Text bold>Add a second step to your sign-in</Text><Text muted>You will enter a 6-digit code from an authenticator app in addition to your password. Recommended for everyone; required for owners and administrators.</Text></Card>
        {!enrolment ? (
          <Button title="Set up" busy={busy} onPress={() => void run(async () => setEnrolment(await api.account.mfaEnroll()))} />
        ) : (
          <>
            <View style={{ alignItems: 'center', gap: space.md }}>
              <Image source={{ uri: enrolment.qrCodeDataUrl }} style={{ width: 220, height: 220 }} accessibilityLabel="QR code for your authenticator app" />
              <Text size="small" muted>Or type this key into your authenticator app:</Text>
              <Text selectable bold>{enrolment.secret}</Text>
              <Button title="Open in authenticator app" variant="secondary" small onPress={() => void Linking.openURL(enrolment.otpauthUri).catch(() => undefined)} />
            </View>
            <Field label="6-digit code" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} error={error} />
            <Button title="Turn on" busy={busy} onPress={() => void run(async () => {
              const r = await api.account.mfaConfirm(code.trim());
              await services.session.refreshProfile();
              setEnrolment(null); setCodes(r.recoveryCodes);
            })} />
          </>
        )}
      </Screen>
    );
  }

  return (
    <Screen>
      <Card tone="ok"><Text bold>Two-step sign-in is on</Text></Card>
      {mode === null ? (
        <>
          <Button title="Get new recovery codes" variant="secondary" onPress={() => setMode('codes')} />
          <Button title="Turn off two-step sign-in" variant="danger" onPress={() => setMode('disable')} />
          <Text size="small" muted>Owners and administrators cannot turn it off: their role requires it.</Text>
        </>
      ) : (
        <>
          <SectionTitle>{mode === 'codes' ? 'New recovery codes' : 'Turn off two-step sign-in'}</SectionTitle>
          <Text muted>Confirm it is you: enter your password and a current code from your authenticator app.{mode === 'codes' ? ' Your old recovery codes stop working.' : ''}</Text>
          <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry />
          <Field label="6-digit code" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} error={error} />
          <Button title={mode === 'codes' ? 'Create new codes' : 'Turn off'} variant={mode === 'disable' ? 'danger' : 'primary'} busy={busy} onPress={() => void run(async () => {
            if (mode === 'codes') { setCodes((await api.account.newRecoveryCodes(password, code.trim())).recoveryCodes); return; }
            await api.account.mfaDisable(password, code.trim());
            await services.session.refreshProfile();
            setMode(null); setCode(''); setPassword('');
            Alert.alert('Two-step sign-in is off');
          })} />
          <Button title="Cancel" variant="ghost" onPress={() => { setMode(null); setError(null); }} />
        </>
      )}
    </Screen>
  );
}
