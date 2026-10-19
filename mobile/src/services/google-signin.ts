import { IS_EXPO_GO } from '../lib/runtime';

/** Public OAuth client ids (not secrets). The WEB client id is required; it is also the audience the server checks. */
export const GOOGLE_WEB_CLIENT_ID = (process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '').trim();
const GOOGLE_IOS_CLIENT_ID = (process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '').trim();

export class GoogleCancelled extends Error { constructor() { super('cancelled'); this.name = 'GoogleCancelled'; } }
export class GoogleUnavailable extends Error {}

/** True when this build was configured for Google sign-in (the button is hidden otherwise). */
export const googleConfigured = (): boolean => GOOGLE_WEB_CLIENT_ID.length > 0;

type Module = typeof import('@react-native-google-signin/google-signin');
/** The native module is loaded lazily and never in Expo Go (it needs the installed app build). */
function load(): Module | null {
  if (IS_EXPO_GO) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module
  try { return require('@react-native-google-signin/google-signin') as Module; } catch { return null; }
}

/** Opens Google's account chooser and returns the signed ID token. The account is always asked for (a previous choice is forgotten). */
export async function getGoogleIdToken(): Promise<string> {
  const m = load();
  if (!m) throw new GoogleUnavailable('Google sign-in needs the installed Makarifor app (it does not work in Expo Go).');
  const { GoogleSignin, isErrorWithCode, statusCodes } = m;
  try {
    GoogleSignin.configure({ webClientId: GOOGLE_WEB_CLIENT_ID, ...(GOOGLE_IOS_CLIENT_ID ? { iosClientId: GOOGLE_IOS_CLIENT_ID } : {}) });
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    try { await GoogleSignin.signOut(); } catch { /* nothing to forget */ }
    const res = await GoogleSignin.signIn();
    if (res.type !== 'success' || !res.data.idToken) throw new GoogleCancelled();
    return res.data.idToken;
  } catch (e) {
    if (e instanceof GoogleCancelled) throw e;
    if (isErrorWithCode(e) && (e.code === statusCodes.SIGN_IN_CANCELLED || e.code === statusCodes.IN_PROGRESS)) throw new GoogleCancelled();
    throw new GoogleUnavailable('Google sign-in could not be completed. Please try again.');
  }
}
