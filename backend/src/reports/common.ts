import { Prisma } from '@prisma/client';
import type { Cell, Column, Table } from './report.types';

export const D0 = new Prisma.Decimal(0);
export const money = (d: Prisma.Decimal | null | undefined): string => (d ?? D0).toFixed(2);
export const pct = (part: Prisma.Decimal | number, whole: Prisma.Decimal | number): string => {
  const w = new Prisma.Decimal(whole);
  return w.isZero() ? '0.0' : new Prisma.Decimal(part).dividedBy(w).times(100).toFixed(1);
};

/** Egg count → cartons / crates / singles using the database unit table (never hard-coded). */
export function splitEggs(eggs: number, carton: number, crate: number): { cartons: number; crates: number; singles: number } {
  return { cartons: Math.floor(eggs / carton), crates: Math.floor((eggs % carton) / crate), singles: eggs % crate };
}

export const col = (key: string, label: string, type: Column['type'] = 'text'): Column => ({ key, label, type });

export function table(name: string, title: string, columns: Column[], rows: Record<string, Cell>[], totals?: Record<string, Cell>): Table {
  return { name, title, columns, rows, totals };
}

/** Map with a default value, for grouping. */
export function bucketMap<T>(init: () => T): { get(k: string): T; entries(): [string, T][] } {
  const m = new Map<string, T>();
  return { get(k) { let v = m.get(k); if (v === undefined) { v = init(); m.set(k, v); } return v; }, entries: () => [...m.entries()] };
}
