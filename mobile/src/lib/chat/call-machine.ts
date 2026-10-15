/**
 * Client-side call state, as a pure reducer so every transition is tested.
 * idle → outgoing (ringing) → connecting → connected ⇄ reconnecting → ended
 * idle → incoming (ringing) → connecting → connected ⇄ reconnecting → ended
 */
export type CallPhase = 'idle' | 'starting' | 'ringing_out' | 'ringing_in' | 'connecting' | 'connected' | 'reconnecting' | 'ended';
export type EndReason = 'completed' | 'cancelled' | 'rejected' | 'missed' | 'busy' | 'failed' | 'remote_ended' | 'permission_denied' | 'unavailable';

export interface CallState {
  phase: CallPhase;
  callId: string | null; conversationId: string | null; peerId: string | null; peerName: string; kind: 'AUDIO' | 'VIDEO';
  direction: 'outgoing' | 'incoming' | null;
  muted: boolean; cameraOn: boolean; speaker: boolean; frontCamera: boolean;
  startedAt: number | null; endReason: EndReason | null; error: string | null;
}

export const idleCall: CallState = {
  phase: 'idle', callId: null, conversationId: null, peerId: null, peerName: '', kind: 'AUDIO', direction: null, muted: false, cameraOn: false, speaker: false, frontCamera: true,
  startedAt: null, endReason: null, error: null,
};

export type CallEvent =
  | { type: 'start'; conversationId: string; peerId: string | null; peerName: string; kind: 'AUDIO' | 'VIDEO' }
  | { type: 'created'; callId: string }
  | { type: 'incoming'; callId: string; conversationId: string; peerId: string; peerName: string; kind: 'AUDIO' | 'VIDEO' }
  | { type: 'accepted' } // the other side picked up (outgoing) or we picked up (incoming)
  | { type: 'media_connected'; at: number }
  | { type: 'media_interrupted' }
  | { type: 'media_restored' }
  | { type: 'ended'; reason: EndReason }
  | { type: 'toggle_mute' } | { type: 'toggle_camera' } | { type: 'toggle_speaker' } | { type: 'flip_camera' }
  | { type: 'reset' };

/** A call in one of these phases occupies the phone: a second call must be refused locally (the server refuses it too). */
export const isLive = (p: CallPhase): boolean => p !== 'idle' && p !== 'ended';

export function callReducer(s: CallState, e: CallEvent): CallState {
  switch (e.type) {
    case 'start': return isLive(s.phase) ? s : { ...idleCall, phase: 'starting', conversationId: e.conversationId, peerId: e.peerId, peerName: e.peerName, kind: e.kind, direction: 'outgoing', cameraOn: e.kind === 'VIDEO', speaker: e.kind === 'VIDEO' };
    case 'created': return s.phase === 'starting' ? { ...s, phase: 'ringing_out', callId: e.callId } : s;
    case 'incoming':
      if (isLive(s.phase)) return s; // busy: the second call is ignored here (the server told the caller)
      return { ...idleCall, phase: 'ringing_in', callId: e.callId, conversationId: e.conversationId, peerId: e.peerId, peerName: e.peerName, kind: e.kind, direction: 'incoming', cameraOn: e.kind === 'VIDEO', speaker: e.kind === 'VIDEO' };
    case 'accepted': return s.phase === 'ringing_out' || s.phase === 'ringing_in' ? { ...s, phase: 'connecting' } : s;
    case 'media_connected': return s.phase === 'connecting' || s.phase === 'reconnecting' ? { ...s, phase: 'connected', startedAt: s.startedAt ?? e.at } : s;
    case 'media_interrupted': return s.phase === 'connected' ? { ...s, phase: 'reconnecting' } : s;
    case 'media_restored': return s.phase === 'reconnecting' ? { ...s, phase: 'connected' } : s;
    case 'ended': return isLive(s.phase) ? { ...s, phase: 'ended', endReason: e.reason } : s;
    case 'toggle_mute': return isLive(s.phase) ? { ...s, muted: !s.muted } : s;
    case 'toggle_camera': return isLive(s.phase) && s.kind === 'VIDEO' ? { ...s, cameraOn: !s.cameraOn } : s;
    case 'toggle_speaker': return isLive(s.phase) ? { ...s, speaker: !s.speaker } : s;
    case 'flip_camera': return isLive(s.phase) && s.kind === 'VIDEO' ? { ...s, frontCamera: !s.frontCamera } : s;
    case 'reset': return idleCall;
  }
}

export const endReasonText = (r: EndReason | null): string => ({
  completed: 'Call ended', cancelled: 'Call cancelled', rejected: 'Call declined', missed: 'No answer', busy: 'The person is busy', failed: 'The call could not be completed',
  remote_ended: 'Call ended', permission_denied: 'Microphone or camera access was denied', unavailable: 'This person is not available',
} as Record<string, string>)[r ?? ''] ?? 'Call ended';

export const phaseText = (p: CallPhase, direction: 'outgoing' | 'incoming' | null, kind: 'AUDIO' | 'VIDEO'): string => ({
  idle: '', starting: 'Calling…', ringing_out: 'Ringing…', ringing_in: kind === 'VIDEO' ? 'Incoming video call' : 'Incoming voice call', connecting: 'Connecting…', connected: '', reconnecting: 'Reconnecting…', ended: 'Call ended',
} as Record<CallPhase, string>)[p] ?? (direction ? '' : '');
