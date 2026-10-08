import { backupLabel, confirmPhrase, formatBytes } from './backup-format';

describe('backup formatting', () => {
  it('formats sizes', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GB');
  });
  it('gives each backup one clear status', () => {
    expect(backupLabel({ status: 'PENDING', verification: 'NOT_VERIFIED' }).label).toBe('Pending');
    expect(backupLabel({ status: 'RUNNING', verification: 'NOT_VERIFIED' }).label).toBe('Running');
    expect(backupLabel({ status: 'FAILED', verification: 'NOT_VERIFIED' })).toEqual({ label: 'Failed', tone: 'danger' });
    expect(backupLabel({ status: 'SUCCESSFUL', verification: 'NOT_VERIFIED' }).label).toBe('Verification required');
    expect(backupLabel({ status: 'SUCCESSFUL', verification: 'FAILED' }).label).toBe('Verification failed');
    expect(backupLabel({ status: 'SUCCESSFUL', verification: 'VERIFIED' })).toEqual({ label: 'Successful', tone: 'ok' });
  });
  it('builds the same confirmation phrase as the server', () => {
    expect(confirmPhrase('abcdef12-0000-4000-8000-000000000000')).toBe('RESTORE ABCDEF12');
  });
});
