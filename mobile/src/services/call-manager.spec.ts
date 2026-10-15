import { CallManager, MediaPermissionError, type CallApi, type MediaEngine, type MediaSession, type Signal } from './call-manager';

class FakeSession implements MediaSession {
  closed = 0; muted = false; camera = true; speaker = false; flipped = 0; remote: unknown[] = []; answerSet: unknown = null; offers = 0;
  private ice?: (c: unknown) => void; private conn?: (s: 'connected' | 'interrupted' | 'failed') => void;
  async createOffer(o?: { iceRestart?: boolean }) { this.offers++; return { type: 'offer' as const, sdp: o?.iceRestart ? 'offer-restart' : 'offer-1' }; }
  async acceptOffer(offer: { sdp: string }) { this.remote.push(offer.sdp); return { type: 'answer' as const, sdp: 'answer-1' }; }
  async setAnswer(a: unknown) { this.answerSet = a; }
  async addIceCandidate(c: unknown) { this.remote.push(c); }
  onIceCandidate(cb: (c: unknown) => void) { this.ice = cb; }
  onConnectionState(cb: (s: 'connected' | 'interrupted' | 'failed') => void) { this.conn = cb; }
  setMuted(m: boolean) { this.muted = m; } setCameraEnabled(o: boolean) { this.camera = o; } flipCamera() { this.flipped++; } setSpeaker(o: boolean) { this.speaker = o; }
  close() { this.closed++; }
  emitCandidate(c: unknown) { this.ice?.(c); } emitState(s: 'connected' | 'interrupted' | 'failed') { this.conn?.(s); }
}

function setup(over: Partial<{ start: unknown; deny: boolean }> = {}) {
  const sessions: FakeSession[] = [];
  const calls: string[] = [];
  const sent: { callId: string; data: Signal }[] = [];
  const api: CallApi = {
    start: jest.fn(async () => (over.start as never) ?? { call: { id: 'c1', status: 'RINGING' }, iceServers: [], busy: false }),
    accept: jest.fn(async () => { calls.push('accept'); return { call: { id: 'c1' } as never, iceServers: [] }; }),
    reject: jest.fn(async () => { calls.push('reject'); }), cancel: jest.fn(async () => { calls.push('cancel'); }), end: jest.fn(async () => { calls.push('end'); }),
  };
  const media: MediaEngine = { open: jest.fn(async () => { if (over.deny) throw new MediaPermissionError(); const s = new FakeSession(); sessions.push(s); return s; }) };
  const ring = { start: jest.fn(), stop: jest.fn() };
  const m = new CallManager({ api, media, ringtone: ring, signal: async (callId, data) => { sent.push({ callId, data }); return true; }, now: () => 1_000_000 });
  return { m, api, media, sessions, calls, sent, ring };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('CallManager', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('outgoing: rings, sends the offer only after the callee accepts, connects, and ends cleanly', async () => {
    const { m, sessions, sent, calls } = setup();
    await m.start('conv', 'peer', 'Ama', 'VIDEO');
    expect(m.getState()).toMatchObject({ phase: 'ringing_out', callId: 'c1', cameraOn: true, kind: 'VIDEO' });
    expect(sent.filter((s) => s.data.type === 'offer')).toHaveLength(0);
    m.onServerUpdate({ id: 'c1', status: 'ACCEPTED', endReason: null }); await flush();
    expect(m.getState().phase).toBe('connecting');
    expect(sent.filter((s) => s.data.type === 'offer')).toHaveLength(1);
    await m.onSignal({ callId: 'c1', data: { type: 'answer', sdp: 'a' } });
    expect(sessions[0].answerSet).toEqual({ type: 'answer', sdp: 'a' });
    sessions[0].emitCandidate({ c: 1 }); await flush();
    expect(sent.some((s) => s.data.type === 'candidate')).toBe(true);
    sessions[0].emitState('connected');
    expect(m.getState()).toMatchObject({ phase: 'connected', startedAt: 1_000_000 });
    await m.hangup();
    expect(calls).toEqual(['end']); expect(m.getState()).toMatchObject({ phase: 'ended', endReason: 'completed' }); expect(sessions[0].closed).toBe(1);
    jest.advanceTimersByTime(3000); expect(m.getState().phase).toBe('idle');
  });

  it('incoming: rings, buffers an early offer and candidates, answers after accept, and stops ringing', async () => {
    const { m, sessions, sent, ring, calls } = setup();
    m.onIncoming({ id: 'c1', conversationId: 'conv', callerId: 'p', callerName: 'Kofi', kind: 'AUDIO' });
    expect(m.getState()).toMatchObject({ phase: 'ringing_in', peerName: 'Kofi' }); expect(ring.start).toHaveBeenCalledTimes(1);
    await m.onSignal({ callId: 'c1', data: { type: 'candidate', candidate: { c: 'early' } } });
    await m.onSignal({ callId: 'c1', data: { type: 'offer', sdp: 'early-offer' } });
    expect(sessions).toHaveLength(0); // nothing happens before the user accepts
    await m.accept(); await flush();
    expect(ring.stop).toHaveBeenCalled(); expect(calls).toEqual(['accept']);
    expect(sent.find((s) => s.data.type === 'answer')).toBeTruthy();
    expect(sessions[0].remote).toEqual(['early-offer', { c: 'early' }]); // offer first, then the buffered candidate
    sessions[0].emitState('connected'); expect(m.getState().phase).toBe('connected');
  });

  it('ignores duplicate incoming events (push + socket) and a second call while busy', () => {
    const { m, ring } = setup();
    const p = { id: 'c1', conversationId: 'conv', callerId: 'p', callerName: 'A', kind: 'AUDIO' as const };
    m.onIncoming(p); m.onIncoming(p); expect(ring.start).toHaveBeenCalledTimes(1);
    m.onIncoming({ ...p, id: 'c2', callerName: 'B' }); expect(m.getState().callId).toBe('c1');
  });

  it('rejects an incoming call through the server and releases everything', async () => {
    const { m, calls, ring } = setup();
    m.onIncoming({ id: 'c1', conversationId: 'conv', callerId: 'p', callerName: 'A', kind: 'AUDIO' });
    await m.reject();
    expect(calls).toEqual(['reject']); expect(ring.stop).toHaveBeenCalled(); expect(m.getState()).toMatchObject({ phase: 'ended', endReason: 'rejected' });
  });

  it('stops ringing when another of my phones answers or the caller gives up', () => {
    const a = setup(); a.m.onIncoming({ id: 'c1', conversationId: 'x', callerId: 'p', callerName: 'A', kind: 'AUDIO' });
    a.m.onServerUpdate({ id: 'c1', status: 'ACCEPTED', endReason: null });
    expect(a.m.getState().phase).toBe('ended'); expect(a.ring.stop).toHaveBeenCalled();
    const b = setup(); b.m.onIncoming({ id: 'c1', conversationId: 'x', callerId: 'p', callerName: 'A', kind: 'AUDIO' });
    b.m.onServerUpdate({ id: 'c1', status: 'ENDED', endReason: 'CANCELLED' });
    expect(b.m.getState()).toMatchObject({ phase: 'ended', endReason: 'missed' });
  });

  it('handles a denied microphone/camera: the call is cancelled and the reason is shown', async () => {
    const { m, calls } = setup({ deny: true });
    await m.start('conv', 'p', 'Ama', 'AUDIO');
    expect(m.getState()).toMatchObject({ phase: 'ended', endReason: 'permission_denied' }); expect(calls).toEqual(['cancel']);
    const i = setup({ deny: true });
    i.m.onIncoming({ id: 'c9', conversationId: 'x', callerId: 'p', callerName: 'A', kind: 'VIDEO' });
    await i.m.accept(); expect(i.m.getState().endReason).toBe('permission_denied'); expect(i.calls).toEqual(['accept', 'end']);
  });

  it('shows busy / unavailable when the server says so, and does not start twice on repeated taps', async () => {
    const busy = setup({ start: { call: { id: 'c1', status: 'ENDED', endReason: 'BUSY' }, iceServers: [], busy: true } });
    await busy.m.start('conv', 'p', 'Ama', 'AUDIO'); expect(busy.m.getState()).toMatchObject({ phase: 'ended', endReason: 'busy' });
    const t = setup();
    await Promise.all([t.m.start('conv', 'p', 'Ama', 'AUDIO'), t.m.start('conv', 'p', 'Ama', 'AUDIO')]);
    expect(t.api.start).toHaveBeenCalledTimes(1);
  });

  it('survives a network drop: reconnecting, then restored; or fails after the limit and tells the server', async () => {
    const { m, sessions, sent, calls } = setup();
    await m.start('conv', 'p', 'Ama', 'AUDIO'); m.onServerUpdate({ id: 'c1', status: 'ACCEPTED', endReason: null }); await flush();
    sessions[0].emitState('connected');
    sessions[0].emitState('interrupted'); expect(m.getState().phase).toBe('reconnecting');
    jest.advanceTimersByTime(3100); await flush();
    expect(sent.filter((s) => s.data.type === 'offer' && s.data.sdp === 'offer-restart')).toHaveLength(1); // the caller restarts ICE
    sessions[0].emitState('connected'); expect(m.getState().phase).toBe('connected');
    sessions[0].emitState('interrupted'); jest.advanceTimersByTime(25_100); await flush();
    expect(m.getState()).toMatchObject({ phase: 'ended', endReason: 'failed' }); expect(calls).toEqual(['end']); expect(sessions[0].closed).toBe(1);
  });

  it('ignores signals for other calls and cleans up when the remote side ends', async () => {
    const { m, sessions } = setup();
    await m.start('conv', 'p', 'Ama', 'AUDIO'); m.onServerUpdate({ id: 'c1', status: 'ACCEPTED', endReason: null }); await flush(); sessions[0].emitState('connected');
    await m.onSignal({ callId: 'other', data: { type: 'answer', sdp: 'x' } }); expect(sessions[0].answerSet).toBeNull();
    m.onServerUpdate({ id: 'other', status: 'ENDED', endReason: 'COMPLETED' }); expect(m.getState().phase).toBe('connected');
    m.onServerUpdate({ id: 'c1', status: 'ENDED', endReason: 'COMPLETED' });
    expect(m.getState()).toMatchObject({ phase: 'ended', endReason: 'remote_ended' }); expect(sessions[0].closed).toBe(1);
    await m.hangup(); expect(sessions[0].closed).toBe(1); // finishing twice is harmless
  });

  it('controls reach the media session and only while a call is live', async () => {
    const { m, sessions } = setup();
    m.toggleMute(); expect(m.getState().muted).toBe(false); // no call: ignored
    await m.start('conv', 'p', 'Ama', 'VIDEO');
    m.toggleMute(); m.toggleCamera(); m.toggleSpeaker(); m.flipCamera();
    expect(sessions[0]).toMatchObject({ muted: true, camera: false, speaker: false, flipped: 1 }); // video calls start on speaker, so toggling turns it off
  });

  it('times out an unanswered outgoing call and cancels it on the server', async () => {
    const { m, calls } = setup();
    await m.start('conv', 'p', 'Ama', 'AUDIO');
    jest.advanceTimersByTime(61_000); await flush();
    expect(m.getState()).toMatchObject({ phase: 'ended', endReason: 'missed' }); expect(calls).toEqual(['cancel']);
  });
});
