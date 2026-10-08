import { Stack } from 'expo-router';
import { RecoveryCodes } from '../../features/RecoveryCodes';
import { useAuthFlow } from '../../state/auth-flow';
import { CloseButton } from '../../ui/sheet-screen';
import { typeScale, useColors } from '../../ui/theme';

export default function AppLayout() {
  const c = useColors();
  const codes = useAuthFlow((s) => s.recoveryCodes);
  // Freshly created recovery codes are shown once, before anything else.
  // Add/edit forms open as bottom sheets (swipe down to close); the longer forms open as full-screen modals with a close button.
  const sheet = { presentation: 'formSheet', headerShown: false, sheetAllowedDetents: [0.78, 1] as number[], sheetInitialDetentIndex: 0, sheetGrabberVisible: true, sheetCornerRadius: 28, sheetExpandsWhenScrolledToEdge: true, contentStyle: { backgroundColor: c.bg }, animation: 'slide_from_bottom' } as const;
  const modal = { presentation: 'fullScreenModal', animation: 'slide_from_bottom', headerBackVisible: false, headerLeft: () => <CloseButton label="Close form" /> } as const;
  if (codes) return <RecoveryCodes codes={codes} onDone={() => useAuthFlow.getState().clear()} />;
  return (
    <Stack screenOptions={{
      // The header always matches the screen, so dark mode never shows a white bar behind the title and status bar.
      headerStyle: { backgroundColor: c.bg }, headerShadowVisible: false, headerTintColor: c.text, headerTitleStyle: { ...typeScale.heading, color: c.text },
      headerBackButtonDisplayMode: 'minimal', contentStyle: { backgroundColor: c.bg }, animation: 'slide_from_right',
    }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="production/new" options={{ ...modal, title: 'Record production' }} />
      <Stack.Screen name="production/[id]" options={sheet} />
      <Stack.Screen name="sales/new" options={{ ...modal, title: 'New sale' }} />
      <Stack.Screen name="sales/[id]" options={{ ...modal, title: 'Sale' }} />
      <Stack.Screen name="customers/index" options={{ title: 'Customers' }} />
      <Stack.Screen name="customers/new" options={sheet} />
      <Stack.Screen name="customers/[id]" options={{ ...modal, title: 'Customer' }} />
      <Stack.Screen name="expenses/index" options={{ title: 'Expenses' }} />
      <Stack.Screen name="expenses/new" options={{ ...modal, title: 'New expense' }} />
      <Stack.Screen name="inventory/adjust" options={sheet} />
      <Stack.Screen name="inventory/history" options={{ title: 'Stock history' }} />
      <Stack.Screen name="inventory/[id]" options={sheet} />
      <Stack.Screen name="payments/new" options={sheet} />
      <Stack.Screen name="reports/index" options={{ title: 'Reports' }} />
      <Stack.Screen name="reports/[name]" options={{ title: 'Report' }} />
      <Stack.Screen name="notifications/index" options={{ title: 'Notifications' }} />
      <Stack.Screen name="notifications/[id]" options={sheet} />
      <Stack.Screen name="notifications/preferences" options={{ title: 'Notification settings' }} />
      <Stack.Screen name="sync" options={{ title: 'Sync' }} />
      <Stack.Screen name="settings/index" options={{ title: 'Settings' }} />
      <Stack.Screen name="settings/profile" options={sheet} />
      <Stack.Screen name="settings/email" options={sheet} />
      <Stack.Screen name="settings/password" options={sheet} />
      <Stack.Screen name="settings/mfa" options={{ title: 'Two-step sign-in' }} />
      <Stack.Screen name="settings/sessions" options={{ title: 'Devices and sessions' }} />
      <Stack.Screen name="admin/index" options={{ title: 'Administration' }} />
      <Stack.Screen name="admin/users" options={{ title: 'Users' }} />
      <Stack.Screen name="admin/user/[id]" options={{ ...modal, title: 'User' }} />
      <Stack.Screen name="admin/invite" options={sheet} />
      <Stack.Screen name="admin/audit" options={{ title: 'Audit log' }} />
      <Stack.Screen name="admin/coops" options={{ title: 'Coops' }} />
      <Stack.Screen name="admin/coop" options={sheet} />
      <Stack.Screen name="admin/prices" options={{ title: 'Prices' }} />
      <Stack.Screen name="admin/notification-settings" options={{ title: 'Notification rules' }} />
    </Stack>
  );
}
