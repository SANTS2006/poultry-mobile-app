import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

export type PickResult = { ok: true; dataUrl: string } | { ok: false; reason: 'cancelled' | 'permission_denied' | 'error'; detail?: string };

const SIZE = 256;

/**
 * iOS cannot present the photo picker / camera while another modal (our dialog, a sheet) is still animating away; the request is
 * silently dropped and the screen is left with an invisible layer that swallows every touch. Waiting for the dismissal avoids it.
 */
export const MODAL_SETTLE_MS = Platform.OS === 'ios' ? 700 : 150;
export const afterModalCloses = (ms = MODAL_SETTLE_MS) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Lets the user choose (and square-crop) a photo, then shrinks it to a small JPEG data URL (~20–40 KB).
 * Shrinking on the phone keeps uploads fast on poor connections; the server still enforces type and size.
 */
export async function pickAvatar(source: 'library' | 'camera'): Promise<PickResult> {
  try {
    await afterModalCloses();
    const perm = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return { ok: false, reason: 'permission_denied' };
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8, presentationStyle: ImagePicker.UIImagePickerPresentationStyle.FULL_SCREEN };
    const res = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
    if (res.canceled || !res.assets[0]) return { ok: false, reason: 'cancelled' };
    const out = await ImageManipulator.manipulateAsync(res.assets[0].uri, [{ resize: { width: SIZE, height: SIZE } }], { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true });
    if (!out.base64) return { ok: false, reason: 'error', detail: 'The photo could not be prepared.' };
    return { ok: true, dataUrl: `data:image/jpeg;base64,${out.base64}` };
  } catch (e) {
    return { ok: false, reason: 'error', detail: e instanceof Error ? e.message : undefined };
  }
}
