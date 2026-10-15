import type { StyleProp, ViewStyle } from 'react-native';
import { View } from 'react-native';
import { IS_EXPO_GO } from '../../lib/runtime';

/* eslint-disable @typescript-eslint/no-require-imports */
let RTCView: any = null;
if (!IS_EXPO_GO) { try { RTCView = require('react-native-webrtc').RTCView; } catch { RTCView = null; } }

/** Renders a WebRTC stream (remote or local). Renders nothing when the stream is gone, so no stale video surface is left after a call ends. */
export function VideoSurface({ streamUrl, mirror, style, zOrder = 0 }: { streamUrl: string | null; mirror?: boolean; style?: StyleProp<ViewStyle>; zOrder?: number }) {
  if (!RTCView || !streamUrl) return <View style={style} />;
  return <RTCView streamURL={streamUrl} mirror={!!mirror} objectFit="cover" zOrder={zOrder} style={style} />;
}
