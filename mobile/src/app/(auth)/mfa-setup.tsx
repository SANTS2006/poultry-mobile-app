import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, Linking, View } from 'react-native';
import { describeError } from '../../lib/errors';
import { digits, required, useForm } from '../../lib/validation';
import { useApp } from '../../state/app';
import { useAuthFlow } from '../../state/auth-flow';
import { AuthHeader } from '../../ui/brand';
import { Button, Card, Field, InlineError, Loading, Screen, Text } from '../../ui/components';
import { space } from '../../ui/theme';

/** Privileged roles (Owner, Super Admin) must enrol before receiving a session. The setup token only authorises these two calls. */
export default function MfaSetup() {
  const router = useRouter();
  const { services } = useApp();
  const flow = useAuthFlow();
  const [enrolment, setEnrolment] = useState<{ secret: string; otpauthUri: string; qrCodeDataUrl: string } | null>(null);
  const form = useForm({ code: '' }, { code: [required('Enter the 6-digit code shown in your authenticator app.'), digits(6, 'The code is 6 digits, like 123456.')] });
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
    if (!form.submit()) return;
    setBusy(true); setError(null);
    try {
      const { recoveryCodes } = await services.session.confirmMfaSetup(t, form.values.code.trim());
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
      <AuthHeader icon="shield-checkmark-outline" title="Set up two-step sign-in" subtitle="Your role handles sensitive data, so a second step is required." />
      <Card>
        <Text variant="heading">How to set it up</Text>
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
      <Field label="6-digit code" icon="keypad-outline" {...form.field('code')} keyboardType="number-pad" maxLength={6} autoComplete="one-time-code" />
      {enrolment ? <InlineError message={error} /> : null}
      {!enrolment ? <InlineError message={error} /> : null}
      <Button title="Turn on and sign in" icon="checkmark" onPress={() => void confirm()} busy={busy} disabled={!enrolment} />
      <Button title="Cancel" variant="ghost" onPress={() => { flow.clear(); router.replace('/login'); }} />
    </Screen>
  );
}
