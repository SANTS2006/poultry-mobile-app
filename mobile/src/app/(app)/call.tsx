import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StatusBar, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { endReasonText, phaseText } from '../../lib/chat/call-machine';
import { formatDuration } from '../../lib/chat/messages';
import { getCallManager } from '../../services/call-bridge';
import { useApp } from '../../state/app';
import { useCallStore } from '../../state/call-store';
import { Text } from '../../ui/components';
import { ChatAvatar } from '../../ui/chat/chat-avatar';
import { VideoSurface } from '../../ui/chat/video-surface';
import { CALL } from '../../ui/chat/call-colors';
import { Icon, type IconName } from '../../ui/icon';
import { space } from '../../ui/theme';

function Round({ icon, label, onPress, on, danger, big, color }: { icon: IconName; label: string; onPress: () => void; on?: boolean; danger?: boolean; big?: boolean; color?: string }) {
  const size = big ? 72 : 60;
  return (
    <View style={{ alignItems: 'center', gap: 6, width: 84 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: !!on }} onPress={onPress}
        style={({ pressed }) => ({ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: color ?? (danger ? CALL.danger : on ? CALL.fg : CALL.glass), opacity: pressed ? 0.8 : 1 })}>
        <Icon name={icon} size={big ? 32 : 26} color={danger || color ? CALL.fg : on ? CALL.ink : CALL.fg} />
      </Pressable>
      <Text variant="caption" color={CALL.fg} style={{ opacity: 0.85 }}>{label}</Text>
    </View>
  );
}

/** Full-screen call: incoming (accept / decline), outgoing (ringing), and the live voice or video call with its controls. */
export default function CallScreen() {
  const { services } = useApp();
  const insets = useSafeAreaInsets();
  const call = useCallStore((s) => s.call);
  const streams = useCallStore((s) => s.streams);
  const m = getCallManager(services.api);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const video = call.kind === 'VIDEO';
  const live = call.phase === 'connected' || call.phase === 'reconnecting';
  const status = call.phase === 'ended' ? endReasonText(call.endReason) : live ? (call.phase === 'reconnecting' ? 'Reconnecting…' : formatDuration((now - (call.startedAt ?? now)) / 1000)) : phaseText(call.phase, call.direction, call.kind);
  const incoming = call.phase === 'ringing_in';
  const showRemote = video && live && !!streams.remote;

  return (
    <View style={{ flex: 1, backgroundColor: CALL.bg }}>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false, presentation: 'fullScreenModal', animation: 'fade' }} />
      <StatusBar barStyle="light-content" />
      {showRemote ? <VideoSurface streamUrl={streams.remote} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} /> : null}

      <View style={{ paddingTop: insets.top + space.xl, alignItems: 'center', gap: space.xs, paddingHorizontal: space.xl }}>
        <Text variant="title" color={CALL.fg} numberOfLines={1} accessibilityRole="header">{call.peerName}</Text>
        <View accessibilityLiveRegion="polite"><Text color={CALL.fg} style={{ opacity: 0.85 }}>{status}</Text></View>
        {call.phase === 'connecting' || call.phase === 'starting' ? <Text variant="caption" color={CALL.fg} style={{ opacity: 0.6 }}>{video ? 'Video call' : 'Voice call'}</Text> : null}
      </View>

      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        {!showRemote ? <ChatAvatar name={call.peerName || '?'} size={132} userId={call.peerId} /> : null}
      </View>

      {video && call.cameraOn && streams.local && call.phase !== 'ended' ? (
        <View style={{ position: 'absolute', top: insets.top + 16, right: 16, width: 104, height: 148, borderRadius: 14, overflow: 'hidden', backgroundColor: CALL.black, borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' }}>
          <VideoSurface streamUrl={streams.local} mirror={call.frontCamera} zOrder={1} style={{ flex: 1 }} />
        </View>
      ) : null}

      <View style={{ paddingBottom: insets.bottom + space.xl, paddingTop: space.lg, paddingHorizontal: space.md }}>
        {call.phase === 'ended' ? null : incoming ? (
          <View style={{ flexDirection: 'row', justifyContent: 'space-evenly' }}>
            <Round icon="call" label="Decline" danger big onPress={() => void m.reject()} />
            <Round icon={video ? 'videocam' : 'call'} label="Accept" big color={CALL.ok} onPress={() => void m.accept()} />
          </View>
        ) : (
          <View style={{ gap: space.xl }}>
            <View style={{ flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: space.md }}>
              <Round icon={call.muted ? 'mic-off' : 'mic'} label={call.muted ? 'Unmute' : 'Mute'} on={call.muted} onPress={() => m.toggleMute()} />
              <Round icon={call.speaker ? 'volume-high' : 'volume-medium'} label="Speaker" on={call.speaker} onPress={() => m.toggleSpeaker()} />
              {video ? <Round icon={call.cameraOn ? 'videocam' : 'videocam-off'} label={call.cameraOn ? 'Camera' : 'Camera off'} on={!call.cameraOn} onPress={() => m.toggleCamera()} /> : null}
              {video && call.cameraOn ? <Round icon="camera-reverse" label="Flip" onPress={() => m.flipCamera()} /> : null}
            </View>
            <View style={{ alignItems: 'center' }}><Round icon="call" label={call.phase === 'ringing_out' || call.phase === 'starting' ? 'Cancel' : 'End call'} danger big onPress={() => void m.hangup()} /></View>
          </View>
        )}
      </View>
    </View>
  );
}
