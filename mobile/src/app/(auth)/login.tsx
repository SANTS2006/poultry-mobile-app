import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { describeError } from '../../lib/errors';
import { useApp } from '../../state/app';
import { useAuthFlow } from '../../state/auth-flow';
import { Button, Field, Screen, Text } from '../../ui/components';
import { APP_ENV } from '../../config';
import { space } from '../../ui/theme';

export default function Login() {
  const router = useRouter();
  const { services } = useApp();
  const flow = useAuthFlow();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!email.trim() || !password) { setError('Enter your email and password.'); return; }
    setBusy(true); setError(null);
    try {
      const out = await services.session.login(email, password);
      setPassword('');
      if (out.kind === 'mfa_required') { flow.startMfa(out.mfaToken); router.push('/mfa'); }
      else if (out.kind === 'mfa_setup_required') { flow.startSetup(out.setupToken); router.push('/mfa-setup'); }
      // 'authenticated': the route guard switches to the app
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ gap: space.lg, paddingTop: space.xxl }}>
        <View style={{ gap: space.xs }}>
          <Text size="h1" bold accessibilityRole="header">Makarifor Poultry</Text>
          <Text muted>Sign in to record production, sales and expenses.</Text>
        </View>
        <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="username" autoComplete="email" testID="email" />
        <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry textContentType="password" autoComplete="password" onSubmitEditing={() => void submit()} testID="password" />
        {error ? <Text color="#B42318" accessibilityRole="text">{error}</Text> : null}
        <Button title="Sign in" onPress={() => void submit()} busy={busy} testID="signin" />
        <Button title="Forgot password?" variant="ghost" onPress={() => router.push('/forgot-password')} />
        <Button title="I have an invitation" variant="ghost" onPress={() => router.push('/accept-invite')} />
        {APP_ENV !== 'production' ? <Text size="small" muted style={{ textAlign: 'center' }}>{APP_ENV} build</Text> : null}
      </KeyboardAvoidingView>
    </Screen>
  );
}
