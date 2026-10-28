import { requireOptionalNativeModule } from 'expo';

type VideoModule = typeof import('expo-video');

/** expo-video is native: only used when the installed app really contains it (otherwise videos open in the phone's own player). */
export function loadVideo(): VideoModule | null {
  if (requireOptionalNativeModule('ExpoVideo') === null) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module
  try { return require('expo-video') as VideoModule; } catch { return null; }
}
