import * as LocalAuthentication from 'expo-local-authentication';

export async function biometricsAvailable(): Promise<boolean> {
  try {
    return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
  } catch {
    return false;
  }
}

/** Prompts for fingerprint / face. The device passcode is allowed as a fallback so users are never locked out of their own phone. */
export async function authenticateLocally(prompt = 'Unlock Makarifor Poultry'): Promise<boolean> {
  try {
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: prompt, disableDeviceFallback: false, cancelLabel: 'Cancel' });
    return r.success;
  } catch {
    return false;
  }
}
