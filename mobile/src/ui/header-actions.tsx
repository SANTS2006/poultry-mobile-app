import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnreadCount } from '../queries/hooks';
import { useSignOut } from '../state/sign-out';
import { useThemeMode } from '../state/use-theme-mode';
import { useAppStore } from '../state/store';
import { Avatar, Text } from './components';
import { GlassSurface, IS_IOS } from './glass';
import { Icon, type IconName } from './icon';
import { elevation, radius, space, TOUCH, useColors, useIsDark } from './theme';

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

const roleLabel = (r: string) => r.toLowerCase().replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());

/** The signed-in user's picture (or initials). Opens a small menu: Settings and Log out. */
export function ProfileButton({ size = 34 }: { size?: number }) {
  const router = useRouter();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const user = useAppStore((s) => s.user);
  const { signOut, busy } = useSignOut();
  const theme = useThemeMode();
  const dark = useIsDark();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel="Your profile menu" accessibilityState={{ expanded: open }} onPress={() => setOpen(true)} hitSlop={6} style={{ width: TOUCH, height: TOUCH, alignItems: 'center', justifyContent: 'center' }}>
        <Avatar name={user?.fullName ?? '?'} uri={user?.avatar} size={size} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
        <Pressable accessibilityLabel="Close menu" style={{ flex: 1, backgroundColor: c.overlay }} onPress={close}>
          <Pressable accessibilityViewIsModal onPress={() => undefined} style={{ position: 'absolute', top: insets.top + 56, right: space.lg, width: 280 }}>
            <GlassSurface solid radius={radius.lg} style={elevation.float}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg }}>
              <Avatar name={user?.fullName ?? '?'} uri={user?.avatar} size={48} />
              <View style={{ flex: 1 }}>
                <Text variant="bodyStrong" numberOfLines={1}>{user?.fullName}</Text>
                <Text variant="caption" muted numberOfLines={1}>{user?.email}</Text>
                <Text variant="caption" color={c.primary} numberOfLines={1}>{user?.roles.map(roleLabel).join(', ')}</Text>
              </View>
            </View>
            <MenuItem icon={dark ? 'sunny-outline' : 'moon-outline'} label={dark ? 'Light mode' : 'Dark mode'} onPress={() => { theme.setMode(dark ? 'light' : 'dark'); close(); }} />
            <MenuItem icon="settings-outline" label="Settings" onPress={() => { close(); router.push('/settings'); }} />
            <MenuItem icon="log-out-outline" label="Log out" danger busy={busy} onPress={() => { close(); signOut(); }} />
            </GlassSurface>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function MenuItem({ icon, label, onPress, danger, busy }: { icon: IconName; label: string; onPress: () => void; danger?: boolean; busy?: boolean }) {
  const c = useColors();
  const color = danger ? c.danger : c.text;
  return (
    <Pressable accessibilityRole="menuitem" accessibilityLabel={label} disabled={busy} onPress={onPress} android_ripple={{ color: `${c.primary}1A` }}
      style={({ pressed }) => ({ minHeight: TOUCH, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, borderTopWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.primarySoft : IS_IOS ? 'transparent' : c.card, opacity: busy ? 0.5 : 1 })}>
      <Icon name={icon} size="md" color={color} />
      <Text variant="bodyStrong" color={color}>{label}</Text>
    </Pressable>
  );
}

/** Top-right of every main screen: notifications, then profile. */
export function HeaderActions() {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, marginRight: space.sm }}><NotificationBell /><ProfileButton /></View>;
}
