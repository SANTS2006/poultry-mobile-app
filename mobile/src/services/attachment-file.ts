import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/**
 * Downloads a chat attachment from its short-lived link into the app's private cache and opens the phone's share / save sheet
 * (Save to Files, Save image, Drive, WhatsApp…). The temporary copy is deleted afterwards.
 */
export async function saveAttachment(url: string, fileName: string, mimeType: string): Promise<void> {
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, '_') || 'file';
  const file = new File(Paths.cache, `${Date.now()}-${safe}`);
  await File.downloadFileAsync(url, file, { idempotent: true });
  try {
    if (!(await Sharing.isAvailableAsync())) throw new Error('Saving is not available on this device.');
    await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: fileName });
  } finally {
    try { file.delete(); } catch { /* already gone */ }
  }
}
