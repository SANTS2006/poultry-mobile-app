export interface RetentionJob { id: string; kind: string; status: string; verification: string; createdAt: Date; deletedAt: Date | null }
export interface RetentionPolicy { retentionDays: number; keepMonthly: number }

const DAY = 86_400_000;
/** Safety copies taken right before a restore are kept for a fixed 30 days. */
export const PRE_RESTORE_KEEP_DAYS = 30;

/**
 * Which successful backups may be deleted. A backup is KEPT when it is
 *  - younger than `retentionDays`;
 *  - the newest successful backup, or the newest verified one (so there is always a recovery copy);
 *  - the newest backup of each of the last `keepMonthly` calendar months (UTC).
 * Failed/pending/running rows are never touched here. Pure function: easy to test, no I/O.
 */
export function selectExpired(jobs: RetentionJob[], now: Date, policy: RetentionPolicy): string[] {
  const ok = jobs.filter((j) => j.status === 'SUCCESSFUL' && !j.deletedAt).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const keep = new Set<string>();
  const newest = ok[0]; if (newest) keep.add(newest.id);
  const newestVerified = ok.find((j) => j.verification === 'VERIFIED'); if (newestVerified) keep.add(newestVerified.id);
  const months = new Set<string>();
  for (const j of ok.filter((x) => x.kind !== 'PRE_RESTORE')) {
    const m = j.createdAt.toISOString().slice(0, 7);
    if (!months.has(m) && months.size < policy.keepMonthly) { months.add(m); keep.add(j.id); }
  }
  return ok.filter((j) => {
    if (keep.has(j.id)) return false;
    const days = j.kind === 'PRE_RESTORE' ? PRE_RESTORE_KEEP_DAYS : policy.retentionDays;
    return now.getTime() - j.createdAt.getTime() > days * DAY;
  }).map((j) => j.id);
}
