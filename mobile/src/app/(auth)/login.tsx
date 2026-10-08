import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, View, type TextInput } from 'react-native';
import { APP_ENV } from '../../config';
import { describeError } from '../../lib/errors';
import { IS_EXPO_GO } from '../../lib/runtime';
import { email, required, useForm } from '../../lib/validation';
import { useApp } from '../../state/app';
import { useAuthFlow } from '../../state/auth-flow';
import { AuthShell } from '../../ui/auth-shell';
import { Button, Card, Field, Row, Text } from '../../ui/components';
import { useSecureScreen } from '../../ui/secure-screen';
import { Icon } from '../../ui/icon';
import { radius, space, useColors } from '../../ui/theme';

const REMEMBER_KEY = 'pref.rememberedEmail';
const WELCOME_KEY = 'pref.welcomeSeen';

export default function Login() {
  useSecureScreen();
  const router = useRouter();
  const c = useColors();
  const { services } = useApp();
  const flow = useAuthFlow();
  const passwordRef = useRef<TextInput>(null);
  const form = useForm({ email: '', password: '' }, { email: [required('Enter your email address.'), email], password: [required('Enter your password.')] });
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // First launch: show the short welcome once. Afterwards: prefill the remembered email.
  const { set } = form;
  useEffect(() => {
    let live = true;
    void (async () => {
      if ((await services.secure.get(WELCOME_KEY)) !== '1') { if (live) router.replace('/welcome' as never); return; }
      const saved = await services.secure.get(REMEMBER_KEY);
      if (live && saved) set('email', saved);
    })();
    return () => { live = false; };
  }, [router, services.secure, set]);

  async function submit() {
    if (!form.submit()) return;
    const { email: e, password } = form.values;
    setBusy(true); setError(null);
    try {
      if (remember) await services.secure.set(REMEMBER_KEY, e.trim()); else await services.secure.delete(REMEMBER_KEY);
      const out = await services.session.login(e, password);
      form.set('password', '');
      if (out.kind === 'mfa_required') { flow.startMfa(out.mfaToken); router.push('/mfa'); }
      else if (out.kind === 'mfa_setup_required') { flow.startSetup(out.setupToken); router.push('/mfa-setup'); }
      else if (out.kind === 'password_change_required') { flow.startPasswordChange(out.passwordToken); router.push('/first-password' as never); }
      // 'authenticated': the route guard switches to the app
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const clearError = () => { if (error) setError(null); };
  const emailField = form.field('email');
  const passwordField = form.field('password');
  return (
    <AuthShell title="Sign in" subtitle="Record eggs, sales and expenses.">
      {error ? (
        <Card tone="danger"><Row><Icon name="alert-circle" size="md" color={c.danger} /><Text variant="bodyStrong" color={c.danger} style={{ flex: 1 }}>{error}</Text></Row></Card>
      ) : null}

      <View style={{ gap: space.lg }}>
        <Field
          pill label="Email address" icon="mail-outline" {...emailField} onChangeText={(t) => { emailField.onChangeText(t); clearError(); }}
          editable={!busy} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="username" autoComplete="email"
          returnKeyType="next" onSubmitEditing={() => passwordRef.current?.focus()} blurOnSubmit={false} placeholder="Enter your email address" testID="email"
        />
        <Field
          pill inputRef={passwordRef} label="Password" icon="lock-closed-outline" {...passwordField} onChangeText={(t) => { passwordField.onChangeText(t); clearError(); }}
          editable={!busy} secureTextEntry textContentType="password" autoComplete="password" returnKeyType="go" onSubmitEditing={() => void submit()} placeholder="Enter your password" testID="password"
        />
        <Row style={{ justifyContent: 'space-between' }}>
          <Pressable accessibilityRole="checkbox" accessibilityLabel="Remember my email" accessibilityState={{ checked: remember }} onPress={() => setRemember(!remember)} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 44 }}>
            <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: remember ? c.primary : c.borderStrong, backgroundColor: remember ? c.primary : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
              {remember ? <Icon name="checkmark" size={14} color={c.onPrimary} /> : null}
            </View>
            <Text variant="label" muted>Remember my email</Text>
          </Pressable>
          <Pressable accessibilityRole="link" onPress={() => router.push('/forgot-password')} hitSlop={10} style={{ minHeight: 44, justifyContent: 'center' }}>
            <Text variant="label" color={c.primary}>Forgot password?</Text>
          </Pressable>
        </Row>
        <Button pill title="Sign in" onPress={() => void submit()} busy={busy} testID="signin" />
      </View>

      {IS_EXPO_GO || APP_ENV !== 'production' ? (
        <View style={{ alignSelf: 'center', paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, backgroundColor: c.accentSoft }}>
          <Text variant="caption" color={c.onAccentSoft}>{IS_EXPO_GO ? 'Expo Go test mode · data on this phone is not encrypted' : `${APP_ENV} build`}</Text>
        </View>
      ) : null}
    </AuthShell>
  );
}

export { WELCOME_KEY };
