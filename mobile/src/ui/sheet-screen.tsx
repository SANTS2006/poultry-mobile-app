import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { Screen, Text } from './components';
import { GlassSurface } from './glass';
import { Icon } from './icon';
import { space, TOUCH, useColors } from './theme';

/** Round close button (a small glass disc on iOS). */
export function CloseButton({ label = 'Close' }: { label?: string }) {
  const router = useRouter();
  const c = useColors();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => router.back()} hitSlop={8}>
      <GlassSurface radius={TOUCH / 2} interactive style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="close" size="sm" color={c.text} />
      </GlassSurface>
    </Pressable>
  );
}

/**
 * Content of a bottom-sheet form (presented by the navigator as a native sheet: swipe down or tap ✕ to close). Used for adding and
 * editing things; bigger forms are presented as full-screen modals instead.
 */
export function SheetScreen({ title, children, subtitle, refreshing, onRefresh }: { title: string; subtitle?: string; children: ReactNode; refreshing?: boolean; onRefresh?: () => void }) {
  const c = useColors();
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm }}>
        <View style={{ flex: 1, gap: space.xxs }}>
          <Text variant="title" accessibilityRole="header">{title}</Text>
          {subtitle ? <Text variant="caption" color={c.textSecondary}>{subtitle}</Text> : null}
        </View>
        <CloseButton />
      </View>
      <Screen refreshing={refreshing} onRefresh={onRefresh}>{children}</Screen>
    </View>
  );
}
