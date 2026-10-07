import Constants from 'expo-constants';
import * as Device from 'expo-device';
import type * as NotificationsModule from 'expo-notifications';
import { IS_EXPO_GO } from '../lib/runtime';
import { Platform } from 'react-native';
import type { Endpoints } from '../api/endpoints';

type Notifications = typeof NotificationsModule;
/** expo-notifications is loaded lazily and never inside Expo Go (Expo Go removed remote push; importing it there only logs errors). */
export function loadNotifications(): Notifications | null {
  if (IS_EXPO_GO) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-notifications') as Notifications;
}

/** Android notification channels; ids match the ones the server sends (backend/src/notifications/notification.types.ts). */
const channels = (N: Notifications): { id: string; name: string; importance: NotificationsModule.AndroidImportance }[] => [
  { id: 'production', name: 'Production', importance: N.AndroidImportance.DEFAULT },
  { id: 'inventory', name: 'Inventory', importance: N.AndroidImportance.DEFAULT },
  { id: 'sales', name: 'Sales', importance: N.AndroidImportance.DEFAULT },
  { id: 'expenses', name: 'Expenses', importance: N.AndroidImportance.DEFAULT },
  { id: 'payments', name: 'Payments', importance: N.AndroidImportance.DEFAULT },
  { id: 'security', name: 'Security alerts', importance: N.AndroidImportance.HIGH },
  { id: 'sync', name: 'Sync', importance: N.AndroidImportance.LOW },
  { id: 'admin', name: 'Administration', importance: N.AndroidImportance.DEFAULT },
  { id: 'system', name: 'System', importance: N.AndroidImportance.DEFAULT },
  { id: 'summary', name: 'Daily summary', importance: N.AndroidImportance.LOW },
];

/** Foreground behaviour: show the banner (the app also refreshes its badge through realtime). */
export function configureForegroundNotifications(): void {
  const N = loadNotifications();
  if (!N) return;
  N.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
  });
}

export type PushRegistration =
  | { ok: true; token: string }
  | { ok: false; reason: 'expo_go' | 'not_a_device' | 'permission_denied' | 'no_project_id' | 'error'; detail?: string };

/**
 * Asks for permission (only when needed), obtains the Expo push token and registers it with the server for the signed-in user.
 * Push is convenience: everything important is also in the in-app notification center, so a failure here is reported, never fatal.
 */
export async function registerForPush(api: Endpoints, askPermission = true): Promise<PushRegistration> {
  const N = loadNotifications();
  if (!N) return { ok: false, reason: 'expo_go' };
  if (!Device.isDevice) return { ok: false, reason: 'not_a_device' };
  try {
    if (Platform.OS === 'android') for (const c of channels(N)) await N.setNotificationChannelAsync(c.id, { name: c.name, importance: c.importance });
    let { status } = await N.getPermissionsAsync();
    if (status !== 'granted' && askPermission) status = (await N.requestPermissionsAsync()).status;
    if (status !== 'granted') return { ok: false, reason: 'permission_denied' };
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId || projectId.startsWith('REPLACE')) return { ok: false, reason: 'no_project_id' };
    const { data: token } = await N.getExpoPushTokenAsync({ projectId });
    await api.notifications.registerDevice(token, Platform.OS === 'ios' ? 'ios' : 'android', Device.deviceName ?? Device.modelName ?? undefined);
    return { ok: true, token };
  } catch (e) {
    return { ok: false, reason: 'error', detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function unregisterPush(api: Endpoints): Promise<void> {
  const N = loadNotifications();
  if (!N) return;
  try {
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
    if (!projectId || projectId.startsWith('REPLACE') || !Device.isDevice) return;
    const { data } = await N.getExpoPushTokenAsync({ projectId });
    await api.notifications.unregisterDevice(data);
  } catch { /* offline or never registered: the server also drops tokens the push service reports as gone */ }
}

/**
 * Where a tapped notification should open. The push payload carries ids only (never amounts or names); the target screen loads
 * details through the authenticated API, so a stolen lock-screen banner reveals nothing.
 */
export function routeForNotification(data: { notificationId?: string; entityType?: string | null; entityId?: string | null; type?: string } | null | undefined): string {
  if (!data) return '/notifications';
  switch (data.entityType) {
    case 'sale': return data.entityId ? `/sales/${data.entityId}` : '/sales';
    case 'production_record': return data.entityId ? `/production/${data.entityId}` : '/production';
    case 'expense': return '/expenses';
    case 'sync': return '/sync';
    default: return '/notifications';
  }
}
