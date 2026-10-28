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

export const MAX_FILES_PER_SEND = 10;
export type PickManyOutcome = { ok: true; files: PickedFile[]; skipped: string[] } | { ok: false; reason: 'cancelled' | 'permission_denied' | 'error'; message?: string };

/**
 * Photos and videos from the library (several at once) or the camera (one photo or video). Photos are shrunk like pickPhoto; videos are sent as
 * they are. A file that is not allowed (too big, wrong type) is left out and named in `skipped`, the rest are still sent.
 */
export async function pickMedia(source: 'library' | 'camera'): Promise<PickManyOutcome> {
  try {
    const perm = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return { ok: false, reason: 'permission_denied' };
    const opts: ImagePicker.ImagePickerOptions = {
      mediaTypes: ['images', 'videos'], quality: 0.9, exif: false, presentationStyle: ImagePicker.UIImagePickerPresentationStyle.FULL_SCREEN,
      ...(source === 'library' ? { allowsMultipleSelection: true, selectionLimit: MAX_FILES_PER_SEND, orderedSelection: true } : {}),
    };
    const res = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (res.canceled || !res.assets.length) return { ok: false, reason: 'cancelled' };
    const files: PickedFile[] = []; const skipped: string[] = [];
    for (const a of res.assets.slice(0, MAX_FILES_PER_SEND)) {
      const name = a.fileName ?? (a.type === 'video' ? 'video' : 'photo');
      try {
        if (a.type === 'video') {
          const mimeType = a.mimeType && a.mimeType.startsWith('video/') ? a.mimeType : 'video/mp4';
          const sizeBytes = a.fileSize ?? new File(a.uri).size;
          const bad = checkAttachment(mimeType, sizeBytes);
          if (bad) skipped.push(`${name}: ${bad}`); else files.push({ uri: a.uri, fileName: a.fileName ?? `video-${Date.now()}.mp4`, mimeType, sizeBytes });
        } else {
          const scale = Math.max(a.width, a.height) > MAX_SIDE ? (a.width >= a.height ? { width: MAX_SIDE } : { height: MAX_SIDE }) : null;
          const out = await ImageManipulator.manipulateAsync(a.uri, scale ? [{ resize: scale }] : [], { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG });
          const sizeBytes = new File(out.uri).size;
          const bad = checkAttachment('image/jpeg', sizeBytes);
          if (bad) skipped.push(`${name}: ${bad}`); else files.push({ uri: out.uri, fileName: `photo-${Date.now()}-${files.length}.jpg`, mimeType: 'image/jpeg', sizeBytes });
        }
      } catch { skipped.push(`${name}: could not be read`); }
    }
    return { ok: true, files, skipped };
  } catch (e) { return { ok: false, reason: 'error', message: e instanceof Error ? e.message : undefined }; }
}

/** Several documents at once (PDF, Word, Excel, text, CSV). Not-allowed ones are skipped and named. */
export async function pickDocuments(): Promise<PickManyOutcome> {
  try {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true });
    if (res.canceled || !res.assets.length) return { ok: false, reason: 'cancelled' };
    const files: PickedFile[] = []; const skipped: string[] = [];
    for (const a of res.assets.slice(0, MAX_FILES_PER_SEND)) {
      const mimeType = a.mimeType ?? 'application/octet-stream';
      const bad = checkAttachment(mimeType, a.size ?? 0);
      if (bad) skipped.push(`${a.name}: ${bad}`); else files.push({ uri: a.uri, fileName: a.name, mimeType, sizeBytes: a.size ?? 0 });
    }
    return { ok: true, files, skipped };
  } catch (e) { return { ok: false, reason: 'error', message: e instanceof Error ? e.message : undefined }; }
}
