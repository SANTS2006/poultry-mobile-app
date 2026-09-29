import { useCallback, useState } from 'react';
import { describeError } from '../lib/errors';
import { useApp } from '../state/app';
import { OfflineValidationError, type OperationType, type OutboxItem } from '../sync';

export interface RecordResult { item: OutboxItem; sentNow: boolean }

/**
 * Saves a record through the offline outbox: it is written to the (encrypted) local database FIRST, so it can never be lost by a
 * crash or a dead connection, then sent as soon as the network allows. Returns field-level problems for the form to display.
 */
export function useRecord(type: OperationType) {
  const { services } = useApp();
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async (payload: Record<string, unknown>): Promise<RecordResult | null> => {
    setBusy(true); setProblems([]); setError(null);
    try {
      const item = await services.engine.enqueue(type, payload);
      return { item, sentNow: services.network.isOnline() };
    } catch (e) {
      if (e instanceof OfflineValidationError) setProblems(e.problems);
      else setError(describeError(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, [services, type]);

  return { submit, busy, problems, error };
}

/** Pending customers created on this phone (not yet on the server) can already be used by a sale through their client id. */
export async function pendingCustomers(services: ReturnType<typeof useApp>['services']): Promise<{ clientId: string; name: string }[]> {
  const items = await services.engine.list({ statuses: ['pending', 'syncing'] });
  return items.filter((i) => i.type === 'customer.create').map((i) => ({ clientId: i.clientId, name: String(i.payload.name ?? 'New customer') }));
}
