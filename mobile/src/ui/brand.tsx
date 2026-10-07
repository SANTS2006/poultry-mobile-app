import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from './components';
import { Icon, type IconName } from './icon';
import { elevation, radius, space, useColors } from './theme';

/** The Makarifor mark: a yolk-amber egg on deep green. One simple, recognisable shape; no gradients. */
export function BrandMark({ size = 64 }: { size?: number }) {
  const c = useColors();
  return (
    <View accessibilityLabel="Makarifor Poultry" accessibilityRole="image" style={[{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' }, elevation.card]}>
      <Icon name="egg" size={size * 0.56} color={c.accent} />
    </View>
  );
}

/** Icon + title + one-line explanation at the top of auth/recovery screens, so each step says what it is for. */
export function AuthHeader({ icon, title, subtitle }: { icon: IconName; title: string; subtitle?: string }) {
  const c = useColors();
  return (
    <View style={{ gap: space.md, alignItems: 'flex-start', paddingTop: space.sm }}>
      <View style={{ width: 52, height: 52, borderRadius: radius.md, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size="lg" color={c.primary} /></View>
      <Text variant="title" accessibilityRole="header">{title}</Text>
      {subtitle ? <Text muted>{subtitle}</Text> : null}
    </View>
  );
}

/** Large, calm confirmation for the end of a flow (password changed, account ready…). */
export function SuccessPanel({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  const c = useColors();
  return (
    <View style={{ alignItems: 'center', gap: space.md, paddingVertical: space.xl }}>
      <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: c.okSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="checkmark-circle" size={48} color={c.ok} /></View>
      <Text variant="title" style={{ textAlign: 'center' }} accessibilityRole="header">{title}</Text>
      <Text muted style={{ textAlign: 'center' }}>{body}</Text>
      {children}
    </View>
  );
}
