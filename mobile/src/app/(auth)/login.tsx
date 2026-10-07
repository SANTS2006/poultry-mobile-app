import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Switch, View, type TextInput } from 'react-native';
import { APP_ENV } from '../../config';
import { describeError } from '../../lib/errors';
import { IS_EXPO_GO } from '../../lib/runtime';
import { useApp } from '../../state/app';
import { useAuthFlow } from '../../state/auth-flow';
import { BrandMark } from '../../ui/brand';
import { Button, Card, Field, Row, Screen, Text } from '../../ui/components';
import { Icon } from '../../ui/icon';
import { radius, space, useColors } from '../../ui/theme';

const REMEMBER_KEY = 'pref.rememberedEmail';
const WELCOME_KEY = 'pref.welcomeSeen';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function Login() {
  const router = useRouter();
  const c = useColors();
  const { services } = useApp();
  const flow = useAuthFlow();
  const passwordRef = useRef<TextInput>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [touched, setTouched] = useState({ email: false, password: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // First launch: show the short welcome once. Afterwards: prefill the remembered email.
  useEffect(() => {
    let live = true;
    void (async () => {
      if ((await services.secure.get(WELCOME_KEY)) !== '1') { if (live) router.replace('/welcome' as never); return; }
      const saved = await services.secure.get(REMEMBER_KEY);
      if (live && saved) setEmail(saved);
    })();
    return () => { live = false; };
  }, [router, services.secure]);

  const emailError = touched.email ? (!email.trim() ? 'Enter your email address.' : !EMAIL_RE.test(email.trim()) ? 'That doesn’t look like an email address.' : null) : null;
  const passwordError = touched.password && !password ? 'Enter your password.' : null;

  async function submit() {
    setTouched({ email: true, password: true });
    if (!EMAIL_RE.test(email.trim()) || !password) return;
    setBusy(true); setError(null);
    try {
      if (remember) await services.secure.set(REMEMBER_KEY, email.trim()); else await services.secure.delete(REMEMBER_KEY);
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
      <View style={{ paddingTop: space.xxl, gap: space.lg, alignItems: 'center' }}>
        <BrandMark size={72} />
        <View style={{ gap: space.xs, alignItems: 'center' }}>
          <Text variant="title" accessibilityRole="header">Welcome back</Text>
          <Text muted style={{ textAlign: 'center' }}>Sign in to record eggs, sales and expenses.</Text>
        </View>
      </View>

      {error ? (
        <Card tone="danger"><Row><Icon name="alert-circle" size="md" color={c.danger} /><Text variant="bodyStrong" color={c.danger} style={{ flex: 1 }}>{error}</Text></Row></Card>
      ) : null}

      <View style={{ gap: space.lg }}>
        <Field
          label="Email" icon="mail-outline" value={email} onChangeText={(t) => { setEmail(t); if (error) setError(null); }} onBlur={() => setTouched((s) => ({ ...s, email: true }))}
          error={emailError} editable={!busy} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="username" autoComplete="email"
          returnKeyType="next" onSubmitEditing={() => passwordRef.current?.focus()} blurOnSubmit={false} placeholder="you@farm.com" testID="email"
        />
        <Field
          inputRef={passwordRef} label="Password" icon="lock-closed-outline" value={password} onChangeText={(t) => { setPassword(t); if (error) setError(null); }} onBlur={() => setTouched((s) => ({ ...s, password: true }))}
          error={passwordError} editable={!busy} secureTextEntry textContentType="password" autoComplete="password" returnKeyType="go" onSubmitEditing={() => void submit()} testID="password"
        />
        <Row style={{ justifyContent: 'space-between' }}>
          <Pressable accessibilityRole="switch" accessibilityState={{ checked: remember }} onPress={() => setRemember(!remember)} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 44 }}>
            <Switch value={remember} onValueChange={setRemember} trackColor={{ true: c.primary }} accessibilityLabel="Remember my email" />
            <Text variant="label" muted>Remember my email</Text>
          </Pressable>
          <Pressable accessibilityRole="link" onPress={() => router.push('/forgot-password')} hitSlop={10} style={{ minHeight: 44, justifyContent: 'center' }}>
            <Text variant="label" color={c.primary}>Forgot password?</Text>
          </Pressable>
        </Row>
        <Button title="Sign in" icon="log-in-outline" onPress={() => void submit()} busy={busy} testID="signin" />
      </View>

      <View style={{ borderTopWidth: 1, borderColor: c.border, paddingTop: space.lg, gap: space.sm, alignItems: 'center' }}>
        <Text variant="caption" muted style={{ textAlign: 'center' }}>Accounts are created by your farm administrator. Got an invitation e-mail?</Text>
        <Button title="Use my invitation" variant="secondary" small icon="mail-open-outline" onPress={() => router.push('/accept-invite')} />
      </View>

      {IS_EXPO_GO || APP_ENV !== 'production' ? (
        <View style={{ alignSelf: 'center', paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, backgroundColor: c.accentSoft }}>
          <Text variant="caption" color={c.onAccentSoft}>{IS_EXPO_GO ? 'Expo Go test mode · data on this phone is not encrypted' : `${APP_ENV} build`}</Text>
        </View>
      ) : null}
    </Screen>
  );
}

export { WELCOME_KEY };
