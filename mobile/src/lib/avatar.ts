import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

export type PickResult = { ok: true; dataUrl: string } | { ok: false; reason: 'cancelled' | 'permission_denied' | 'error'; detail?: string };

const SIZE = 256;

/**
 * Lets the user choose (and square-crop) a photo, then shrinks it to a small JPEG data URL (~20–40 KB).
 * Shrinking on the phone keeps uploads fast on poor connections; the server still enforces type and size.
 */
export async function pickAvatar(source: 'library' | 'camera'): Promise<PickResult> {
  try {
    const perm = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return { ok: false, reason: 'permission_denied' };
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8 };
    const res = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
    if (res.canceled || !res.assets[0]) return { ok: false, reason: 'cancelled' };
    const out = await ImageManipulator.manipulateAsync(res.assets[0].uri, [{ resize: { width: SIZE, height: SIZE } }], { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true });
    if (!out.base64) return { ok: false, reason: 'error', detail: 'The photo could not be prepared.' };
    return { ok: true, dataUrl: `data:image/jpeg;base64,${out.base64}` };
  } catch (e) {
    return { ok: false, reason: 'error', detail: e instanceof Error ? e.message : undefined };
  }
}
