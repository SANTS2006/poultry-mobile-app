import type { OutboxStorage } from './storage';
import {
  AuthRequiredError, HttpError, NetworkError, type NetworkMonitor, type OperationResult, type OperationType, type OutboxItem, type OutboxStatus,
  type SyncEvent, type SyncSummary, type SyncTransport,
} from './types';
import { OfflineValidationError, validateOperation, type ValidationContext } from './validators';

export interface EngineDeps {
  storage: OutboxStorage;
  transport: SyncTransport;
  network: NetworkMonitor;
  deviceId?: string;
  now?: () => Date;
  newId?: () => string;
  random?: () => number;
  /** validation context provider (business date, limits, unit table) — usually from the cached reference data */
  validationContext?: () => ValidationContext;
  batchSize?: number;
  maxBackoffMs?: number;
  /** send immediately after enqueue/retry when online (default true; tests turn it off to control timing) */
  syncOnEnqueue?: boolean;
  /** how long synced items stay visible in the outbox history */
  syncedRetentionMs?: number;
}

export interface SyncReport {
  skipped?: 'offline' | 'already_running' | 'auth_required';
  sent: number; synced: number; conflicts: number; rejected: number; blocked: number; retryLater: number;
  networkFailure: boolean;
}

const NEEDS_DECISION: OutboxStatus[] = ['conflict', 'rejected', 'blocked'];
const LAST_SYNCED_KEY = 'sync.lastSyncedAt';
const DISCARD_LOG_KEY = 'sync.discardLog';

/**
 * Offline-first outbox.
 *
 *  • enqueue() persists first (durable), then tries to send. Nothing is ever removed because it "failed": an item leaves the outbox
 *    only after the server accepted it (and even then is kept for a retention period) or after an explicit, logged discard().
 *  • Operations are sent in the order they were created; a record that depends on another (customerClientId / saleClientId) waits
 *    for it, and is blocked — not lost — if that one fails.
 *  • Every operation carries its own client-generated id, so re-sending after a lost response, crash or timeout is safe: the server
 *    answers "duplicate" and the item is simply marked synced.
 *  • Only one sync runs at a time. Transient failures back off exponentially with jitter; auth failures stop the run and ask for sign-in.
 */
export class SyncEngine {
  private readonly storage: OutboxStorage;
  private readonly transport: SyncTransport;
  private readonly network: NetworkMonitor;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly random: () => number;
  private readonly batchSize: number;
  private readonly maxBackoffMs: number;
  private readonly retentionMs: number;
  private running: Promise<SyncReport> | null = null;
  private listeners = new Set<(e: SyncEvent) => void>();
  private stopAuto: (() => void) | null = null;
  private authRequired = false;

  constructor(private readonly deps: EngineDeps) {
    this.storage = deps.storage;
    this.transport = deps.transport;
    this.network = deps.network;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
    this.random = deps.random ?? Math.random;
    this.batchSize = deps.batchSize ?? 25;
    this.maxBackoffMs = deps.maxBackoffMs ?? 15 * 60_000;
    this.retentionMs = deps.syncedRetentionMs ?? 7 * 24 * 3600_000;
  }

  // ───────────── public API ─────────────

  /** Validates, stores durably, then (if online) starts syncing in the background. Throws OfflineValidationError for bad input. */
  async enqueue(type: OperationType, payload: Record<string, unknown>): Promise<OutboxItem> {
    const ctx = this.deps.validationContext?.() ?? { today: this.now().toISOString().slice(0, 10) };
    const problems = validateOperation(type, payload, ctx);
    if (problems.length) throw new OfflineValidationError(problems);
    const ts = this.now().toISOString();
    const item = await this.storage.insert({
      clientId: this.newId(), type, payload: structuredClone(payload), status: 'pending', attempts: 0, createdAt: ts, updatedAt: ts,
      nextAttemptAt: null, lastError: null, entityId: null, syncedAt: null,
    });
    await this.emitSummary();
    if (this.deps.syncOnEnqueue !== false && this.network.isOnline() && !this.authRequired) void this.sync().catch(() => undefined);
    return item;
  }

  /** Sends everything that is due. Safe to call at any time; concurrent calls share one run. */
  sync(): Promise<SyncReport> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; void this.emitSummary(); });
    void this.emitSummary();
    return this.running;
  }

  async summary(): Promise<SyncSummary> {
    const all = await this.storage.list();
    const c = (s: OutboxStatus) => all.filter((i) => i.status === s).length;
    return {
      pending: c('pending'), syncing: c('syncing'), conflict: c('conflict'), rejected: c('rejected'), blocked: c('blocked'), synced: c('synced'),
      unsynced: all.filter((i) => i.status !== 'synced').length,
      lastSyncedAt: await this.storage.getKv(LAST_SYNCED_KEY), online: this.network.isOnline(), syncing_now: this.running !== null,
    };
  }

  list(filter?: { statuses?: OutboxStatus[] }): Promise<OutboxItem[]> { return this.storage.list(filter); }

  subscribe(listener: (e: SyncEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  /** Call after the user signs in again following `auth_required`. */
  async resumeAfterLogin(): Promise<SyncReport> { this.authRequired = false; return this.sync(); }

  /**
   * The user's decision for an item the server could not accept.
   *  retry   → try again as-is (e.g. after the missing stock was recorded, or a permission was granted)
   *  discard → give up on it (logged locally). Never allowed for items that are still waiting or already synced.
   */
  async resolve(clientId: string, action: 'retry' | 'discard'): Promise<void> {
    const item = await this.storage.get(clientId);
    if (!item) throw new Error('Unknown operation.');
    if (!NEEDS_DECISION.includes(item.status)) throw new Error(`Only conflicted, rejected or blocked operations can be resolved (this one is ${item.status}).`);
    if (action === 'retry') {
      await this.storage.update(clientId, { status: 'pending', attempts: 0, nextAttemptAt: null, updatedAt: this.now().toISOString() });
      await this.unblockDependents(clientId);
      await this.emitSummary();
      if (this.deps.syncOnEnqueue !== false && this.network.isOnline() && !this.authRequired) void this.sync().catch(() => undefined);
      return;
    }
    const log = JSON.parse((await this.storage.getKv(DISCARD_LOG_KEY)) ?? '[]') as unknown[];
    log.push({ clientId, type: item.type, discardedAt: this.now().toISOString(), reason: item.lastError, payload: item.payload });
    await this.storage.setKv(DISCARD_LOG_KEY, JSON.stringify(log.slice(-200)));
    await this.storage.remove(clientId);
    await this.emitSummary();
  }

  /** Fix a rejected record (e.g. a typo the server refused) and resend it under the same operation id. */
  async correctAndRetry(clientId: string, payload: Record<string, unknown>): Promise<void> {
    const item = await this.storage.get(clientId);
    if (!item || !NEEDS_DECISION.includes(item.status)) throw new Error('Only conflicted, rejected or blocked operations can be corrected.');
    const ctx = this.deps.validationContext?.() ?? { today: this.now().toISOString().slice(0, 10) };
    const problems = validateOperation(item.type, payload, ctx);
    if (problems.length) throw new OfflineValidationError(problems);
    await this.storage.update(clientId, { payload: structuredClone(payload), updatedAt: this.now().toISOString() });
    await this.resolve(clientId, 'retry');
  }

  /** Syncs whenever connectivity returns and on a timer while the app is active. Returns a function that stops it. */
  startAutoSync(intervalMs = 60_000, timers: { setInterval: typeof setInterval; clearInterval: typeof clearInterval } = { setInterval, clearInterval }): () => void {
    this.stopAuto?.();
    const off = this.network.subscribe((online) => { if (online && !this.authRequired) void this.sync().catch(() => undefined); void this.emitSummary(); });
    const t = timers.setInterval(() => { if (this.network.isOnline() && !this.authRequired) void this.sync().catch(() => undefined); }, intervalMs);
    (t as { unref?: () => void }).unref?.();
    this.stopAuto = () => { off(); timers.clearInterval(t); this.stopAuto = null; };
    return this.stopAuto;
  }

  // ───────────── the sync run ─────────────

  private async run(): Promise<SyncReport> {
    const report: SyncReport = { sent: 0, synced: 0, conflicts: 0, rejected: 0, blocked: 0, retryLater: 0, networkFailure: false };
    if (this.authRequired) return { ...report, skipped: 'auth_required' };
    if (!this.network.isOnline()) return { ...report, skipped: 'offline' };

    // A crash or kill mid-request leaves items 'syncing'. The server is idempotent, so simply send them again.
    for (const i of await this.storage.list({ statuses: ['syncing'] })) await this.storage.update(i.clientId, { status: 'pending', updatedAt: this.now().toISOString() });

    for (;;) {
      const batch = await this.nextBatch(report);
      if (batch.length === 0) break;
      const ts = this.now().toISOString();
      for (const i of batch) await this.storage.update(i.clientId, { status: 'syncing', updatedAt: ts });
      report.sent += batch.length;

      let results: OperationResult[];
      try {
        const res = await this.transport.push({ deviceId: this.deps.deviceId, operations: batch.map((i) => ({ clientId: i.clientId, type: i.type, payload: i.payload })) });
        results = res.results;
      } catch (e) {
        await this.handleTransportFailure(batch, e, report);
        break;
      }
      const byId = new Map(results.map((r) => [r.clientId, r]));
      for (const item of batch) await this.applyResult(item, byId.get(item.clientId), report);
    }
    await this.purgeOldSynced();
    if (report.synced > 0) await this.storage.setKv(LAST_SYNCED_KEY, this.now().toISOString());
    return report;
  }

  /** Next batch of due items in creation order, holding back items whose dependencies are not synced yet. */
  private async nextBatch(report: SyncReport): Promise<OutboxItem[]> {
    const all = await this.storage.list();
    const byId = new Map(all.map((i) => [i.clientId, i]));
    const nowMs = this.now().getTime();
    const batch: OutboxItem[] = [];
    for (const item of all) {
      if (item.status !== 'pending') continue;
      if (item.nextAttemptAt && new Date(item.nextAttemptAt).getTime() > nowMs) continue;
      let waiting = false;
      for (const depId of dependenciesOf(item)) {
        const dep = byId.get(depId);
        if (!dep || dep.status === 'synced') continue; // not local any more, or done: fine
        if (NEEDS_DECISION.includes(dep.status)) {
          await this.storage.update(item.clientId, {
            status: 'blocked', updatedAt: this.now().toISOString(),
            lastError: { code: 'DEPENDENCY_FAILED', message: 'This depends on another record that could not be saved. Resolve that one first.', detail: { dependsOn: depId } },
          });
          report.blocked++;
          waiting = true;
          break;
        }
        waiting = true; // dependency still pending/syncing: wait for a later round
      }
      if (waiting) continue;
      batch.push(item);
      if (batch.length >= this.batchSize) break;
    }
    return batch;
  }

  private async applyResult(item: OutboxItem, r: OperationResult | undefined, report: SyncReport): Promise<void> {
    const ts = this.now().toISOString();
    if (!r || (r.status === 'error' && r.retryable)) {
      // missing result or transient server error: keep it, back off, try again later
      const attempts = item.attempts + 1;
      await this.storage.update(item.clientId, {
        status: 'pending', attempts, updatedAt: ts, nextAttemptAt: this.backoff(attempts),
        lastError: r ? { code: r.code, message: r.message } : { code: 'NO_RESULT', message: 'The server did not answer for this record.' },
      });
      report.retryLater++;
      return;
    }
    switch (r.status) {
      case 'accepted':
      case 'duplicate': {
        const done = await this.storage.update(item.clientId, { status: 'synced', entityId: r.entityId ?? null, syncedAt: ts, updatedAt: ts, lastError: null, nextAttemptAt: null });
        report.synced++;
        if (done) this.emit({ type: 'synced', item: done });
        return;
      }
      case 'conflict':
      case 'rejected': {
        const updated = await this.storage.update(item.clientId, {
          status: r.status, updatedAt: ts, attempts: item.attempts + 1, nextAttemptAt: null, lastError: { code: r.code, message: r.message, detail: r.detail },
        });
        if (r.status === 'conflict') report.conflicts++; else report.rejected++;
        if (updated) this.emit({ type: 'needs_attention', item: updated });
        return;
      }
      default: { // 'error' with retryable=false is treated as a rejection so it is visible, never silently retried forever
        const updated = await this.storage.update(item.clientId, { status: 'rejected', updatedAt: ts, lastError: { code: r.code, message: r.message } });
        report.rejected++;
        if (updated) this.emit({ type: 'needs_attention', item: updated });
      }
    }
  }

  private async handleTransportFailure(batch: OutboxItem[], e: unknown, report: SyncReport): Promise<void> {
    const ts = this.now().toISOString();
    if (e instanceof AuthRequiredError) {
      this.authRequired = true;
      for (const i of batch) await this.storage.update(i.clientId, { status: 'pending', updatedAt: ts }); // not the item's fault: no penalty
      this.emit({ type: 'auth_required' });
      report.skipped = 'auth_required';
      return;
    }
    if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
      // The whole request was refused (e.g. malformed by a client bug). Keep the records visibly rejected — never delete them.
      for (const i of batch) {
        const updated = await this.storage.update(i.clientId, { status: 'rejected', updatedAt: ts, lastError: { code: `HTTP_${e.status}`, message: 'The server refused this request.' } });
        report.rejected++;
        if (updated) this.emit({ type: 'needs_attention', item: updated });
      }
      return;
    }
    // network down, timeout, 5xx, 408, 429: transient
    report.networkFailure = e instanceof NetworkError;
    for (const i of batch) {
      const attempts = i.attempts + 1;
      await this.storage.update(i.clientId, {
        status: 'pending', attempts, updatedAt: ts, nextAttemptAt: e instanceof NetworkError ? null : this.backoff(attempts), // offline: retried on reconnect, no penalty
        lastError: { code: e instanceof NetworkError ? 'OFFLINE' : 'SERVER_UNAVAILABLE', message: 'Could not reach the server. It will be retried automatically.' },
      });
      report.retryLater++;
    }
  }

  private backoff(attempts: number): string {
    const base = Math.min(this.maxBackoffMs, 2 ** Math.min(attempts, 20) * 1000);
    return new Date(this.now().getTime() + base * (0.5 + this.random() * 0.5)).toISOString();
  }

  private async unblockDependents(clientId: string): Promise<void> {
    for (const i of await this.storage.list({ statuses: ['blocked'] })) {
      if (dependenciesOf(i).includes(clientId)) await this.storage.update(i.clientId, { status: 'pending', attempts: 0, nextAttemptAt: null, lastError: null, updatedAt: this.now().toISOString() });
    }
  }

  private async purgeOldSynced(): Promise<void> {
    const cutoff = this.now().getTime() - this.retentionMs;
    for (const i of await this.storage.list({ statuses: ['synced'] })) if (i.syncedAt && new Date(i.syncedAt).getTime() < cutoff) await this.storage.remove(i.clientId);
  }

  private emit(e: SyncEvent): void { for (const l of this.listeners) { try { l(e); } catch { /* a UI listener must never break syncing */ } } }
  private async emitSummary(): Promise<void> { if (this.listeners.size) this.emit({ type: 'summary', summary: await this.summary() }); }
}

/** client ids of the records an operation refers to (must be synced first) */
export function dependenciesOf(item: Pick<OutboxItem, 'type' | 'payload'>): string[] {
  const out: string[] = [];
  if (item.type === 'sale.create' && typeof item.payload.customerClientId === 'string') out.push(item.payload.customerClientId);
  if (item.type === 'payment.create' && typeof item.payload.saleClientId === 'string') out.push(item.payload.saleClientId);
  return out;
}
