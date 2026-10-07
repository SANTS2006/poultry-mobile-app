import { Tabs } from 'expo-router';
import { Platform } from 'react-native';
import { useCan, useCanAny } from '../../../state/store';
import { HeaderActions } from '../../../ui/header-actions';
import { Icon, type IconName } from '../../../ui/icon';
import { typeScale, useColors } from '../../../ui/theme';

const tab = (outline: IconName, filled: IconName) => function TabIcon({ focused, color }: { focused: boolean; color: string | object }) {
  return <Icon name={focused ? filled : outline} size="md" color={String(color)} />;
};

/** Tabs are shown only for areas the user may use. (The server enforces permissions regardless.) */
export default function TabsLayout() {
  const c = useColors();
  const dashboard = useCan('dashboard.read');
  const production = useCan('production.read');
  const sales = useCan('sales.read');
  const stock = useCan('inventory.read');
  const canRecord = useCanAny('production.create', 'sales.create');
  const anyHome = dashboard || canRecord;
  return (
    <Tabs screenOptions={{
      headerStyle: { backgroundColor: c.bg }, headerShadowVisible: false, headerTintColor: c.text, headerTitleStyle: { ...typeScale.heading, color: c.text }, headerRight: () => <HeaderActions />,
      headerTitleAlign: 'left',
      tabBarActiveTintColor: c.primary, tabBarInactiveTintColor: c.muted, tabBarLabelStyle: { ...typeScale.caption, fontWeight: '600' },
      tabBarStyle: { backgroundColor: c.card, borderTopColor: c.border, height: Platform.OS === 'ios' ? 88 : 68, paddingTop: 6 },
      sceneStyle: { backgroundColor: c.bg },
    }}>
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: tab('home-outline', 'home'), href: anyHome ? undefined : null }} />
      <Tabs.Screen name="production" options={{ title: 'Production', tabBarIcon: tab('egg-outline', 'egg'), href: production ? undefined : null }} />
      <Tabs.Screen name="sales" options={{ title: 'Sales', tabBarIcon: tab('receipt-outline', 'receipt'), href: sales ? undefined : null }} />
      <Tabs.Screen name="stock" options={{ title: 'Stock', tabBarIcon: tab('cube-outline', 'cube'), href: stock ? undefined : null }} />
      <Tabs.Screen name="more" options={{ title: 'More', tabBarIcon: tab('menu-outline', 'menu') }} />
    </Tabs>
  );
}
