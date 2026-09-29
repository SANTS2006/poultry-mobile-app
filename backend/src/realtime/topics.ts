import type { DomainEventName } from '../domain/events.service';

/** A topic is a channel a client may subscribe to; each maps to the permission needed to receive it. */
export const TOPIC_PERMISSION = {
  production: 'production.read',
  inventory: 'inventory.read',
  sales: 'sales.read',
  payments: 'payments.read',
  expenses: 'expenses.read',
  customers: 'customers.read',
  dashboard: 'dashboard.read',
  system: 'settings.manage',
} as const;

export type Topic = keyof typeof TOPIC_PERMISSION;
export const TOPICS = Object.keys(TOPIC_PERMISSION) as Topic[];
export const isTopic = (t: unknown): t is Topic => typeof t === 'string' && Object.prototype.hasOwnProperty.call(TOPIC_PERMISSION, t);

/** Which topic carries each business event. Events not listed here are never sent to clients. */
export const EVENT_TOPIC: Partial<Record<DomainEventName, Topic>> = {
  'production.created': 'production', 'production.updated': 'production',
  'inventory.updated': 'inventory',
  'sale.created': 'sales', 'sale.updated': 'sales',
  'payment.created': 'payments',
  'expense.created': 'expenses', 'expense.updated': 'expenses',
  'customer.created': 'customers', 'customer.updated': 'customers',
  'system.alert': 'system',
};

/** Any of these changes what the dashboard shows, so subscribers are told to refetch it (debounced). */
export const DASHBOARD_TRIGGERS = new Set<DomainEventName>([
  'production.created', 'production.updated', 'inventory.updated', 'sale.created', 'sale.updated',
  'payment.created', 'expense.created', 'expense.updated',
]);

export const farmRoom = (farmId: string, topic: Topic) => `f:${farmId}:${topic}`;
export const allFarmsRoom = (topic: Topic) => `t:${topic}`;
export const userRoom = (userId: string) => `u:${userId}`;
