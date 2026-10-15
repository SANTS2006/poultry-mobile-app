import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { checkAttachment } from './chat/messages';

export interface PickedFile { uri: string; fileName: string; mimeType: string; sizeBytes: number }
export type PickOutcome = { ok: true; file: PickedFile } | { ok: false; reason: 'cancelled' | 'permission_denied' | 'invalid' | 'error'; message?: string };

const MAX_SIDE = 1600;

/** Photo from the library or camera, shrunk to at most 1600 px and re-encoded as JPEG (smaller, faster on poor networks, strips GPS metadata). */
export async function pickPhoto(source: 'library' | 'camera'): Promise<PickOutcome> {
  try {
    const perm = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return { ok: false, reason: 'permission_denied' };
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.9, exif: false, presentationStyle: ImagePicker.UIImagePickerPresentationStyle.FULL_SCREEN };
    const res = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    const a = res.canceled ? null : res.assets[0];
    if (!a) return { ok: false, reason: 'cancelled' };
    const scale = Math.max(a.width, a.height) > MAX_SIDE ? (a.width >= a.height ? { width: MAX_SIDE } : { height: MAX_SIDE }) : null;
    const out = await ImageManipulator.manipulateAsync(a.uri, scale ? [{ resize: scale }] : [], { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG });
    const sizeBytes = new File(out.uri).size;
    const bad = checkAttachment('image/jpeg', sizeBytes);
    return bad ? { ok: false, reason: 'invalid', message: bad } : { ok: true, file: { uri: out.uri, fileName: `photo-${Date.now()}.jpg`, mimeType: 'image/jpeg', sizeBytes } };
  } catch (e) { return { ok: false, reason: 'error', message: e instanceof Error ? e.message : undefined }; }
}

/** Any allowed document (PDF, Word, Excel, text, CSV) — checked here and again on the server. */
export async function pickDocument(): Promise<PickOutcome> {
  try {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    const a = res.canceled ? null : res.assets[0];
    if (!a) return { ok: false, reason: 'cancelled' };
    const mimeType = a.mimeType ?? 'application/octet-stream';
    const bad = checkAttachment(mimeType, a.size ?? 0);
    return bad ? { ok: false, reason: 'invalid', message: bad } : { ok: true, file: { uri: a.uri, fileName: a.name, mimeType, sizeBytes: a.size ?? 0 } };
  } catch (e) { return { ok: false, reason: 'error', message: e instanceof Error ? e.message : undefined }; }
}
