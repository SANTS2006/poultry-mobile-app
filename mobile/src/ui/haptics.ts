import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/** Light taps on iOS (the platform where they are part of the design language); never throws and does nothing elsewhere. */
const run = (fn: () => Promise<void>) => { if (Platform.OS === 'ios') void fn().catch(() => undefined); };
export const tapHaptic = () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
export const selectHaptic = () => run(() => Haptics.selectionAsync());
export const successHaptic = () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
export const warnHaptic = () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
export const errorHaptic = () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
