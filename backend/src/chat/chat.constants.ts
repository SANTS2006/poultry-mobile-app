export const MAX_MESSAGE_CHARS = 4000;
export const MAX_GROUP_MEMBERS = 100;
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const EDIT_WINDOW_MS = 24 * 60 * 60_000;
export const PAGE_SIZE_DEFAULT = 30;
export const PAGE_SIZE_MAX = 60;
export const UPLOAD_URL_TTL_S = 300;
export const DOWNLOAD_URL_TTL_S = 300;
export const RING_TIMEOUT_MS = 45_000;
export const MAX_CALL_AGE_MS = 6 * 3_600_000;
export const MAX_SIGNAL_BYTES = 24_576;

/** Types people may share. Everything else is refused (also checked on the server, never only in the app). */
export const ALLOWED_ATTACHMENT_TYPES: Record<string, 'IMAGE' | 'FILE'> = {
  'image/jpeg': 'IMAGE', 'image/png': 'IMAGE', 'image/webp': 'IMAGE', 'image/gif': 'IMAGE',
  'application/pdf': 'FILE', 'text/plain': 'FILE', 'text/csv': 'FILE',
  'application/msword': 'FILE', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'FILE',
  'application/vnd.ms-excel': 'FILE', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'FILE',
};

/** Keeps a file name safe to show and to put in a Content-Disposition header. */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what must be stripped from file names
  const cleaned = name.replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return cleaned || 'file';
}

export const directKey = (a: string, b: string): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
