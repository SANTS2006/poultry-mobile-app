import { Stack } from 'expo-router';
import { Pressable, View } from 'react-native';
import type { CallHistoryItem } from '../../api/endpoints';
import { formatDuration, listTime } from '../../lib/chat/messages';
import { getCallManager } from '../../services/call-bridge';
import { callsSupported } from '../../services/webrtc-engine';
import { useApp, useEndpoints } from '../../state/app';
import { Text } from '../../ui/components';
import { Icon } from '../../ui/icon';
import { PagedList } from '../../ui/paged-list';
import { space, useColors } from '../../ui/theme';

const label = (h: CallHistoryItem): string => {
  const kind = h.kind === 'VIDEO' ? 'Video' : 'Voice';
  if (h.endReason === 'COMPLETED') return `${kind} · ${formatDuration(h.durationSeconds)}`;
  if (h.endReason === 'MISSED') return h.direction === 'incoming' ? `Missed ${kind.toLowerCase()} call` : `${kind} · no answer`;
  return ({ REJECTED: h.direction === 'incoming' ? 'You declined' : 'Declined', CANCELLED: 'Cancelled', BUSY: 'Busy', FAILED: 'Failed' } as Record<string, string>)[h.endReason ?? ''] ?? kind;
};

/** Recent calls (incoming, outgoing, missed). Tap to call back. */
export default function Calls() {
  const api = useEndpoints();
  const { services } = useApp();
  const c = useColors();
  const supported = callsSupported();
  return (
    <>
      <Stack.Screen options={{ title: 'Calls' }} />
      <PagedList<CallHistoryItem>
        queryKey={['chat', 'calls']} fetchPage={(page, limit) => api.calls.history({ page, limit })}
        emptyIcon="call-outline" emptyTitle="No calls yet" emptyHint="Open a conversation and tap the phone or video icon to call a colleague."
        renderItem={(h) => {
          const missed = h.endReason === 'MISSED' && h.direction === 'incoming';
          const bad = missed || h.endReason === 'FAILED';
          return (
            <Pressable accessibilityRole="button" accessibilityLabel={`${h.peerName}. ${label(h)}. ${h.direction}`} disabled={!supported} onPress={() => void getCallManager(services.api).start(h.conversationId, h.peerId, h.peerName, h.kind)}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, minHeight: 68, backgroundColor: pressed ? c.primarySoft : 'transparent', borderBottomWidth: 1, borderColor: c.border })}>
              <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: bad ? c.dangerSoft : c.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={h.kind === 'VIDEO' ? 'videocam' : h.direction === 'incoming' ? 'call' : 'call-outline'} size="md" color={bad ? c.danger : c.onPrimarySoft} />
              </View>
              <View style={{ flex: 1 }}>
                <Text variant="bodyStrong" numberOfLines={1} color={missed ? c.danger : c.text}>{h.peerName}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Icon name={h.direction === 'incoming' ? 'arrow-down' : 'arrow-up'} size={12} color={bad ? c.danger : c.muted} />
                  <Text variant="caption" muted>{label(h)}</Text>
                </View>
              </View>
              <Text variant="caption" muted>{listTime(h.createdAt)}</Text>
            </Pressable>
          );
        }}
      />
    </>
  );
}
