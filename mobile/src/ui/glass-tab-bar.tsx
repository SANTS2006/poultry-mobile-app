import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from './components';
import { GlassSurface } from './glass';
import { selectHaptic } from './haptics';
import { radius, space, useColors } from './theme';

interface Route { key: string; name: string }
interface Options { title?: string; href?: string | null; tabBarIcon?: (p: { focused: boolean; color: string; size: number }) => ReactNode; tabBarBadge?: string | number }
export interface GlassTabBarProps {
  state: { index: number; routes: Route[] };
  descriptors: Record<string, { options: Options }>;
  navigation: { emit(e: { type: 'tabPress'; target: string; canPreventDefault: true }): { defaultPrevented: boolean }; navigate(name: string): void };
}

/**
 * iOS tab bar: a floating glass capsule near the bottom edge (liquid glass on iOS 26, a blur material before). The selected tab sits in a
 * soft pill. Screens leave room for it through their bottom padding.
 */
export function GlassTabBar({ state, descriptors, navigation }: GlassTabBarProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const visible = state.routes.filter((r) => descriptors[r.key]?.options.href !== null);
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: space.lg, right: space.lg, bottom: Math.max(insets.bottom, space.md) }}>
      <GlassSurface radius={radius.pill} style={{ flexDirection: 'row', padding: space.xs, gap: space.xs }}>
        {visible.map((route) => {
          const { options } = descriptors[route.key]!;
          const focused = state.routes[state.index]?.key === route.key;
          const color = focused ? c.primary : c.textSecondary;
          const label = options.title ?? route.name;
          return (
            <Pressable
              key={route.key} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: focused }}
              onPress={() => {
                const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                if (!focused && !e.defaultPrevented) { selectHaptic(); navigation.navigate(route.name); }
              }}
              style={{ flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, backgroundColor: focused ? c.primarySoft : 'transparent', gap: 2 }}
            >
              {options.tabBarIcon?.({ focused, color, size: 22 })}
              <Text variant="caption" color={color} numberOfLines={1} style={{ fontSize: 10, fontWeight: focused ? '700' : '500' }}>{label}</Text>
              {options.tabBarBadge ? <View style={{ position: 'absolute', top: 4, right: '22%', minWidth: 16, height: 16, borderRadius: 8, backgroundColor: c.danger, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 }}><Text variant="caption" color={c.onDanger} style={{ fontSize: 9 }}>{options.tabBarBadge}</Text></View> : null}
            </Pressable>
          );
        })}
      </GlassSurface>
    </View>
  );
}
