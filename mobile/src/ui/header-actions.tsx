import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { useUnreadCount } from '../queries/hooks';
import { useAppStore } from '../state/store';
import { Avatar, Text } from './components';
import { Icon } from './icon';
import { radius, space, TOUCH, useColors } from './theme';

/** "3 unread notifications" / "No unread notifications" — for screen readers and tests. */
export const unreadLabel = (n: number) => (n > 0 ? `Notifications, ${n} unread` : 'Notifications, none unread');

/** Bell with a live unread count. The count is refreshed the moment the server announces a new notification (see services/realtime). */
export function NotificationBell() {
  const router = useRouter();
  const c = useColors();
  const unread = useUnreadCount().data?.unread ?? 0;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={unreadLabel(unread)} onPress={() => router.push('/notifications')} hitSlop={6} style={{ width: TOUCH, height: TOUCH, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={unread > 0 ? 'notifications' : 'notifications-outline'} size="md" color={c.text} />
      {unread > 0 ? (
        <View style={{ position: 'absolute', top: 4, right: 2, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: radius.pill, backgroundColor: c.danger, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: c.bg }}>
          <Text variant="caption" bold color={c.onDanger} style={{ fontSize: 10, lineHeight: 12 }}>{unread > 99 ? '99+' : unread}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** The signed-in user's picture (or initials). Opens Settings. */
export function ProfileButton({ size = 34 }: { size?: number }) {
  const router = useRouter();
  const user = useAppStore((s) => s.user);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Your profile and settings" onPress={() => router.push('/settings')} hitSlop={6} style={{ width: TOUCH, height: TOUCH, alignItems: 'center', justifyContent: 'center' }}>
      <Avatar name={user?.fullName ?? '?'} uri={user?.avatar} size={size} />
    </Pressable>
  );
}

/** Top-right of every main screen: notifications, then profile. */
export function HeaderActions() {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, marginRight: space.sm }}><NotificationBell /><ProfileButton /></View>;
}
