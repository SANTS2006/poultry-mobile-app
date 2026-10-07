import type { ReactNode } from 'react';
import { Text as RNText, type StyleProp, type TextStyle } from 'react-native';
import { typeScale, useColors } from './theme';
import type { TypeRole } from './tokens';

/** Minimal themed text for low-level pieces (banner, icon-adjacent labels) that components.tsx itself depends on. */
export function Text({ children, variant = 'body', color, style }: { children?: ReactNode; variant?: TypeRole; color?: string; style?: StyleProp<TextStyle> }) {
  const c = useColors();
  return <RNText style={[typeScale[variant], { color: color ?? c.text }, style]}>{children}</RNText>;
}
