import { callReducer, idleCall, isLive, type CallEvent, type CallState, type EndReason } from '../lib/chat/call-machine';

export interface IceServer { urls: string[]; username?: string; credential?: string }
export interface SessionDescription { type: 'offer' | 'answer'; sdp: string }
export interface CallView { id: string; conversationId: string; kind: 'AUDIO' | 'VIDEO'; status: 'RINGING' | 'ACCEPTED' | 'ENDED'; endReason: string | null; peerId: string; peerName: string; direction: 'outgoing' | 'incoming' }
export type Signal = { type: 'offer' | 'answer'; sdp: string } | { type: 'candidate'; candidate: unknown };

export interface CallApi {
  start(conversationId: string, kind: 'AUDIO' | 'VIDEO'): Promise<{ call: CallView; iceServers: IceServer[]; busy: boolean }>;
  accept(id: string): Promise<{ call: CallView; iceServers: IceServer[] }>;
  reject(id: string): Promise<unknown>; cancel(id: string): Promise<unknown>; end(id: string): Promise<unknown>;
}

/** The media side of a call (WebRTC on a phone, a fake in tests). One session per call; it is closed on every exit path. */
export interface MediaSession {
  createOffer(opts?: { iceRestart?: boolean }): Promise<SessionDescription>;
  acceptOffer(offer: SessionDescription): Promise<SessionDescription>;
  setAnswer(answer: SessionDescription): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  onIceCandidate(cb: (candidate: unknown) => void): void;
  onConnectionState(cb: (s: 'connected' | 'interrupted' | 'failed') => void): void;
  setMuted(muted: boolean): void; setCameraEnabled(on: boolean): void; flipCamera(): void; setSpeaker(on: boolean): void;
  /** local / remote video stream handles for the UI (react-native-webrtc `RTCView streamURL`); fires whenever either changes */
  onStreams?(cb: (s: { local: string | null; remote: string | null }) => void): void;
  close(): void;
}
export class MediaPermissionError extends Error { constructor(message = 'Permission denied') { super(message); this.name = 'MediaPermissionError'; } }
/** Raised where WebRTC is not available (Expo Go, simulators without the native module). */
export class CallsUnavailableError extends Error { constructor() { super('Calls need the installed app; they do not work in Expo Go.'); this.name = 'CallsUnavailableError'; } }
export interface MediaEngine { open(o: { iceServers: IceServer[]; video: boolean; speaker: boolean }): Promise<MediaSession> }

export interface CallDeps {
  api: CallApi;
  /** sends a signaling message to the other person through the authenticated socket; false = refused/undeliverable */
  signal(callId: string, data: Signal): Promise<boolean>;
  media: MediaEngine;
  now?: () => number;
  /** ring / vibrate while an incoming call is shown (injected so tests stay silent) */
  ringtone?: { start(): void; stop(): void };
  onChange?: (s: CallState, session: MediaSession | null) => void;
  onStreams?: (s: { local: string | null; remote: string | null }) => void;
}

const ENDED_VISIBLE_MS = 2500;
const RECONNECT_FAIL_MS = 25_000;
const ICE_RESTART_AFTER_MS = 3000;
const RING_GUARD_MS = 60_000;

/**
 * Drives one call at a time on this phone: REST for the call life-cycle, the socket for WebRTC signaling, a MediaSession for audio/video.
 *  • The CALLER sends its offer when the callee has accepted (so a callee woken by a push, whose socket was not up yet, never misses it).
 *  • Signals that arrive early (an offer before the callee's media is ready, candidates before the offer) are buffered and replayed.
 *  • Every exit path (hang up, reject, remote end, failure, permission denied, answered elsewhere) goes through `finish()`, which closes media,
 *    stops the ringtone, clears timers and is safe to call twice.
 */
export class CallManager {
  private state: CallState = idleCall;
  private session: MediaSession | null = null;
  private pendingOffer: SessionDescription | null = null;
  private pendingCandidates: unknown[] = [];
  private remoteSet = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly seen = new Set<string>();
  private reconnectTimers: ReturnType<typeof setTimeout>[] = [];
  private gen = 0; // bumps on every new call so late async results from an old call are ignored

  constructor(private readonly d: CallDeps) {}

  getState(): CallState { return this.state; }
  getSession(): MediaSession | null { return this.session; }

  private dispatch(e: CallEvent): void { this.state = callReducer(this.state, e); this.d.onChange?.(this.state, this.session); }
  private later(fn: () => void, ms: number): void { const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms); this.timers.add(t); }
  private clearTimers(): void { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }
  private now(): number { return (this.d.now ?? Date.now)(); }

  // ───────────── outgoing ─────────────

  async start(conversationId: string, peerId: string | null, peerName: string, kind: 'AUDIO' | 'VIDEO'): Promise<void> {
    if (isLive(this.state.phase)) return; // repeated taps / already in a call
    const g = ++this.gen;
    this.dispatch({ type: 'start', conversationId, peerId, peerName, kind });
    try {
      const r = await this.d.api.start(conversationId, kind);
      if (g !== this.gen) return;
      if (r.busy || r.call.status === 'ENDED') return this.finish(r.busy ? 'busy' : 'failed', { notifyServer: false });
      this.dispatch({ type: 'created', callId: r.call.id });
      try {
        this.session = await this.d.media.open({ iceServers: r.iceServers, video: kind === 'VIDEO', speaker: kind === 'VIDEO' });
      } catch (e) {
        if (g !== this.gen) return;
        return this.finish(e instanceof MediaPermissionError ? 'permission_denied' : 'failed', { notifyServer: 'cancel' });
      }
      if (g !== this.gen) { this.session.close(); this.session = null; return; }
      this.wire(r.call.id);
      this.d.onChange?.(this.state, this.session);
      this.later(() => { if (this.state.phase === 'ringing_out') void this.finish('missed', { notifyServer: 'cancel' }); }, RING_GUARD_MS);
    } catch (e) {
      if (g !== this.gen) return;
      this.finish(httpStatus(e) === 409 ? 'busy' : httpStatus(e) === 403 || httpStatus(e) === 404 ? 'unavailable' : 'failed', { notifyServer: false });
    }
  }

  // ───────────── incoming ─────────────

  /** `call.incoming` from the socket (or a tapped push). Duplicates and calls while busy are ignored. */
  onIncoming(p: { id: string; conversationId: string; callerId?: string; peerId?: string; peerName?: string; callerName?: string; kind: 'AUDIO' | 'VIDEO' }): void {
    if (this.seen.has(p.id)) return;
    this.seen.add(p.id); if (this.seen.size > 50) this.seen.delete(this.seen.values().next().value as string);
    if (isLive(this.state.phase)) return;
    this.gen++;
    this.resetBuffers();
    this.dispatch({ type: 'incoming', callId: p.id, conversationId: p.conversationId, peerId: p.callerId ?? p.peerId ?? '', peerName: p.callerName ?? p.peerName ?? 'Someone', kind: p.kind });
    this.d.ringtone?.start();
    this.later(() => { if (this.state.phase === 'ringing_in') this.finish('missed', { notifyServer: false }); }, RING_GUARD_MS);
  }

  async accept(): Promise<void> {
    const s = this.state;
    if (s.phase !== 'ringing_in' || !s.callId) return;
    const g = this.gen; const callId = s.callId;
    this.d.ringtone?.stop();
    this.dispatch({ type: 'accepted' });
    try {
      const r = await this.d.api.accept(callId);
      if (g !== this.gen) return;
      try {
        this.session = await this.d.media.open({ iceServers: r.iceServers, video: s.kind === 'VIDEO', speaker: s.kind === 'VIDEO' });
      } catch (e) {
        if (g !== this.gen) return;
        return this.finish(e instanceof MediaPermissionError ? 'permission_denied' : 'failed', { notifyServer: 'end' });
      }
      if (g !== this.gen) { this.session.close(); this.session = null; return; }
      this.wire(callId);
      this.d.onChange?.(this.state, this.session);
      if (this.pendingOffer) { const o = this.pendingOffer; this.pendingOffer = null; await this.handleOffer(callId, o); }
      this.later(() => { if (this.state.phase === 'connecting') void this.finish('failed', { notifyServer: 'end' }); }, RECONNECT_FAIL_MS);
    } catch (e) {
      if (g !== this.gen) return;
      this.finish(httpStatus(e) === 409 || httpStatus(e) === 404 ? 'remote_ended' : 'failed', { notifyServer: false });
    }
  }

  async reject(): Promise<void> {
    if (this.state.phase !== 'ringing_in') return;
    await this.finish('rejected', { notifyServer: 'reject' });
  }

  /** Hang up / cancel, whatever the current phase is. */
  async hangup(): Promise<void> {
    const p = this.state.phase;
    if (!isLive(p)) return;
    if (p === 'ringing_in') return this.reject();
    await this.finish(p === 'starting' || p === 'ringing_out' ? 'cancelled' : 'completed', { notifyServer: p === 'ringing_out' || p === 'starting' ? 'cancel' : 'end' });
  }

  // ───────────── server events ─────────────

  /** `call.updated` from the socket: the other side acted, the server timed the call out, or another of our phones answered. */
  onServerUpdate(v: Pick<CallView, 'id' | 'status' | 'endReason'>): void {
    const s = this.state;
    if (v.id !== s.callId || !isLive(s.phase)) return;
    if (v.status === 'ACCEPTED') {
      if (s.phase === 'ringing_in') return void this.finish('remote_ended', { notifyServer: false }); // answered on another phone
      if (s.phase === 'ringing_out') { this.dispatch({ type: 'accepted' }); void this.sendOffer(v.id); }
      return;
    }
    if (v.status === 'ENDED') {
      const reason = ({ COMPLETED: 'completed', CANCELLED: s.direction === 'incoming' ? 'missed' : 'cancelled', REJECTED: 'rejected', MISSED: 'missed', BUSY: 'busy', FAILED: 'failed' } as Record<string, EndReason>)[v.endReason ?? ''] ?? 'remote_ended';
      void this.finish(s.phase === 'connected' || s.phase === 'reconnecting' ? 'remote_ended' : reason, { notifyServer: false });
    }
  }

  /** `call.signal` relayed by the server. */
  async onSignal(m: { callId: string; data: Signal }): Promise<void> {
    if (m.callId !== this.state.callId || !isLive(this.state.phase)) return;
    const d = m.data;
    try {
      if (d.type === 'offer') {
        if (!this.session) { this.pendingOffer = d; return; } // buffered until we have accepted and opened media
        await this.handleOffer(m.callId, d);
      } else if (d.type === 'answer') {
        if (!this.session) return;
        await this.session.setAnswer(d); this.remoteSet = true; await this.flushCandidates();
      } else if (d.type === 'candidate') {
        if (!this.session || !this.remoteSet) { this.pendingCandidates.push(d.candidate); return; }
        await this.session.addIceCandidate(d.candidate);
      }
    } catch { /* one bad signal must not end the call; the connection state decides whether it works */ }
  }

  // ───────────── controls ─────────────

  toggleMute(): void { this.dispatch({ type: 'toggle_mute' }); this.session?.setMuted(this.state.muted); }
  toggleCamera(): void { this.dispatch({ type: 'toggle_camera' }); this.session?.setCameraEnabled(this.state.cameraOn); }
  toggleSpeaker(): void { this.dispatch({ type: 'toggle_speaker' }); this.session?.setSpeaker(this.state.speaker); }
  flipCamera(): void { this.dispatch({ type: 'flip_camera' }); this.session?.flipCamera(); }

  // ───────────── internals ─────────────

  private wire(callId: string): void {
    const sess = this.session!;
    sess.onStreams?.((st) => this.d.onStreams?.(st));
    sess.onIceCandidate((candidate) => { void this.d.signal(callId, { type: 'candidate', candidate }); });
    sess.onConnectionState((st) => {
      if (callId !== this.state.callId) return;
      if (st === 'connected') { this.dispatch(this.state.phase === 'reconnecting' ? { type: 'media_restored' } : { type: 'media_connected', at: this.now() }); this.clearReconnectTimers(); if (this.state.phase === 'connected' && !this.state.startedAt) this.dispatch({ type: 'media_connected', at: this.now() }); }
      else if (st === 'interrupted') {
        if (this.state.phase === 'connecting') return; // still negotiating
        this.clearReconnectTimers(); // each interruption gets its own full window; an earlier one must not cut it short
        this.dispatch({ type: 'media_interrupted' });
        const guard = (fn: () => void, ms: number) => { const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms); this.timers.add(t); this.reconnectTimers.push(t); };
        if (this.state.direction === 'outgoing') guard(() => { if (this.state.phase === 'reconnecting') void this.sendOffer(callId, true); }, ICE_RESTART_AFTER_MS);
        guard(() => { if (this.state.phase === 'reconnecting') void this.finish('failed', { notifyServer: 'end' }); }, RECONNECT_FAIL_MS);
      } else if (st === 'failed') void this.finish('failed', { notifyServer: 'end' });
    });
  }
  private clearReconnectTimers(): void { for (const t of this.reconnectTimers) { clearTimeout(t); this.timers.delete(t); } this.reconnectTimers = []; }

  private async sendOffer(callId: string, iceRestart = false): Promise<void> {
    if (!this.session || callId !== this.state.callId) return;
    try { const offer = await this.session.createOffer({ iceRestart }); await this.d.signal(callId, { type: 'offer', sdp: offer.sdp }); } catch { /* connection state will report a failure */ }
  }

  private async handleOffer(callId: string, offer: SessionDescription): Promise<void> {
    if (!this.session) return;
    const answer = await this.session.acceptOffer(offer);
    this.remoteSet = true;
    await this.d.signal(callId, { type: 'answer', sdp: answer.sdp });
    await this.flushCandidates();
  }

  private async flushCandidates(): Promise<void> {
    const list = this.pendingCandidates; this.pendingCandidates = [];
    for (const c of list) { try { await this.session?.addIceCandidate(c); } catch { /* ignore a stale candidate */ } }
  }

  private resetBuffers(): void { this.pendingOffer = null; this.pendingCandidates = []; this.remoteSet = false; }

  /** The single exit. Idempotent. */
  private async finish(reason: EndReason, o: { notifyServer: false | 'cancel' | 'reject' | 'end' }): Promise<void> {
    if (!isLive(this.state.phase)) return;
    const callId = this.state.callId;
    this.gen++;
    this.clearTimers();
    this.d.ringtone?.stop();
    const sess = this.session; this.session = null;
    try { sess?.close(); } catch { /* already closed */ }
    this.resetBuffers();
    this.dispatch({ type: 'ended', reason });
    this.later(() => { if (this.state.phase === 'ended') this.dispatch({ type: 'reset' }); }, ENDED_VISIBLE_MS);
    if (o.notifyServer && callId) { try { await this.d.api[o.notifyServer](callId); } catch { /* already ended on the server */ } }
  }
}

const httpStatus = (e: unknown): number | null => (e && typeof e === 'object' && 'status' in e && typeof (e as { status: unknown }).status === 'number' ? (e as { status: number }).status : null);
