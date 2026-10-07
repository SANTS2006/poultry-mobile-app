import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { describeError } from '../../../lib/errors';
import { useApp, useEndpoints } from '../../../state/app';
import { useAppStore } from '../../../state/store';
import { Button, Card, Field, Screen, Text } from '../../../ui/components';
import { space, useColors } from '../../../ui/theme';
import { useToast } from '../../../ui/toast';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The sign-in address changes only after the link sent to the NEW address is used, so a typo can never lock you out. */
export default function ChangeEmail() {
  const api = useEndpoints();
  const { services } = useApp();
  const router = useRouter();
  const toast = useToast();
  const c = useColors();
  const user = useAppStore((s) => s.user);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string; form?: string }>({});

  async function save() {
    const next = email.trim().toLowerCase();
    const e: typeof errors = {};
    if (!EMAIL_RE.test(next)) e.email = 'That doesn’t look like an email address.';
    else if (next === user?.email) e.email = 'That is already your email address.';
    if (!password) e.password = 'Enter your current password to confirm.';
    setErrors(e);
    if (e.email || e.password) return;
    setBusy(true);
    try {
      await api.account.changeEmail(next, password);
      await services.session.refreshProfile();
      toast.show('Check your inbox to confirm');
      router.back();
    } catch (err) { setErrors({ form: describeError(err) }); }
    finally { setBusy(false); }
  }

  return (
    <Screen>
      <Card>
        <Text variant="caption" muted>Current sign-in address</Text>
        <Text variant="bodyStrong">{user?.email}</Text>
        {user?.pendingEmail ? <Text variant="caption" color={c.warn}>Waiting for you to confirm {user.pendingEmail}. Open the link we emailed there.</Text> : null}
      </Card>
      <Card tone="info"><Text>We email a confirmation link to the new address. Until you use it, you keep signing in with the current one.</Text></Card>
      <View style={{ gap: space.lg }}>
        <Field label="New email address" icon="mail-outline" value={email} onChangeText={(t) => { setEmail(t); setErrors({}); }} error={errors.email} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="emailAddress" autoComplete="email" returnKeyType="next" />
        <Field label="Current password" icon="lock-closed-outline" value={password} onChangeText={(t) => { setPassword(t); setErrors({}); }} error={errors.password ?? errors.form} secureTextEntry textContentType="password" returnKeyType="done" onSubmitEditing={() => void save()} />
        <Button title="Send confirmation link" icon="paper-plane-outline" onPress={() => void save()} busy={busy} />
      </View>
    </Screen>
  );
}
