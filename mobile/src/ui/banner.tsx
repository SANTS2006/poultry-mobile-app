import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Icon } from './icon';
import { Text } from './text-lite';
import { space, useColors } from './theme';

const ICON = { danger: 'alert-circle', warn: 'cloud-offline', ok: 'checkmark-circle', info: 'sync' } as const;

/** Full-width status strip (offline, sending, needs attention). Icon + text, so it never relies on colour alone. */
export function Banner({ tone, children }: { tone: 'danger' | 'warn' | 'ok' | 'info'; children: ReactNode }) {
  const c = useColors();
  const fg = tone === 'warn' ? c.warn : c[tone];
  return (
    <View accessibilityRole="alert" style={{ backgroundColor: c[`${tone}Soft` as const], paddingVertical: space.sm + 2, paddingHorizontal: space.lg, flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <Icon name={ICON[tone]} size="sm" color={fg} />
      <Text variant="label" color={fg} style={{ flex: 1 }}>{children}</Text>
    </View>
  );
}
