import { View } from 'react-native';
import { avatarUrl, useBearer } from '../../queries/chat';
import { useChatLive } from '../../state/chat-live';
import { Avatar } from '../components';
import { useColors } from '../theme';

/** A person's or group's picture (or initials), with an optional green "online" dot. */
export function ChatAvatar({ name, size = 48, userId, groupId, hasAvatar, version, online }: {
  name: string; size?: number; userId?: string | null; groupId?: string; hasAvatar?: boolean; version?: number; online?: boolean;
}) {
  const c = useColors();
  const headers = useBearer();
  const live = useChatLive((s) => (userId ? s.online[userId] : undefined));
  const uri = hasAvatar && headers ? (groupId ? avatarUrl('group', groupId, version ?? 0) : userId ? avatarUrl('user', userId, version ?? 0) : null) : null;
  const isOnline = live ?? online ?? false;
  return (
    <View>
      <Avatar name={name} size={size} uri={uri} headers={headers} />
      {isOnline && userId ? <View accessibilityLabel="Online" style={{ position: 'absolute', right: 0, bottom: 0, width: Math.max(12, size * 0.3), height: Math.max(12, size * 0.3), borderRadius: size, backgroundColor: c.ok, borderWidth: 2, borderColor: c.bg }} /> : null}
    </View>
  );
}
