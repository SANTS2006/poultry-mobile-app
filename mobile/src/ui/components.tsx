import { useRouter } from 'expo-router';
import { useEffect, useState, type ReactNode, type Ref } from 'react';
import {
  ActivityIndicator, Animated, Image, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text as RNText, TextInput, View,
  type StyleProp, type TextInputProps, type TextStyle, type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner } from './banner';
import { Icon, type IconName } from './icon';
import { StatusBanners } from './status-banners';
import { elevation, radius, space, TOUCH, typeScale, useColors, type Colors } from './theme';
import type { TypeRole } from './tokens';

export { Banner };

type Tone = 'danger' | 'warn' | 'ok' | 'info';
const TONE_ICON: Record<Tone | 'muted', IconName> = { danger: 'alert-circle', warn: 'warning', ok: 'checkmark-circle', info: 'information-circle', muted: 'ellipse-outline' };
const SIZE_ROLE = { small: 'caption', body: 'body', title: 'title', h1: 'title', big: 'display' } as const;

/* ───────────────────────── Text ───────────────────────── */

export function Text({ children, style, muted, bold, size, variant, color, ...rest }: {
  children?: ReactNode; style?: StyleProp<TextStyle>; muted?: boolean; bold?: boolean; size?: keyof typeof SIZE_ROLE; variant?: TypeRole; color?: string;
  numberOfLines?: number; adjustsFontSizeToFit?: boolean; selectable?: boolean; accessibilityRole?: 'header' | 'text' | 'link';
}) {
  const c = useColors();
  const role = typeScale[variant ?? SIZE_ROLE[size ?? 'body']];
  const weight = bold && !variant ? '700' : role.fontWeight;
  return <RNText {...rest} style={[role, { fontWeight: weight, color: color ?? (muted ? c.textSecondary : c.text) }, style]}>{children}</RNText>;
}

/* ───────────────────────── Layout ───────────────────────── */

/**
 * Standard screen: safe areas, connection banners, comfortable gutters, keyboard handling (content scrolls above the keyboard, taps on
 * buttons still work while it is open) and pull-to-refresh.
 */
export function Screen({ children, scroll = true, refreshing, onRefresh, padded = true, footer }: {
  children: ReactNode; scroll?: boolean; refreshing?: boolean; onRefresh?: () => void; padded?: boolean; footer?: ReactNode;
}) {
  const c = useColors();
  const body = scroll ? (
    <ScrollView
      contentContainerStyle={{ padding: padded ? space.lg : 0, gap: space.lg, paddingBottom: space.xxxl + space.xl }} keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={c.primary} colors={[c.primary]} /> : undefined}
    >{children}</ScrollView>
  ) : <View style={{ flex: 1, padding: padded ? space.lg : 0, gap: space.lg }}>{children}</View>;
  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
      <StatusBanners />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">{body}{footer}</KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function Card({ children, style, tone }: { children: ReactNode; style?: StyleProp<ViewStyle>; tone?: Tone }) {
  const c = useColors();
  const bg = tone ? c[`${tone}Soft` as const] : c.card;
  return (
    <View style={[{ backgroundColor: bg, borderRadius: radius.lg, padding: space.lg, gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: tone ? 'transparent' : c.border }, tone ? null : elevation.card, style]}>
      {children}
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: space.sm }, style]}>{children}</View>;
}

/** Section heading with an optional trailing action ("See all"). */
export function SectionHeader({ title, action }: { title: string; action?: { label: string; onPress: () => void } }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.sm }}>
      <Text variant="heading" accessibilityRole="header">{title}</Text>
      {action ? <Pressable accessibilityRole="button" onPress={action.onPress} hitSlop={12}><RNText style={[typeScale.label, { color: c.primary }]}>{action.label}</RNText></Pressable> : null}
    </View>
  );
}
export function SectionTitle({ children }: { children: ReactNode }) { return <Text variant="heading" accessibilityRole="header" style={{ marginTop: space.sm }}>{children}</Text>; }

/* ───────────────────────── Buttons ───────────────────────── */

export function Button({ title, onPress, variant = 'primary', busy, disabled, small, testID, icon, pill }: {
  title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; busy?: boolean; disabled?: boolean; small?: boolean; testID?: string; icon?: IconName; pill?: boolean;
}) {
  const c = useColors();
  const [scale] = useState(() => new Animated.Value(1));
  const spring = (to: number) => Animated.spring(scale, { toValue: to, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  const bg = variant === 'primary' ? c.primary : variant === 'danger' ? c.danger : variant === 'secondary' ? c.primarySoft : 'transparent';
  const fg = variant === 'primary' ? c.onPrimary : variant === 'danger' ? c.onDanger : variant === 'secondary' ? c.onPrimarySoft : c.primary;
  const off = disabled || busy;
  return (
    <Pressable
      testID={testID} accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: !!off, busy: !!busy }} disabled={off} onPress={onPress}
      onPressIn={() => spring(0.97)} onPressOut={() => spring(1)} android_ripple={{ color: `${fg}22` }}
    >
      <Animated.View style={{
        transform: [{ scale }], minHeight: small ? 44 : TOUCH + 4, paddingHorizontal: small ? space.lg : space.xl, borderRadius: pill ? radius.pill : radius.md, backgroundColor: bg,
        opacity: off ? 0.5 : 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: space.sm,
      }}>
        {busy ? <ActivityIndicator color={fg} /> : icon ? <Icon name={icon} size="sm" color={fg} /> : null}
        <RNText style={[typeScale.bodyStrong, { color: fg }]}>{title}</RNText>
      </Animated.View>
    </Pressable>
  );
}

/* ───────────────────────── Inputs ───────────────────────── */

/**
 * Labelled input. The label is always visible (never only a placeholder), the error appears directly under the field with an icon
 * (not colour alone), password fields get a show/hide control, and focus is clearly outlined.
 */
export function Field({ label, error, hint, icon, inputRef, pill, onFocus, onBlur, ...input }: TextInputProps & { label: string; error?: string | null; hint?: string; icon?: IconName; inputRef?: Ref<TextInput>; pill?: boolean }) {
  const c = useColors();
  const [focused, setFocused] = useState(false);
  const [reveal, setReveal] = useState(false);
  const isPassword = !!input.secureTextEntry;
  const border = error ? c.danger : focused ? c.primary : c.borderStrong;
  // The border is always 2 px wide (only its colour changes) so focusing a field never moves anything on screen: a layout shift under the
  // user's finger can make the scroll view treat a tap as a drag and close the keyboard.
  return (
    <View style={{ gap: space.xs }}>
      <Text variant="label">{label}</Text>
      <View style={{
        minHeight: TOUCH + 8, flexDirection: 'row', alignItems: 'center', borderWidth: 2, borderColor: border, borderRadius: pill ? radius.pill : radius.md,
        backgroundColor: c.input, paddingHorizontal: pill ? space.lg : space.md, gap: space.sm,
      }}>
        {icon ? <Icon name={icon} size="sm" color={focused ? c.primary : c.muted} /> : null}
        <TextInput
          {...input} ref={inputRef} accessibilityLabel={label} placeholderTextColor={c.muted} cursorColor={c.primary} selectionColor={c.primary}
          onFocus={(e) => { setFocused(true); onFocus?.(e); }} onBlur={(e) => { setFocused(false); onBlur?.(e); }}
          style={[typeScale.body, { flex: 1, color: c.text, paddingVertical: space.md }, input.style]} secureTextEntry={isPassword && !reveal}
        />
        {isPassword ? (
          <Pressable accessibilityRole="button" accessibilityLabel={reveal ? 'Hide password' : 'Show password'} hitSlop={12} onPress={() => setReveal((v) => !v)} style={{ padding: space.xs }}>
            <Icon name={reveal ? 'eye-off-outline' : 'eye-outline'} size="md" color={c.textSecondary} />
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <View accessibilityRole="alert" style={{ flexDirection: 'row', gap: space.xs, alignItems: 'center' }}>
          <Icon name="alert-circle" size="sm" color={c.danger} /><Text variant="caption" color={c.danger} style={{ flex: 1 }}>{error}</Text>
        </View>
      ) : hint ? <Text variant="caption" muted>{hint}</Text> : null}
    </View>
  );
}

export function SearchBar({ value, onChangeText, placeholder = 'Search' }: { value: string; onChangeText: (t: string) => void; placeholder?: string }) {
  const c = useColors();
  return (
    <View style={{ minHeight: TOUCH, flexDirection: 'row', alignItems: 'center', backgroundColor: c.input, borderRadius: radius.pill, paddingHorizontal: space.lg, gap: space.sm, borderWidth: 1, borderColor: c.border }}>
      <Icon name="search" size="sm" color={c.muted} />
      <TextInput
        accessibilityLabel={placeholder} value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={c.muted} autoCorrect={false} autoCapitalize="none"
        returnKeyType="search" style={[typeScale.body, { flex: 1, color: c.text, paddingVertical: space.sm }]}
      />
      {value ? <Pressable accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={12} onPress={() => onChangeText('')}><Icon name="close-circle" size="md" color={c.muted} /></Pressable> : null}
    </View>
  );
}

/** Error line shown directly under the control it refers to (icon + text, announced by screen readers). */
export function InlineError({ message }: { message?: string | null }) {
  const c = useColors();
  if (!message) return null;
  return (
    <View accessibilityRole="alert" style={{ flexDirection: 'row', gap: space.xs, alignItems: 'center' }}>
      <Icon name="alert-circle" size="sm" color={c.danger} /><Text variant="caption" color={c.danger} style={{ flex: 1 }}>{message}</Text>
    </View>
  );
}

/** Single-choice chips (shifts, units, payment methods…). */
export function Segmented<T extends string>({ value, options, onChange, label, error }: { value: T | null; options: { value: T; label: string }[]; onChange: (v: T) => void; label?: string; error?: string | null }) {
  const c = useColors();
  return (
    <View style={{ gap: space.xs }}>
      {label ? <Text variant="label" muted>{label}</Text> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <Pressable
              key={o.value} accessibilityRole="radio" accessibilityLabel={o.label} accessibilityState={{ selected: on }} onPress={() => onChange(o.value)} android_ripple={{ color: `${c.primary}22` }}
              style={{ minHeight: 44, paddingHorizontal: space.lg, borderRadius: radius.pill, justifyContent: 'center', flexDirection: 'row', alignItems: 'center', gap: space.xs, backgroundColor: on ? c.primary : c.card, borderWidth: 1, borderColor: on ? c.primary : c.borderStrong }}>
              {on ? <Icon name="checkmark" size="sm" color={c.onPrimary} /> : null}
              <RNText style={[typeScale.label, { color: on ? c.onPrimary : c.text }]}>{o.label}</RNText>
            </Pressable>
          );
        })}
      </View>
      <InlineError message={error} />
    </View>
  );
}

/** Whole-number stepper for quantities. */
export function Stepper({ label, value, onChange, max = 100000 }: { label: string; value: number; onChange: (n: number) => void; max?: number }) {
  const c = useColors();
  const set = (n: number) => onChange(Math.max(0, Math.min(max, Math.floor(n) || 0)));
  const round = { width: TOUCH + 4, height: TOUCH + 4, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: c.primarySoft } as const;
  return (
    <View style={{ gap: space.xs }}>
      <Text variant="label" muted>{label}</Text>
      <Row>
        <Pressable accessibilityRole="button" accessibilityLabel={`Decrease ${label}`} onPress={() => set(value - 1)} style={round}><Icon name="remove" size="md" color={c.onPrimarySoft} /></Pressable>
        <TextInput
          accessibilityLabel={label} keyboardType="number-pad" value={String(value)} onChangeText={(t) => set(Number(t.replace(/\D/g, '')))} selectTextOnFocus
          style={[typeScale.title, { flex: 1, minHeight: TOUCH + 4, textAlign: 'center', color: c.text, borderWidth: 1, borderColor: c.borderStrong, borderRadius: radius.md, backgroundColor: c.input }]}
        />
        <Pressable accessibilityRole="button" accessibilityLabel={`Increase ${label}`} onPress={() => set(value + 1)} style={round}><Icon name="add" size="md" color={c.onPrimarySoft} /></Pressable>
      </Row>
    </View>
  );
}

/* ───────────────────────── Data display ───────────────────────── */

/** Status pill. Always carries an icon AND text, so status never depends on colour alone. */
export function Badge({ label, tone = 'info' }: { label: string; tone?: Tone | 'muted' }) {
  const c = useColors();
  const bg = tone === 'muted' ? c.border : c[`${tone}Soft` as const];
  const fg = tone === 'muted' ? c.textSecondary : c[tone];
  return (
    <View style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: space.xs, backgroundColor: bg, borderRadius: radius.pill, paddingHorizontal: space.sm + 2, paddingVertical: 3 }}>
      <Icon name={TONE_ICON[tone]} size={14} color={fg} />
      <RNText style={[typeScale.caption, { color: fg, fontWeight: '600' }]}>{label}</RNText>
    </View>
  );
}

/** Round icon tile used as the leading visual of list rows. */
export function IconTile({ name, tone = 'primary' }: { name: IconName; tone?: 'primary' | 'accent' | 'danger' | 'info' }) {
  const c = useColors();
  const bg = { primary: c.primarySoft, accent: c.accentSoft, danger: c.dangerSoft, info: c.infoSoft }[tone];
  const fg = { primary: c.onPrimarySoft, accent: c.onAccentSoft, danger: c.danger, info: c.info }[tone];
  return <View style={{ width: 40, height: 40, borderRadius: radius.md - 2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}><Icon name={name} size="md" color={fg} /></View>;
}

export function Avatar({ name, size = 44, uri }: { name: string; size?: number; uri?: string | null }) {
  const c = useColors();
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';
  const box = { width: size, height: size, borderRadius: size / 2, overflow: 'hidden' as const };
  if (uri && failedUri !== uri) {
    return <Image accessibilityIgnoresInvertColors accessibilityElementsHidden importantForAccessibility="no-hide-descendants" source={{ uri }} onError={() => setFailedUri(uri)} style={[box, { backgroundColor: c.accentSoft }]} />;
  }
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[box, { backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }]}>
      <RNText style={[typeScale.bodyStrong, { color: c.onAccent, fontSize: size * 0.38 }]}>{initials}</RNText>
    </View>
  );
}

/** Headline figure with a small caption — the building block of dashboards. */
export function StatTile({ label, value, hint, icon, tone }: { label: string; value: string; hint?: string; icon?: IconName; tone?: Tone }) {
  const c = useColors();
  return (
    <Card tone={tone} style={{ flex: 1, minWidth: 150 }}>
      <Row>{icon ? <Icon name={icon} size="sm" color={c.textSecondary} /> : null}<Text variant="label" muted style={{ flex: 1 }} numberOfLines={1}>{label}</Text></Row>
      <Text variant="title" numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      {hint ? <Text variant="caption" muted numberOfLines={2}>{hint}</Text> : null}
    </Card>
  );
}

/** Large tappable shortcut (icon over label) for the Home screen's primary actions. */
export function ActionTile({ icon, label, onPress, tone = 'primary' }: { icon: IconName; label: string; onPress: () => void; tone?: 'primary' | 'accent' }) {
  const c = useColors();
  const bg = tone === 'primary' ? c.primary : c.accent;
  const fg = tone === 'primary' ? c.onPrimary : c.onAccent;
  const [scale] = useState(() => new Animated.Value(1));
  const spring = (to: number) => Animated.spring(scale, { toValue: to, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} onPressIn={() => spring(0.96)} onPressOut={() => spring(1)} style={{ flex: 1, minWidth: 140 }}>
      <Animated.View style={[{ transform: [{ scale }], backgroundColor: bg, borderRadius: radius.lg, padding: space.lg, minHeight: 96, justifyContent: 'space-between' }, elevation.card]}>
        <Icon name={icon} size="lg" color={fg} />
        <RNText style={[typeScale.bodyStrong, { color: fg }]}>{label}</RNText>
      </Animated.View>
    </Pressable>
  );
}

/** Row used in lists: optional leading icon, title/subtitle, status badge, trailing content (a chevron appears when it is tappable). */
export function ListRow({ title, subtitle, right, onPress, badge, icon }: { title: string; subtitle?: string; right?: ReactNode; onPress?: () => void; badge?: ReactNode; icon?: IconName }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined} disabled={!onPress} onPress={onPress} android_ripple={{ color: `${c.primary}1A` }}
      style={({ pressed }) => ({
        minHeight: TOUCH + 12, paddingVertical: space.md, paddingHorizontal: space.lg, backgroundColor: pressed ? c.primarySoft : c.card,
        borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border, flexDirection: 'row', alignItems: 'center', gap: space.md,
      })}>
      {icon ? <IconTile name={icon} /> : null}
      <View style={{ flex: 1, gap: space.xxs }}>
        <Text variant="bodyStrong" numberOfLines={1}>{title}</Text>
        {subtitle ? <Text variant="caption" muted numberOfLines={2}>{subtitle}</Text> : null}
        {badge ? <View style={{ marginTop: space.xs }}>{badge}</View> : null}
      </View>
      {right ?? (onPress ? <Icon name="chevron-forward" size="sm" color={c.muted} /> : null)}
    </Pressable>
  );
}

/** A tappable row that navigates to a route. */
export function NavRow({ title, subtitle, to, badge, icon }: { title: string; subtitle?: string; to: string; badge?: ReactNode; icon?: IconName }) {
  const router = useRouter();
  return <ListRow title={title} subtitle={subtitle} badge={badge} icon={icon} onPress={() => router.push(to as never)} />;
}

/* ───────────────────────── States ───────────────────────── */

/** Shimmering placeholder block. Respects layout (fixed height) so content does not jump when data arrives. */
export function Skeleton({ height = 16, width = '100%', radiusPx = radius.sm }: { height?: number; width?: number | `${number}%`; radiusPx?: number }) {
  const c = useColors();
  const [o] = useState(() => new Animated.Value(0.55));
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(o, { toValue: 1, duration: 750, useNativeDriver: true }), Animated.timing(o, { toValue: 0.55, duration: 750, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [o]);
  return <Animated.View accessibilityElementsHidden style={{ height, width, borderRadius: radiusPx, backgroundColor: c.skeleton, opacity: o }} />;
}

/** Placeholder shaped like a list/card while data loads. */
export function Loading({ label }: { label?: string }) {
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={label ?? 'Loading'} style={{ gap: space.lg, paddingVertical: space.sm }}>
      <Card><Skeleton height={14} width="40%" /><Skeleton height={30} width="60%" /><Skeleton height={14} width="80%" /></Card>
      <Card><Skeleton height={14} width="50%" /><Skeleton height={14} width="90%" /><Skeleton height={14} width="70%" /></Card>
      {label ? <Text variant="caption" muted style={{ textAlign: 'center' }}>{label}</Text> : null}
    </View>
  );
}

export function EmptyState({ title, hint, action, icon = 'file-tray-outline' }: { title: string; hint?: string; action?: ReactNode; icon?: IconName }) {
  const c = useColors();
  return (
    <View style={{ padding: space.xxl, alignItems: 'center', gap: space.md }}>
      <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={34} color={c.onPrimarySoft} /></View>
      <Text variant="heading" style={{ textAlign: 'center' }}>{title}</Text>
      {hint ? <Text muted style={{ textAlign: 'center' }}>{hint}</Text> : null}
      {action}
    </View>
  );
}

export function ErrorView({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card tone="danger">
      <Row><Icon name="cloud-offline-outline" size="md" /><Text variant="heading" style={{ flex: 1 }}>We couldn’t load this</Text></Row>
      <Text>{message}</Text>
      {onRetry ? <Button title="Try again" variant="secondary" icon="refresh" onPress={onRetry} /> : null}
    </Card>
  );
}

export type { Colors };
