import { NativeModules } from 'react-native';
import { IS_EXPO_GO } from '../lib/runtime';
import { CallsUnavailableError, MediaPermissionError, type IceServer, type MediaEngine, type MediaSession, type SessionDescription } from './call-manager';

/* eslint-disable @typescript-eslint/no-require-imports */
type RTC = typeof import('react-native-webrtc');

/** react-native-webrtc is a native module: it is loaded lazily and never in Expo Go (calls need a development or store build). */
function loadRtc(): RTC | null {
  if (IS_EXPO_GO || !NativeModules.WebRTCModule) return null; // missing native part: requiring it would show a fatal error
  try { return require('react-native-webrtc') as RTC; } catch { return null; }
}
function loadInCall(): any | null {
  if (IS_EXPO_GO || !NativeModules.InCallManager) return null;
  try { return require('react-native-incall-manager').default; } catch { return null; }
}

export const callsSupported = (): boolean => !IS_EXPO_GO && loadRtc() !== null;

/** Audio routing + ringtone through the platform's in-call audio mode. Every call is guarded: a missing/older native module must never crash a call. */
export const audioRoute = {
  begin(video: boolean, speaker: boolean) { try { const m = loadInCall(); m?.start({ media: video ? 'video' : 'audio', auto: false }); m?.setForceSpeakerphoneOn(speaker); m?.setKeepScreenOn(true); } catch { /* optional */ } },
  speaker(on: boolean) { try { loadInCall()?.setForceSpeakerphoneOn(on); } catch { /* optional */ } },
  end() { try { const m = loadInCall(); m?.setKeepScreenOn(false); m?.stop(); } catch { /* optional */ } },
  ring: {
    start() { try { loadInCall()?.startRingtone('_DEFAULT_', [0, 600, 800], 'default', 40); } catch { /* optional */ } },
    stop() { try { loadInCall()?.stopRingtone(); } catch { /* optional */ } },
  },
};

class RtcSession implements MediaSession {
  private ice?: (c: unknown) => void; private conn?: (s: 'connected' | 'interrupted' | 'failed') => void; private streams?: (s: { local: string | null; remote: string | null }) => void;
  private remote: any = null; private closed = false;
  constructor(private readonly pc: any, private readonly local: any, private readonly RTC: RTC, private readonly video: boolean) {
    pc.addEventListener('icecandidate', (e: any) => { if (e.candidate) this.ice?.(typeof e.candidate.toJSON === 'function' ? e.candidate.toJSON() : e.candidate); });
    const onState = () => {
      const s = pc.connectionState ?? pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') this.conn?.('connected');
      else if (s === 'disconnected') this.conn?.('interrupted');
      else if (s === 'failed') this.conn?.('failed');
    };
    pc.addEventListener('connectionstatechange', onState);
    pc.addEventListener('iceconnectionstatechange', onState);
    pc.addEventListener('track', (e: any) => { this.remote = e.streams?.[0] ?? this.remote; this.emitStreams(); });
  }
  private emitStreams() { this.streams?.({ local: this.video && this.local ? this.local.toURL() : null, remote: this.remote ? this.remote.toURL() : null }); }
  async createOffer(o?: { iceRestart?: boolean }): Promise<SessionDescription> {
    const offer = await this.pc.createOffer({ iceRestart: !!o?.iceRestart, offerToReceiveAudio: true, offerToReceiveVideo: this.video });
    await this.pc.setLocalDescription(offer);
    return { type: 'offer', sdp: offer.sdp };
  }
  async acceptOffer(offer: SessionDescription): Promise<SessionDescription> {
    await this.pc.setRemoteDescription(new this.RTC.RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return { type: 'answer', sdp: answer.sdp };
  }
  async setAnswer(a: SessionDescription): Promise<void> { await this.pc.setRemoteDescription(new this.RTC.RTCSessionDescription(a)); }
  async addIceCandidate(c: unknown): Promise<void> { await this.pc.addIceCandidate(new this.RTC.RTCIceCandidate(c as never)); }
  onIceCandidate(cb: (c: unknown) => void) { this.ice = cb; }
  onConnectionState(cb: (s: 'connected' | 'interrupted' | 'failed') => void) { this.conn = cb; }
  onStreams(cb: (s: { local: string | null; remote: string | null }) => void) { this.streams = cb; this.emitStreams(); }
  setMuted(m: boolean) { for (const t of this.local.getAudioTracks()) t.enabled = !m; }
  setCameraEnabled(on: boolean) { for (const t of this.local.getVideoTracks()) t.enabled = on; }
  flipCamera() { try { this.local.getVideoTracks()[0]?._switchCamera?.(); } catch { /* no second camera */ } }
  setSpeaker(on: boolean) { audioRoute.speaker(on); }
  close() {
    if (this.closed) return; this.closed = true;
    try { for (const t of this.local.getTracks()) t.stop(); } catch { /* already stopped */ }
    try { this.local.release?.(); } catch { /* optional */ }
    try { this.pc.close(); } catch { /* already closed */ }
    audioRoute.end();
    this.streams?.({ local: null, remote: null });
  }
}

export const webrtcEngine: MediaEngine = {
  async open({ iceServers, video, speaker }): Promise<MediaSession> {
    const RTC = loadRtc();
    if (!RTC) throw new CallsUnavailableError();
    let local: any;
    try {
      local = await RTC.mediaDevices.getUserMedia({ audio: true, video: video ? { facingMode: 'user', width: 640, height: 480, frameRate: 24 } : false });
    } catch (e: any) {
      if (/NotAllowed|Permission|denied/i.test(`${e?.name ?? ''} ${e?.message ?? ''}`)) throw new MediaPermissionError();
      throw e;
    }
    const pc: any = new RTC.RTCPeerConnection({ iceServers: iceServers as IceServer[] as never, bundlePolicy: 'max-bundle', iceCandidatePoolSize: 2 });
    for (const t of local.getTracks()) pc.addTrack(t, local);
    audioRoute.begin(video, speaker);
    return new RtcSession(pc, local, RTC, video);
  },
};
