import type { NetworkMonitor, OperationResult, PushRequest, PushResponse, ReferenceData, SyncTransport } from './types';

export class FakeNetwork implements NetworkMonitor {
  private listeners = new Set<(o: boolean) => void>();
  constructor(public online = true) {}
  isOnline() { return this.online; }
  subscribe(l: (o: boolean) => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
  set(online: boolean) { this.online = online; for (const l of this.listeners) l(online); }
}

export class FakeClock {
  constructor(public ms = Date.parse('2026-07-01T10:00:00Z')) {}
  now = () => new Date(this.ms);
  advance(ms: number) { this.ms += ms; }
}

/** Programmable transport that behaves like an idempotent server. */
export class FakeTransport implements SyncTransport {
  calls: PushRequest[] = [];
  applied = new Map<string, string>(); // clientId → entityId (what the "server" has stored)
  /** per-call scripted behaviour, consumed in order; when empty the default (accept everything) applies */
  script: ((req: PushRequest, apply: () => PushResponse) => PushResponse | Promise<PushResponse>)[] = [];
  outcomes = new Map<string, Partial<OperationResult>>(); // per-clientId forced outcome
  referenceData?: ReferenceData;

  async push(req: PushRequest): Promise<PushResponse> {
    this.calls.push(structuredClone(req));
    const apply = (): PushResponse => ({
      serverTime: new Date().toISOString(),
      results: req.operations.map((o): OperationResult => {
        const forced = this.outcomes.get(o.clientId);
        if (forced) return { clientId: o.clientId, entityType: 'x', retryable: false, status: 'rejected', ...forced } as OperationResult;
        const had = this.applied.has(o.clientId);
        const id = this.applied.get(o.clientId) ?? `srv-${this.applied.size + 1}`;
        this.applied.set(o.clientId, id);
        return { clientId: o.clientId, entityType: 'x', status: had ? 'duplicate' : 'accepted', entityId: id, retryable: false };
      }),
    });
    const step = this.script.shift();
    return step ? step(req, apply) : apply();
  }

  async reference(since?: string): Promise<ReferenceData> {
    if (!this.referenceData) throw new Error('no reference data scripted');
    return { ...structuredClone(this.referenceData), incremental: !!since };
  }
}

export const production = (over: Record<string, unknown> = {}) => ({
  coopId: '11111111-1111-4111-8111-111111111111', shift: 'MORNING', entries: [{ unit: 'CRATE', quantity: 5 }], ...over,
});
export const sale = (over: Record<string, unknown> = {}) => ({ items: [{ unit: 'CARTON', quantity: 1 }], ...over });
export const nextId = (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; })();
