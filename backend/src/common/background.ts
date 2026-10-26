/**
 * Runs slow side work (sending an e-mail) after the HTTP answer has gone out, so people are never kept waiting for it.
 * Failures are reported to `onError`; they never reach the caller. Under Jest the work is awaited, so tests see its effects deterministically
 * (the same convention as TtlCache).
 */
export function background(task: () => Promise<unknown>, onError: (e: unknown) => void): Promise<void> | void {
  const run = task().then(() => undefined, onError);
  if (process.env.JEST_WORKER_ID !== undefined) return run;
}
