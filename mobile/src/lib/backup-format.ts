/** Human-friendly sizes, e.g. 1536 → "1.5 KB". */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export type StatusTone = 'ok' | 'warn' | 'danger' | 'info' | 'muted';

/** One clear label per backup: Pending / Running / Successful / Failed / Verification required / Verification failed. */
export function backupLabel(b: { status: string; verification: string }): { label: string; tone: StatusTone } {
  if (b.status === 'PENDING') return { label: 'Pending', tone: 'muted' };
  if (b.status === 'RUNNING') return { label: 'Running', tone: 'info' };
  if (b.status === 'FAILED') return { label: 'Failed', tone: 'danger' };
  if (b.verification === 'FAILED') return { label: 'Verification failed', tone: 'danger' };
  if (b.verification === 'NOT_VERIFIED') return { label: 'Verification required', tone: 'warn' };
  return { label: 'Successful', tone: 'ok' };
}

export const KIND_LABEL: Record<string, string> = { SCHEDULED: 'Daily', MANUAL: 'Manual', PRE_RESTORE: 'Safety snapshot' };

export const HEALTH_TEXT: Record<string, { title: string; tone: StatusTone }> = {
  ok: { title: 'Backups are healthy', tone: 'ok' },
  stale: { title: 'Backups are overdue', tone: 'danger' },
  failing: { title: 'The latest backup failed', tone: 'danger' },
  never: { title: 'No backup has completed yet', tone: 'warn' },
  disabled: { title: 'Backups are switched off', tone: 'warn' },
};

/** The sentence the Super Admin must type to confirm a restore (the server checks the same rule). */
export const confirmPhrase = (backupId: string): string => `RESTORE ${backupId.slice(0, 8).toUpperCase()}`;
