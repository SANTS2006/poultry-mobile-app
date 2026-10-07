import type { OutboxStorage, SyncEngine } from '../sync';
import type { OutboxGate } from './session-manager';

const OWNER_KEY = 'sync.owner';
const REFERENCE_KEY = 'reference.v1';

/** Connects the session manager to the outbox: who owns the unsent records, and clearing local data. */
export class StorageOutboxGate implements OutboxGate {
  constructor(private readonly storage: OutboxStorage, private readonly engine: Pick<SyncEngine, 'summary'>) {}
  summary() { return this.engine.summary(); }
  getOwner() { return this.storage.getKv(OWNER_KEY); }
  setOwner(userId: string) { return this.storage.setKv(OWNER_KEY, userId); }
  async wipe() {
    for (const i of await this.storage.list()) await this.storage.remove(i.clientId);
    await this.storage.setKv(REFERENCE_KEY, '');
  }
}
