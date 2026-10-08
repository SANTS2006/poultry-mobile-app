import { Stack } from 'expo-router';
import { useColors } from '../../ui/theme';

export const unstable_settings = { initialRouteName: 'login' };

export default function AuthLayout() {
  const c = useColors();
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: c.bg }, headerTintColor: c.text, headerShadowVisible: false, headerBackButtonDisplayMode: 'minimal', contentStyle: { backgroundColor: c.bg } }}>
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="welcome" options={{ headerShown: false, animation: 'fade' }} />
      <Stack.Screen name="first-password" options={{ headerShown: false }} />
      <Stack.Screen name="forgot-password" options={{ headerShown: false }} />
      <Stack.Screen name="reset-password" options={{ headerShown: false }} />
      <Stack.Screen name="mfa" options={{ title: 'Verification code' }} />
      <Stack.Screen name="mfa-setup" options={{ title: 'Set up two-step sign-in', headerBackVisible: false }} />
    </Stack>
  );
}
