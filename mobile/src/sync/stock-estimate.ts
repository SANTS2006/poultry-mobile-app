import type { OutboxItem } from './types';

/**
 * Local estimate of stock while offline: last known server stock, plus unsent production, minus unsent sales.
 * It is ONLY an aid for warnings ("this sale may not fit"): the server decides when the sale syncs.
 */
export function estimateStockEggs(serverEggs: number, unitEggs: Record<string, number>, outbox: OutboxItem[]): number {
  let eggs = serverEggs;
  for (const o of outbox) {
    if (o.status !== 'pending' && o.status !== 'syncing') continue; // conflicts/rejected are not applied
    if (o.type === 'production.create') {
      for (const e of (o.payload.entries as { unit: string; quantity: number }[] | undefined) ?? []) eggs += e.quantity * (unitEggs[e.unit] ?? 0);
    } else if (o.type === 'sale.create') {
      for (const i of (o.payload.items as { unit: string; quantity: number }[] | undefined) ?? []) eggs -= i.quantity * (unitEggs[i.unit] ?? 0);
    }
  }
  return eggs;
}
