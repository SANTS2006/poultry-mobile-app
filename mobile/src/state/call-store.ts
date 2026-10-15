import { create } from 'zustand';
import { idleCall, type CallState } from '../lib/chat/call-machine';

interface CallStore { call: CallState; streams: { local: string | null; remote: string | null }; set(call: CallState): void; setStreams(s: { local: string | null; remote: string | null }): void }

/** What the call screens render. The CallManager is the only writer. */
export const useCallStore = create<CallStore>((set) => ({
  call: idleCall, streams: { local: null, remote: null },
  set: (call) => set({ call }), setStreams: (streams) => set({ streams }),
}));
