import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, Linking, View } from 'react-native';
import { describeError } from '../../lib/errors';
import { useApp } from '../../state/app';
import { useAuthFlow } from '../../state/auth-flow';
import { Button, Card, Field, Loading, Screen, Text } from '../../ui/components';
import { space } from '../../ui/theme';

/** Privileged roles (Owner, Super Admin) must enrol before receiving a session. The setup token only authorises these two calls. */
export default function MfaSetup() {
  const router = useRouter();
  const { services } = useApp();
  const flow = useAuthFlow();
  const [enrolment, setEnrolment] = useState<{ secret: string; otpauthUri: string; qrCodeDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = flow.setupToken;
    if (!t) { router.replace('/login'); return; }
    services.session.beginMfaSetup(t).then(setEnrolment).catch((e) => setError(describeError(e)));
  }, [flow.setupToken, router, services.session]);

  async function confirm() {
    const t = flow.setupToken;
    if (!t) return;
    if (!/^\d{6}$/.test(code.trim())) { setError('Enter the 6-digit code shown in your authenticator app.'); return; }
    setBusy(true); setError(null);
    try {
      const { recoveryCodes } = await services.session.confirmMfaSetup(t, code.trim());
      // The session is already open at this point; the signed-in app shows the codes before anything else.
      flow.clear();
      useAuthFlow.getState().showRecoveryCodes(recoveryCodes);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Card>
        <Text bold>Your role requires two-step sign-in.</Text>
        <Text muted>1. Install an authenticator app (Google Authenticator, Microsoft Authenticator, Aegis…).{'\n'}2. Scan this code, or type the key.{'\n'}3. Enter the 6-digit code it shows.</Text>
      </Card>
      {!enrolment && !error ? <Loading /> : null}
      {enrolment ? (
        <View style={{ alignItems: 'center', gap: space.md }}>
          <Image source={{ uri: enrolment.qrCodeDataUrl }} style={{ width: 220, height: 220 }} accessibilityLabel="QR code for your authenticator app" />
          <Text size="small" muted>Can&apos;t scan? Type this key:</Text>
          <Text selectable bold style={{ letterSpacing: 1 }}>{enrolment.secret}</Text>
          <Button title="Open in authenticator app" variant="secondary" onPress={() => void Linking.openURL(enrolment.otpauthUri).catch(() => undefined)} small />
        </View>
      ) : null}
      <Field label="6-digit code" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} autoComplete="one-time-code" error={error} />
      <Button title="Turn on and sign in" onPress={() => void confirm()} busy={busy} disabled={!enrolment} />
      <Button title="Cancel" variant="ghost" onPress={() => { flow.clear(); router.replace('/login'); }} />
    </Screen>
  );
}
