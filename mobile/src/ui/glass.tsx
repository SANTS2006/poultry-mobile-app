import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { ReactNode } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { elevation, radius as radii, useColors, useIsDark } from './theme';

export const IS_IOS = Platform.OS === 'ios';

let liquid: boolean | null = null;
/** True on iOS 26 and later, where the system "liquid glass" material exists. Checked once. */
export function hasLiquidGlass(): boolean {
  if (liquid === null) { try { liquid = IS_IOS && isLiquidGlassAvailable(); } catch { liquid = false; } }
  return liquid;
}

/** Corner radius that looks right on the platform: iOS uses larger, "continuous" (squircle) corners. */
export const cornerRadius = (base: number): number => (IS_IOS ? base + 4 : base);
export const continuous = IS_IOS ? ({ borderCurve: 'continuous' } as const) : ({} as const);

/**
 * A surface in the platform's own material:
 *  • iOS 26+: the system liquid-glass effect (refracts what is behind it);
 *  • iOS 18 and earlier: a system blur material;
 *  • Android: an ordinary elevated card (no glass there).
 * Content goes inside as usual. `radius` is the corner radius; every corner is rounded and clips what is inside it. `solid` puts a nearly opaque
 * card colour under the glass, for surfaces that carry text over busy content (dialogs, menus).
 */
export function GlassSurface({ children, style, radius = radii.lg, tint, interactive, solid }: { children?: ReactNode; style?: StyleProp<ViewStyle>; radius?: number; tint?: string; interactive?: boolean; solid?: boolean }) {
  const c = useColors();
  const dark = useIsDark();
  const r = cornerRadius(radius);
  const backing = solid ? { backgroundColor: `${c.card}F2` } : null; // F2 = 95 % opaque
  if (hasLiquidGlass()) {
    return (
      <GlassView glassEffectStyle="regular" colorScheme={dark ? 'dark' : 'light'} tintColor={tint} isInteractive={interactive} style={[{ borderRadius: r, overflow: 'hidden', ...continuous }, backing, style]}>
        {children}
      </GlassView>
    );
  }
  if (IS_IOS) {
    return (
      <View style={[{ borderRadius: r, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, ...continuous }, backing, style]}>
        <BlurView intensity={55} tint={dark ? 'systemThickMaterialDark' : 'systemThickMaterialLight'} style={StyleSheet.absoluteFill} />
        {tint ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tint, opacity: 0.18 }]} /> : null}
        {children}
      </View>
    );
  }
  // overflow: hidden is what makes every corner round: without it, rows inside (with their own background) poke out of the bottom corners.
  return <View style={[{ borderRadius: r, backgroundColor: c.card, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, overflow: 'hidden' }, elevation.card, style]}>{children}</View>;
}

/**
 * Soft colour behind the content so glass has something to refract (glass over a flat colour just looks grey). iOS only; elsewhere nothing
 * is drawn. Purely decorative and hidden from screen readers.
 */
export function GlassBackdrop() {
  const c = useColors();
  if (!IS_IOS) return null;
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <RadialGradient id="g1" cx="85%" cy="6%" rx="70%" ry="38%" fx="85%" fy="6%"><Stop offset="0" stopColor={c.primary} stopOpacity="0.22" /><Stop offset="1" stopColor={c.primary} stopOpacity="0" /></RadialGradient>
          <RadialGradient id="g2" cx="6%" cy="42%" rx="60%" ry="30%" fx="6%" fy="42%"><Stop offset="0" stopColor={c.accent} stopOpacity="0.20" /><Stop offset="1" stopColor={c.accent} stopOpacity="0" /></RadialGradient>
          <RadialGradient id="g3" cx="80%" cy="92%" rx="70%" ry="34%" fx="80%" fy="92%"><Stop offset="0" stopColor={c.info} stopOpacity="0.16" /><Stop offset="1" stopColor={c.info} stopOpacity="0" /></RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#g1)" /><Rect width="100%" height="100%" fill="url(#g2)" /><Rect width="100%" height="100%" fill="url(#g3)" />
      </Svg>
    </View>
  );
}
