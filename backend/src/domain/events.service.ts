import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

export type DomainEventName =
  | 'production.created' | 'production.updated'
  | 'inventory.updated'
  | 'sale.created' | 'sale.updated'
  | 'payment.created'
  | 'expense.created' | 'expense.updated'
  | 'customer.created' | 'customer.updated';

export interface DomainEvent {
  name: DomainEventName;
  entityId: string;
  farmId?: string;
  actorId?: string;
  /** minimal, non-sensitive facts; consumers re-fetch through authorised REST calls */
  data?: Record<string, string | number | boolean | null>;
  at: string;
}

type Listener = (e: DomainEvent) => void;

/**
 * In-process bus. Business services call `emit` only after their database transaction has committed, so a rolled-back
 * operation never publishes anything. Phase 7 (realtime) and Phase 9 (notifications) subscribe here.
 */
@Injectable()
export class DomainEvents {
  private readonly bus = new EventEmitter();

  constructor() { this.bus.setMaxListeners(50); }

  emit(event: Omit<DomainEvent, 'at'>): void {
    const full: DomainEvent = { ...event, at: new Date().toISOString() };
    for (const key of [event.name, '*']) {
      for (const listener of this.bus.listeners(key) as Listener[]) {
        try { listener(full); } catch { /* a subscriber must never be able to fail a business operation */ }
      }
    }
  }

  on(name: DomainEventName | '*', listener: Listener): () => void {
    this.bus.on(name, listener);
    return () => this.bus.off(name, listener);
  }
}
