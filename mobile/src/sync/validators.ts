import type { OperationType } from './types';

/**
 * Client-side validation (fast feedback while offline). It mirrors the server rules but the server remains authoritative and
 * re-validates everything. Sales must never carry prices or totals: the server prices them.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const QTY = /^\d{1,9}(\.\d{1,3})?$/;
const UNITS = ['EGG', 'CRATE', 'CARTON'];
const SHIFTS = ['MORNING', 'AFTERNOON', 'EVENING'];
const METHODS = ['CASH', 'MOBILE_MONEY', 'BANK_TRANSFER', 'OTHER'];
/** Fields the server owns. Which ones are forbidden depends on the record: an expense legitimately carries its `total`. */
const SERVER_OWNED_ALWAYS = ['status', 'createdById', 'recordedById', 'receivedById'];
const SERVER_OWNED: Record<OperationType, string[]> = {
  'production.create': ['totalEggs'],
  'sale.create': ['total', 'subtotal', 'unitPrice', 'lineTotal', 'price', 'paidAmount', 'paymentStatus'],
  'expense.create': [],
  'customer.create': [],
  'payment.create': [],
};

export interface ValidationContext { today: string; maxEggsPerRecord?: number; unitEggs?: Record<string, number> }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const validDate = (s: unknown): s is string => typeof s === 'string' && DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

export function validateOperation(type: OperationType, payload: Record<string, unknown>, ctx: ValidationContext): string[] {
  const errs: string[] = [];
  for (const f of [...SERVER_OWNED_ALWAYS, ...SERVER_OWNED[type]]) if (f in payload) errs.push(`${f} is set by the server and must not be sent.`);
  const date = (key: string) => {
    const v = payload[key];
    if (v === undefined) return;
    if (!validDate(v)) errs.push(`${key} must be a valid YYYY-MM-DD date.`);
    else if (v > ctx.today) errs.push(`${key} cannot be in the future.`);
  };
  switch (type) {
    case 'production.create': {
      if (typeof payload.coopId !== 'string' || !UUID.test(payload.coopId)) errs.push('Choose a coop.');
      if (!SHIFTS.includes(payload.shift as string)) errs.push('Choose a shift.');
      date('productionDate');
      const entries = payload.entries;
      if (!Array.isArray(entries) || entries.length < 1 || entries.length > 3) { errs.push('Enter at least one quantity.'); break; }
      const seen = new Set<string>();
      let eggs = 0;
      for (const e of entries) {
        if (!isObj(e) || !UNITS.includes(e.unit as string)) { errs.push('Unknown unit.'); continue; }
        if (seen.has(e.unit as string)) errs.push(`${e.unit} entered twice.`);
        seen.add(e.unit as string);
        if (typeof e.quantity !== 'number' || !Number.isInteger(e.quantity) || e.quantity < 0) errs.push(`${e.unit} quantity must be a whole number, zero or more.`);
        else eggs += e.quantity * (ctx.unitEggs?.[e.unit as string] ?? 0);
      }
      if (ctx.maxEggsPerRecord && eggs > ctx.maxEggsPerRecord) errs.push(`That is more than ${ctx.maxEggsPerRecord} eggs for one shift. Please check the numbers.`);
      break;
    }
    case 'sale.create': {
      const items = payload.items;
      if (!Array.isArray(items) || items.length < 1 || items.length > 10) { errs.push('Add at least one item.'); break; }
      const seen = new Set<string>();
      for (const i of items) {
        if (!isObj(i) || !UNITS.includes(i.unit as string)) { errs.push('Unknown unit.'); continue; }
        if (seen.has(i.unit as string)) errs.push(`${i.unit} appears twice; combine the quantities.`);
        seen.add(i.unit as string);
        if (typeof i.quantity !== 'number' || !Number.isInteger(i.quantity) || i.quantity < 1) errs.push(`${i.unit} quantity must be a whole number of at least 1.`);
        for (const k of Object.keys(i)) if (!['unit', 'quantity'].includes(k)) errs.push(`${k} is not allowed on a sale item.`);
      }
      date('saleDate');
      for (const k of ['discount', 'amountPaid']) if (payload[k] !== undefined && (typeof payload[k] !== 'string' || !MONEY.test(payload[k] as string))) errs.push(`${k} must be an amount with at most 2 decimals.`);
      if (payload.paymentMethod !== undefined && !METHODS.includes(payload.paymentMethod as string)) errs.push('Unknown payment method.');
      break;
    }
    case 'expense.create': {
      if (typeof payload.categoryCode !== 'string' || payload.categoryCode.length < 2) errs.push('Choose a category.');
      if (typeof payload.description !== 'string' || payload.description.trim().length < 2) errs.push('Describe the expense.');
      date('expenseDate');
      const q = payload.quantity, u = payload.unitCost, t = payload.total;
      if (q !== undefined && (typeof q !== 'string' || !QTY.test(q))) errs.push('Quantity must be a number with at most 3 decimals.');
      if (u !== undefined && (typeof u !== 'string' || !MONEY.test(u))) errs.push('Unit cost must be an amount with at most 2 decimals.');
      if (t !== undefined && (typeof t !== 'string' || !MONEY.test(t))) errs.push('Total must be an amount with at most 2 decimals.');
      if ((q === undefined) !== (u === undefined)) errs.push('Give both quantity and unit cost, or neither.');
      if (q === undefined && t === undefined) errs.push('Enter a total, or a quantity and unit cost.');
      if (typeof t === 'string' && MONEY.test(t) && Number(t) <= 0) errs.push('The total must be more than zero.');
      break;
    }
    case 'customer.create':
      if (typeof payload.name !== 'string' || payload.name.trim().length < 2) errs.push('Enter the customer’s name.');
      break;
    case 'payment.create': {
      const hasSale = typeof payload.saleId === 'string' || typeof payload.saleClientId === 'string';
      if (hasSale === (typeof payload.customerId === 'string')) errs.push('Choose either a sale or a customer.');
      if (typeof payload.amount !== 'string' || !MONEY.test(payload.amount) || Number(payload.amount) <= 0) errs.push('Enter an amount more than zero.');
      break;
    }
  }
  return errs;
}

export class OfflineValidationError extends Error {
  constructor(readonly problems: string[]) { super(problems.join(' ')); this.name = 'OfflineValidationError'; }
}
