import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { ApiClient } from './api-client';

/**
 * Downloads a report export through the authenticated API (bearer token in a header, never in a URL), writes it to the app's private
 * cache and opens the system share sheet. The temporary file is deleted afterwards.
 */
export async function downloadAndShare(api: ApiClient, path: string, filename: string, mimeType: string): Promise<void> {
  const { bytes } = await api.download(path);
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  const file = new File(Paths.cache, safeName);
  file.create({ overwrite: true });
  file.write(new Uint8Array(bytes));
  try {
    if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device.');
    await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: filename });
  } finally {
    try { file.delete(); } catch { /* already gone */ }
  }
}
