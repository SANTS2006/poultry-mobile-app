import { Stack } from 'expo-router';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../state/app';
import { useAppStore } from '../state/store';
import { DialogProvider } from '../ui/dialog';
import { LiveNoticeToaster } from '../ui/live-notice';
import { BusyOverlay } from '../ui/loaders';
import { PrivacyShield } from '../ui/secure-screen';
import { useColors, useIsDark } from '../ui/theme';
import { ToastProvider } from '../ui/toast';

/** Route guard: signed-out users only see the (auth) screens; signed-in users only see the app (behind the biometric lock when enabled). */
function Routes() {
  const c = useColors();
  const status = useAppStore((s) => s.status);
  const locked = useAppStore((s) => s.locked);
  const signedIn = status === 'signed_in';
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg } }}>
      <Stack.Protected guard={signedIn && !locked}><Stack.Screen name="(app)" /></Stack.Protected>
      <Stack.Protected guard={signedIn && locked}><Stack.Screen name="lock" /></Stack.Protected>
      <Stack.Protected guard={!signedIn}><Stack.Screen name="(auth)" /></Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  const c = useColors();
  const dark = useIsDark();
  // The window behind every screen follows the theme, so nothing white shows behind the header or during transitions in dark mode.
  useEffect(() => { SystemUI.setBackgroundColorAsync(c.bg).catch(() => undefined); }, [c.bg]);
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: c.bg }}>
      <SafeAreaProvider style={{ backgroundColor: c.bg }}>
        <StatusBar style={dark ? 'light' : 'dark'} />
        <View style={{ flex: 1, backgroundColor: c.bg }}>
        <AppProvider><ToastProvider><DialogProvider><Routes /><LiveNoticeToaster /><BusyOverlay /><PrivacyShield /></DialogProvider></ToastProvider></AppProvider>
        </View>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
