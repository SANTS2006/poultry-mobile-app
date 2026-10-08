import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../state/app';
import { useAppStore } from '../state/store';
import { LiveNoticeToaster } from '../ui/live-notice';
import { ToastProvider } from '../ui/toast';

/** Route guard: signed-out users only see the (auth) screens; signed-in users only see the app (behind the biometric lock when enabled). */
function Routes() {
  const status = useAppStore((s) => s.status);
  const locked = useAppStore((s) => s.locked);
  const signedIn = status === 'signed_in';
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={signedIn && !locked}><Stack.Screen name="(app)" /></Stack.Protected>
      <Stack.Protected guard={signedIn && locked}><Stack.Screen name="lock" /></Stack.Protected>
      <Stack.Protected guard={!signedIn}><Stack.Screen name="(auth)" /></Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="auto" />
        <AppProvider><ToastProvider><Routes /><LiveNoticeToaster /></ToastProvider></AppProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
