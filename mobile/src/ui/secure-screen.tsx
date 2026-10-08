import { usePreventScreenCapture } from 'expo-screen-capture';
import { useEffect, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { Icon } from './icon';
import { Text } from './text-lite';
import { useColors } from './theme';

/**
 * Blocks screenshots and screen recording (and hides the screen in the Android recent-apps list) while the calling screen is mounted.
 * Use on screens that show passwords, recovery codes or authenticator keys.
 */
export function useSecureScreen(): void {
  usePreventScreenCapture();
}

/**
 * Covers the app with the brand screen whenever it is not in the foreground (app switcher, notification shade, incoming call), so
 * balances, customers and other business data never show in the phone's thumbnails.
 */
export function PrivacyShield() {
  const c = useColors();
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setCovered(s === 'inactive' || s === 'background'));
    return () => sub.remove();
  }, []);
  // System sheets (photo picker, permission prompts, Face ID) make iOS report "inactive" and a missed "active" event must never leave the
  // cover stuck on screen, so while covered the real state is re-checked every second.
  useEffect(() => {
    if (!covered) return;
    const t = setInterval(() => { if (AppState.currentState === 'active') setCovered(false); }, 1000);
    return () => clearInterval(t);
  }, [covered]);
  if (!covered) return null;
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[StyleSheet.absoluteFill, { backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', gap: 12, zIndex: 2000, elevation: 2000 }]}>
      <Icon name="egg" size={64} color={c.accent} />
      <Text variant="title" color={c.onPrimary}>Makarifor</Text>
    </View>
  );
}
