import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from './components';
import { Icon } from './icon';
import { space, useColors, useIsDark } from './theme';

/**
 * The shared look of every signed-out screen: brand header on the green top, content on a rounded white sheet. Sign-in, forgot password,
 * reset password and the first-sign-in password screen all use it so they read as one flow.
 */
export function AuthShell({ title, subtitle, back, compact, children }: { title: string; subtitle?: string; back?: boolean; compact?: boolean; children: ReactNode }) {
  const c = useColors();
  const dark = useIsDark();
  const router = useRouter();
  return (
    <View style={{ flex: 1, backgroundColor: c.primary }}>
      <StatusBar style={dark ? 'dark' : 'light'} />
      <SafeAreaView edges={['top']} style={{ flexShrink: 0 }}>
        <View style={{ alignItems: 'center', gap: space.sm, paddingTop: compact ? space.md : space.xl, paddingBottom: compact ? space.xl : space.xxl + space.sm }}>
          {back ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} hitSlop={10} style={{ position: 'absolute', left: space.lg, top: space.md, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="arrow-back" size="md" color={c.onPrimary} />
            </Pressable>
          ) : null}
          <View accessibilityLabel="Makarifor Poultry" accessibilityRole="image" style={{ width: compact ? 64 : 84, height: compact ? 64 : 84, borderRadius: compact ? 22 : 28, backgroundColor: c.onPrimary, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="egg" size={compact ? 36 : 48} color={c.primary} />
          </View>
          <Text variant={compact ? 'title' : 'display'} color={c.onPrimary}>Makarifor</Text>
          {!compact ? <Text variant="body" color={c.onPrimary} style={{ opacity: 0.85 }}>Poultry management</Text> : null}
        </View>
      </SafeAreaView>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView
          style={{ flex: 1, backgroundColor: c.card, borderTopLeftRadius: 32, borderTopRightRadius: 32 }} keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: space.xl, paddingBottom: space.xxxl, gap: space.xl }}
        >
          <View style={{ gap: space.xs }}>
            <Text variant="title" accessibilityRole="header">{title}</Text>
            {subtitle ? <Text muted>{subtitle}</Text> : null}
          </View>
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
