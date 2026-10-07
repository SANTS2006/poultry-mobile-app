import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { ICON, useColors } from './theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

/**
 * One icon set (Ionicons, outline style) for the whole app. Icons are decorative by default and hidden from screen readers —
 * the text next to them carries the meaning. Pass `label` only for an icon that stands alone.
 */
export function Icon({ name, size = 'md', color, label }: { name: IconName; size?: keyof typeof ICON | number; color?: string; label?: string }) {
  const c = useColors();
  const px = typeof size === 'number' ? size : ICON[size];
  return (
    <Ionicons
      name={name} size={px} color={color ?? c.textSecondary}
      accessible={!!label} accessibilityLabel={label} accessibilityElementsHidden={!label} importantForAccessibility={label ? 'yes' : 'no-hide-descendants'}
    />
  );
}
