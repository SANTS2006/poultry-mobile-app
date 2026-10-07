import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View, type TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { APP_ENV } from '../../config';
import { describeError } from '../../lib/errors';
import { IS_EXPO_GO } from '../../lib/runtime';
import { useApp } from '../../state/app';
import { useAuthFlow } from '../../state/auth-flow';
import { Button, Card, Field, Row, Text } from '../../ui/components';
import { Icon } from '../../ui/icon';
import { radius, space, useColors, useIsDark } from '../../ui/theme';

const REMEMBER_KEY = 'pref.rememberedEmail';
const WELCOME_KEY = 'pref.welcomeSeen';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function Login() {
  const router = useRouter();
  const c = useColors();
  const isDark = useIsDark();
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
    <View style={{ flex: 1, backgroundColor: c.primary }}>
      <StatusBar style={isDark ? 'dark' : 'light'} />
      <SafeAreaView edges={['top']} style={{ flexShrink: 0 }}>
        <View style={{ alignItems: 'center', gap: space.md, paddingTop: space.xl, paddingBottom: space.xxl + space.sm }}>
          <View accessibilityLabel="Makarifor Poultry" accessibilityRole="image" style={{ width: 84, height: 84, borderRadius: 28, backgroundColor: c.onPrimary, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="egg" size={48} color={c.primary} />
          </View>
          <Text variant="display" accessibilityRole="header" color={c.onPrimary}>Makarifor</Text>
          <Text variant="body" color={c.onPrimary} style={{ opacity: 0.85 }}>Poultry management</Text>
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView
          style={{ flex: 1, backgroundColor: c.card, borderTopLeftRadius: 32, borderTopRightRadius: 32 }} keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: space.xl, paddingBottom: space.xxxl, gap: space.xl }}
        >
          <View style={{ gap: space.xs }}>
            <Text variant="title" accessibilityRole="header">Sign in</Text>
            <Text muted>Record eggs, sales and expenses.</Text>
          </View>

          {error ? (
            <Card tone="danger"><Row><Icon name="alert-circle" size="md" color={c.danger} /><Text variant="bodyStrong" color={c.danger} style={{ flex: 1 }}>{error}</Text></Row></Card>
          ) : null}

          <View style={{ gap: space.lg }}>
            <Field
              pill label="Email address" icon="mail-outline" value={email} onChangeText={(t) => { setEmail(t); if (error) setError(null); }} onBlur={() => setTouched((s) => ({ ...s, email: true }))}
              error={emailError} editable={!busy} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="username" autoComplete="email"
              returnKeyType="next" onSubmitEditing={() => passwordRef.current?.focus()} blurOnSubmit={false} placeholder="Enter your email address" testID="email"
            />
            <Field
              pill inputRef={passwordRef} label="Password" icon="lock-closed-outline" value={password} onChangeText={(t) => { setPassword(t); if (error) setError(null); }} onBlur={() => setTouched((s) => ({ ...s, password: true }))}
              error={passwordError} editable={!busy} secureTextEntry textContentType="password" autoComplete="password" returnKeyType="go" onSubmitEditing={() => void submit()} placeholder="Enter your password" testID="password"
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

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: space.xs }}>
            <Text variant="caption" muted>Accounts are created by your administrator.</Text>
            <Pressable accessibilityRole="link" onPress={() => router.push('/accept-invite')} hitSlop={10} style={{ minHeight: 44, justifyContent: 'center' }}>
              <Text variant="caption" bold color={c.primary}>Use my invitation</Text>
            </Pressable>
          </View>

          {IS_EXPO_GO || APP_ENV !== 'production' ? (
            <View style={{ alignSelf: 'center', paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, backgroundColor: c.accentSoft }}>
              <Text variant="caption" color={c.onAccentSoft}>{IS_EXPO_GO ? 'Expo Go test mode · data on this phone is not encrypted' : `${APP_ENV} build`}</Text>
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

export { WELCOME_KEY };
