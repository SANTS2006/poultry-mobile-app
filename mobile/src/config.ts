import Constants from 'expo-constants';

/** Build-time configuration. EXPO_PUBLIC_* values are embedded in the bundle: they must never contain secrets. */
const raw = (process.env.EXPO_PUBLIC_API_URL ?? '').trim().replace(/\/+$/, '');
export const APP_ENV = (process.env.EXPO_PUBLIC_APP_ENV ?? 'development') as 'development' | 'staging' | 'production';

export function validateApiUrl(url: string, env: string): string | null {
  if (!url) return 'EXPO_PUBLIC_API_URL is not set.';
  if (!/^https?:\/\/[^\s/]+/.test(url)) return 'EXPO_PUBLIC_API_URL must be an absolute http(s) URL.';
  if (env !== 'development' && !url.startsWith('https://')) return 'Staging and production builds must use HTTPS.';
  return null;
}

export const API_URL = raw;
export const CONFIG_ERROR = validateApiUrl(raw, APP_ENV);
export const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';
