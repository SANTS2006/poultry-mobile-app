import { Vibration } from 'react-native';
import { callApiFrom, type Endpoints } from '../api/endpoints';
import type { ApiClient } from './api-client';
import { CallManager, type CallView, type Signal } from './call-manager';
import type { RealtimeClient } from './realtime';
import { useCallStore } from '../state/call-store';
import { audioRoute, webrtcEngine } from './webrtc-engine';

let manager: CallManager | null = null;
let realtime: RealtimeClient | null = null;

const ringtone = {
  start() { audioRoute.ring.start(); Vibration.vibrate([0, 700, 900], true); },
  stop() { audioRoute.ring.stop(); Vibration.cancel(); },
};

/** The one CallManager of this phone. Created on first use; wired to the signed-in user's socket by `attachCalls`. */
export function getCallManager(api?: ApiClient): CallManager {
  if (manager) return manager;
  if (!api) throw new Error('Calls are not ready yet');
  manager = new CallManager({
    api: callApiFrom(api),
    signal: (callId, data: Signal) => (realtime ? realtime.request('call.signal', { callId, data }) : Promise.resolve(false)),
    media: webrtcEngine, ringtone,
    onChange: (s) => useCallStore.getState().set(s),
    onStreams: (st) => useCallStore.getState().setStreams(st),
  });
  return manager;
}

export function attachCalls(rt: RealtimeClient): void { realtime = rt; }

/** Signed out / session ended: leave any call so the microphone and camera are released. */
export function detachCalls(): void {
  realtime = null;
  void manager?.hangup();
}

/** Routes the socket's call events to the manager. */
export function onCallEvent(name: 'call.incoming' | 'call.updated' | 'call.signal', payload: any): void {  
  if (!manager) return;
  if (name === 'call.incoming') manager.onIncoming(payload);
  else if (name === 'call.updated') manager.onServerUpdate(payload as Pick<CallView, 'id' | 'status' | 'endReason'>);
  else void manager.onSignal(payload);
}

/** After a reconnect or a tapped push: if a call is ringing for me right now, show it. */
export async function syncCurrentCall(api: Endpoints): Promise<void> {
  if (!manager) return;
  try {
    const { call } = await api.calls.current();
    if (call && call.status === 'RINGING' && call.direction === 'incoming') manager.onIncoming({ id: call.id, conversationId: call.conversationId, peerId: call.peerId, peerName: call.peerName, kind: call.kind });
  } catch { /* offline: the socket event will arrive when it can */ }
}

/** Fire-and-forget message to the server over the live socket (typing indicators). Silently ignored while offline. */
export function sendRealtime(event: string, payload: unknown): void { realtime?.send(event, payload); }
