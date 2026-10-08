import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { describeError } from '../../../lib/errors';
import { email, required, useForm } from '../../../lib/validation';
import { useApp, useEndpoints } from '../../../state/app';
import { useAppStore } from '../../../state/store';
import { Button, Card, Field, InlineError, Screen, SectionTitle, Text } from '../../../ui/components';
import { space, useColors } from '../../../ui/theme';
import { useToast } from '../../../ui/toast';

/**
 * The sign-in address changes only after the code e-mailed to the NEW address is entered here, so a typo can never lock you out.
 */
export default function ChangeEmail() {
  const api = useEndpoints();
  const { services } = useApp();
  const router = useRouter();
  const toast = useToast();
  const c = useColors();
  const user = useAppStore((s) => s.user);
  const form = useForm(
    { email: '', password: '' },
    { email: [required('Enter the new email address.'), email, ], password: [required('Enter your current password to confirm.')] },
  );
  const code = useForm({ code: '' }, { code: [required('Paste the confirmation code from the email.')] });
  const [busy, setBusy] = useState<'request' | 'confirm' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = user?.pendingEmail ?? null;

  async function request() {
    if (!form.submit()) return;
    if (form.values.email.trim().toLowerCase() === user?.email) { setError('That is already your email address.'); return; }
    setBusy('request'); setError(null);
    try {
      await api.account.changeEmail(form.values.email.trim().toLowerCase(), form.values.password);
      await services.session.refreshProfile();
      form.reset();
      toast.show('We emailed you a confirmation code');
    } catch (err) { setError(describeError(err)); }
    finally { setBusy(null); }
  }

  async function confirm() {
    if (!code.submit()) return;
    setBusy('confirm'); setError(null);
    try {
      await services.pub.post('/v1/auth/verify-email', { token: code.values.code.trim() });
      await services.session.refreshProfile();
      toast.show('Email address changed');
      router.back();
    } catch (err) { setError(describeError(err)); }
    finally { setBusy(null); }
  }

  return (
    <Screen>
      <Card>
        <Text variant="caption" muted>Current sign-in address</Text>
        <Text variant="bodyStrong">{user?.email}</Text>
      </Card>

      {pending ? (
        <View style={{ gap: space.lg }}>
          <Card tone="warn">
            <Text variant="bodyStrong" color={c.warn}>Waiting for you to confirm {pending}</Text>
            <Text>We emailed a confirmation code to that address. Until you enter it you keep signing in with {user?.email}.</Text>
          </Card>
          <Field label="Confirmation code" icon="key-outline" {...code.field('code')} autoCapitalize="none" autoCorrect={false} placeholder="Paste the code from the email" returnKeyType="done" onSubmitEditing={() => void confirm()} />
          <InlineError message={error} />
          <Button title="Confirm new email" icon="checkmark" onPress={() => void confirm()} busy={busy === 'confirm'} />
          <SectionTitle>Wrong address?</SectionTitle>
          <Text muted>Enter a different address below to start again.</Text>
        </View>
      ) : <Card tone="info"><Text>We email a confirmation code to the new address. Until you enter it, you keep signing in with the current one.</Text></Card>}

      <View style={{ gap: space.lg }}>
        <Field label="New email address" icon="mail-outline" {...form.field('email')} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="emailAddress" autoComplete="email" returnKeyType="next" />
        <Field label="Current password" icon="lock-closed-outline" {...form.field('password')} secureTextEntry textContentType="password" returnKeyType="done" onSubmitEditing={() => void request()} />
        {!pending ? <InlineError message={error} /> : null}
        <Button title={pending ? 'Send a new code' : 'Send confirmation code'} variant={pending ? 'secondary' : 'primary'} icon="paper-plane-outline" onPress={() => void request()} busy={busy === 'request'} />
      </View>
    </Screen>
  );
}
