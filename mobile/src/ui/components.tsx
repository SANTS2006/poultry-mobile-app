import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text as RNText, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner } from './banner';
import { StatusBanners } from './status-banners';
import { font, radius, space, TOUCH, useColors } from './theme';

export { Banner };

export function Text({ children, style, muted, bold, size, color, ...rest }: { children?: ReactNode; style?: StyleProp<TextStyle>; muted?: boolean; bold?: boolean; size?: keyof typeof font; color?: string; numberOfLines?: number; selectable?: boolean; accessibilityRole?: 'header' | 'text' | 'link' }) {
  const c = useColors();
  return <RNText {...rest} style={[{ color: color ?? (muted ? c.muted : c.text), fontSize: font[size ?? 'body'], fontWeight: bold ? '700' : '400' }, style]}>{children}</RNText>;
}

export function Screen({ children, scroll = true, refreshing, onRefresh, padded = true, footer }: { children: ReactNode; scroll?: boolean; refreshing?: boolean; onRefresh?: () => void; padded?: boolean; footer?: ReactNode }) {
  const c = useColors();
  const body = scroll ? (
    <ScrollView
      contentContainerStyle={{ padding: padded ? space.lg : 0, gap: space.md, paddingBottom: space.xxl * 2 }} keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={c.primary} /> : undefined}
    >{children}</ScrollView>
  ) : <View style={{ flex: 1, padding: padded ? space.lg : 0, gap: space.md }}>{children}</View>;
  return <SafeAreaView edges={['left', 'right', 'bottom']} style={{ flex: 1, backgroundColor: c.bg }}><StatusBanners />{body}{footer}</SafeAreaView>;
}

export function Card({ children, style, tone }: { children: ReactNode; style?: StyleProp<ViewStyle>; tone?: 'danger' | 'warn' | 'ok' | 'info' }) {
  const c = useColors();
  const bg = tone ? c[`${tone}Soft` as const] : c.card;
  return <View style={[{ backgroundColor: bg, borderRadius: radius.lg, padding: space.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, gap: space.sm }, style]}>{children}</View>;
}

export function Button({ title, onPress, variant = 'primary', busy, disabled, small, testID }: { title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; busy?: boolean; disabled?: boolean; small?: boolean; testID?: string }) {
  const c = useColors();
  const bg = variant === 'primary' ? c.primary : variant === 'danger' ? c.danger : variant === 'secondary' ? c.primarySoft : 'transparent';
  const fg = variant === 'primary' ? c.onPrimary : variant === 'danger' ? '#FFFFFF' : c.primary;
  const off = disabled || busy;
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ disabled: !!off, busy: !!busy }} disabled={off} onPress={onPress}
      style={({ pressed }) => ({ minHeight: small ? 40 : TOUCH, paddingHorizontal: space.lg, borderRadius: radius.md, backgroundColor: bg, opacity: off ? 0.5 : pressed ? 0.85 : 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: space.sm })}>
      {busy ? <ActivityIndicator color={fg} /> : null}
      <RNText style={{ color: fg, fontSize: font.body, fontWeight: '600' }}>{title}</RNText>
    </Pressable>
  );
}

export function Field({ label, error, hint, ...input }: TextInputProps & { label: string; error?: string | null; hint?: string }) {
  const c = useColors();
  return (
    <View style={{ gap: space.xs }}>
      <Text size="small" bold muted>{label}</Text>
      <TextInput
        accessibilityLabel={label} placeholderTextColor={c.muted}
        style={{ minHeight: TOUCH, borderWidth: 1, borderColor: error ? c.danger : c.border, borderRadius: radius.md, paddingHorizontal: space.md, color: c.text, backgroundColor: c.input, fontSize: font.body }}
        {...input}
      />
      {error ? <Text size="small" color={c.danger}>{error}</Text> : hint ? <Text size="small" muted>{hint}</Text> : null}
    </View>
  );
}

export function Badge({ label, tone = 'info' }: { label: string; tone?: 'danger' | 'warn' | 'ok' | 'info' | 'muted' }) {
  const c = useColors();
  const bg = tone === 'muted' ? c.border : c[`${tone}Soft` as const];
  const fg = tone === 'muted' ? c.muted : c[tone];
  return <View style={{ alignSelf: 'flex-start', backgroundColor: bg, borderRadius: radius.pill, paddingHorizontal: space.sm + 2, paddingVertical: 2 }}><RNText style={{ color: fg, fontSize: font.small, fontWeight: '600' }}>{label}</RNText></View>;
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: space.sm }, style]}>{children}</View>;
}

export function ListRow({ title, subtitle, right, onPress, badge }: { title: string; subtitle?: string; right?: ReactNode; onPress?: () => void; badge?: ReactNode }) {
  const c = useColors();
  return (
    <Pressable accessibilityRole={onPress ? 'button' : undefined} disabled={!onPress} onPress={onPress}
      style={({ pressed }) => ({ minHeight: TOUCH + 8, paddingVertical: space.md, paddingHorizontal: space.lg, backgroundColor: pressed ? c.primarySoft : c.card, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border, flexDirection: 'row', alignItems: 'center', gap: space.md })}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text bold numberOfLines={1}>{title}</Text>
        {subtitle ? <Text size="small" muted numberOfLines={2}>{subtitle}</Text> : null}
        {badge}
      </View>
      {right}
    </Pressable>
  );
}

/** A tappable row that navigates to a route. */
export function NavRow({ title, subtitle, to, badge }: { title: string; subtitle?: string; to: string; badge?: ReactNode }) {
  const router = useRouter();
  return <ListRow title={title} subtitle={subtitle} badge={badge} onPress={() => router.push(to as never)} right={<Text muted>›</Text>} />;
}

export function SectionTitle({ children }: { children: ReactNode }) { return <Text size="title" bold accessibilityRole="header" style={{ marginTop: space.sm }}>{children}</Text>; }

export function Loading({ label }: { label?: string }) {
  const c = useColors();
  return <View style={{ padding: space.xl, alignItems: 'center', gap: space.sm }}><ActivityIndicator color={c.primary} />{label ? <Text muted>{label}</Text> : null}</View>;
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return <View style={{ padding: space.xl, alignItems: 'center', gap: space.sm }}><Text bold size="title">{title}</Text>{hint ? <Text muted style={{ textAlign: 'center' }}>{hint}</Text> : null}{action}</View>;
}

export function ErrorView({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <Card tone="danger"><Text bold>Could not load this</Text><Text>{message}</Text>{onRetry ? <Button title="Try again" variant="secondary" onPress={onRetry} /> : null}</Card>;
}

/** Single-choice chips (shifts, units, payment methods…). */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T | null; options: { value: T; label: string }[]; onChange: (v: T) => void; label?: string }) {
  const c = useColors();
  return (
    <View style={{ gap: space.xs }}>
      {label ? <Text size="small" bold muted>{label}</Text> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <Pressable key={o.value} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => onChange(o.value)}
              style={{ minHeight: 44, paddingHorizontal: space.lg, borderRadius: radius.pill, justifyContent: 'center', backgroundColor: on ? c.primary : c.card, borderWidth: 1, borderColor: on ? c.primary : c.border }}>
              <RNText style={{ color: on ? c.onPrimary : c.text, fontWeight: '600' }}>{o.label}</RNText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Whole-number stepper for quantities. */
export function Stepper({ label, value, onChange, max = 100000 }: { label: string; value: number; onChange: (n: number) => void; max?: number }) {
  const c = useColors();
  const set = (n: number) => onChange(Math.max(0, Math.min(max, Math.floor(n) || 0)));
  return (
    <View style={{ gap: space.xs }}>
      <Text size="small" bold muted>{label}</Text>
      <Row>
        <Button title="−" variant="secondary" onPress={() => set(value - 1)} small />
        <TextInput accessibilityLabel={label} keyboardType="number-pad" value={String(value)} onChangeText={(t) => set(Number(t.replace(/\D/g, '')))}
          style={{ flex: 1, minHeight: TOUCH, textAlign: 'center', fontSize: font.title, fontWeight: '700', color: c.text, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, backgroundColor: c.input }} />
        <Button title="+" variant="secondary" onPress={() => set(value + 1)} small />
      </Row>
    </View>
  );
}
