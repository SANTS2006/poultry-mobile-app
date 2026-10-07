import { Stack } from 'expo-router';
import { RecoveryCodes } from '../../features/RecoveryCodes';
import { useAuthFlow } from '../../state/auth-flow';
import { typeScale, useColors } from '../../ui/theme';

export default function AppLayout() {
  const c = useColors();
  const codes = useAuthFlow((s) => s.recoveryCodes);
  // Freshly created recovery codes are shown once, before anything else.
  if (codes) return <RecoveryCodes codes={codes} onDone={() => useAuthFlow.getState().clear()} />;
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: c.bg }, headerShadowVisible: false, headerTintColor: c.text, headerTitleStyle: { ...typeScale.heading, color: c.text }, headerBackButtonDisplayMode: 'minimal', contentStyle: { backgroundColor: c.bg }, animation: 'slide_from_right' }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="production/new" options={{ title: 'Record production' }} />
      <Stack.Screen name="production/[id]" options={{ title: 'Production record' }} />
      <Stack.Screen name="sales/new" options={{ title: 'New sale' }} />
      <Stack.Screen name="sales/[id]" options={{ title: 'Sale' }} />
      <Stack.Screen name="customers/index" options={{ title: 'Customers' }} />
      <Stack.Screen name="customers/new" options={{ title: 'New customer' }} />
      <Stack.Screen name="customers/[id]" options={{ title: 'Customer' }} />
      <Stack.Screen name="expenses/index" options={{ title: 'Expenses' }} />
      <Stack.Screen name="expenses/new" options={{ title: 'New expense' }} />
      <Stack.Screen name="inventory/adjust" options={{ title: 'Adjust stock' }} />
      <Stack.Screen name="inventory/history" options={{ title: 'Stock history' }} />
      <Stack.Screen name="payments/new" options={{ title: 'Record payment' }} />
      <Stack.Screen name="reports/index" options={{ title: 'Reports' }} />
      <Stack.Screen name="reports/[name]" options={{ title: 'Report' }} />
      <Stack.Screen name="notifications/index" options={{ title: 'Notifications' }} />
      <Stack.Screen name="notifications/preferences" options={{ title: 'Notification settings' }} />
      <Stack.Screen name="sync" options={{ title: 'Sync' }} />
      <Stack.Screen name="settings/index" options={{ title: 'Settings' }} />
      <Stack.Screen name="settings/password" options={{ title: 'Change password' }} />
      <Stack.Screen name="settings/mfa" options={{ title: 'Two-step sign-in' }} />
      <Stack.Screen name="settings/sessions" options={{ title: 'Devices and sessions' }} />
      <Stack.Screen name="admin/index" options={{ title: 'Administration' }} />
      <Stack.Screen name="admin/users" options={{ title: 'Users' }} />
      <Stack.Screen name="admin/user/[id]" options={{ title: 'User' }} />
      <Stack.Screen name="admin/invite" options={{ title: 'Invite user' }} />
      <Stack.Screen name="admin/audit" options={{ title: 'Audit log' }} />
      <Stack.Screen name="admin/prices" options={{ title: 'Prices' }} />
      <Stack.Screen name="admin/notification-settings" options={{ title: 'Notification rules' }} />
    </Stack>
  );
}
