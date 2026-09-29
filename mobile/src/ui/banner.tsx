import type { ReactNode } from 'react';
import { Text as RNText, View } from 'react-native';
import { font, space, useColors } from './theme';

export function Banner({ tone, children }: { tone: 'danger' | 'warn' | 'ok' | 'info'; children: ReactNode }) {
  const c = useColors();
  return (
    <View accessibilityRole="alert" style={{ backgroundColor: c[`${tone}Soft` as const], paddingVertical: space.sm, paddingHorizontal: space.lg }}>
      <RNText style={{ color: c[tone], fontSize: font.small, fontWeight: '600' }}>{children}</RNText>
    </View>
  );
}
