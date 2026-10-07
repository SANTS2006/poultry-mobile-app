import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useCan, useCanAny } from '../../../state/store';
import { useUnreadCount } from '../../../queries/hooks';
import { useColors } from '../../../ui/theme';

const glyph = (g: string) => function TabGlyph() { return <Text style={{ fontSize: 20 }}>{g}</Text>; };

/** Tabs are shown only for areas the user may use. (The server enforces permissions regardless.) */
export default function TabsLayout() {
  const c = useColors();
  const dashboard = useCan('dashboard.read');
  const production = useCan('production.read');
  const sales = useCan('sales.read');
  const stock = useCan('inventory.read');
  const unread = useUnreadCount().data?.unread ?? 0;
  const canRecord = useCanAny('production.create', 'sales.create');
  const anyHome = dashboard || canRecord;
  return (
    <Tabs screenOptions={{
      headerStyle: { backgroundColor: c.card }, headerTintColor: c.text, tabBarActiveTintColor: c.primary, tabBarInactiveTintColor: c.muted,
      tabBarStyle: { backgroundColor: c.card, borderTopColor: c.border }, sceneStyle: { backgroundColor: c.bg },
    }}>
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: glyph('🏠'), href: anyHome ? undefined : null }} />
      <Tabs.Screen name="production" options={{ title: 'Production', tabBarIcon: glyph('🥚'), href: production ? undefined : null }} />
      <Tabs.Screen name="sales" options={{ title: 'Sales', tabBarIcon: glyph('🧾'), href: sales ? undefined : null }} />
      <Tabs.Screen name="stock" options={{ title: 'Stock', tabBarIcon: glyph('📦'), href: stock ? undefined : null }} />
      <Tabs.Screen name="more" options={{ title: 'More', tabBarIcon: glyph('☰'), tabBarBadge: unread > 0 ? (unread > 99 ? '99+' : unread) : undefined }} />
    </Tabs>
  );
}
