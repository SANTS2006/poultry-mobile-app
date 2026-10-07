import { Prisma } from '@prisma/client';

/**
 * Parser for the workbook's free-text expense cells, e.g.
 *   "Feeders (le300*13), Bike Tire (le500)"  with amount 4,400
 *   "Emmanuel Welder (le3,500), Foday Kalie (le6,350), Mr Usiff funeral (le500) Baba (le3,500), Musa … (le 400)"
 *
 * A cell is only split into separate expenses when the amounts written in the text add up EXACTLY to the amount in the
 * amount cell. Otherwise it stays one record and is flagged — the parser never guesses.
 */
export interface ParsedItem {
  description: string;
  total: Prisma.Decimal;
  quantity: number | null;
  unitCost: Prisma.Decimal | null;
}

export interface ParseResult {
  items: ParsedItem[];
  /** 'split' = several items found and reconciled; 'single' = one item; 'mismatch' = text amounts disagree with cell */
  kind: 'split' | 'single' | 'mismatch';
  detail?: string;
}

// "le 1,400*8", "(le300*13)", "(le500", "le 400)"  → amount, optional multiplier
const TOKEN = /\(?\s*le\s*([\d,]+(?:\.\d+)?)(?:\s*\*\s*([\d,]+(?:\.\d+)?))?\s*\)?/gi;
// "(3*350)" / "(2*200)" without "le": quantity × unit cost
const BARE_PRODUCT = /\(\s*(\d+)\s*\*\s*(\d+)\s*\)/;

const num = (s: string): Prisma.Decimal => new Prisma.Decimal(s.replace(/,/g, ''));

export function cleanDescription(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[\s,&;:-]+|[\s,&;:-]+$/g, '');
  const open = (s.match(/\(/g) ?? []).length;
  const close = (s.match(/\)/g) ?? []).length;
  if (open > close) s = s.replace(/\(/g, '');
  if (close > open) s = s.replace(/\)/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

export function parseExpenseText(text: string, amount: Prisma.Decimal): ParseResult {
  const tokens: { index: number; end: number; unit: Prisma.Decimal; mult: Prisma.Decimal | null; value: Prisma.Decimal }[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const unit = num(m[1]);
    const mult = m[2] ? num(m[2]) : null;
    tokens.push({ index: m.index ?? 0, end: (m.index ?? 0) + m[0].length, unit, mult, value: mult ? unit.times(mult) : unit });
  }

  if (tokens.length === 0) {
    const bare = text.match(BARE_PRODUCT);
    if (bare) {
      const qty = Number(bare[1]);
      const unit = new Prisma.Decimal(bare[2]);
      if (unit.times(qty).equals(amount)) {
        return { kind: 'single', items: [{ description: cleanDescription(text.replace(BARE_PRODUCT, '')), total: amount, quantity: qty, unitCost: unit }] };
      }
      return { kind: 'mismatch', detail: `text says ${qty}×${unit} = ${unit.times(qty)} but the amount cell is ${amount}`, items: [single(text, amount)] };
    }
    return { kind: 'single', items: [single(text, amount)] };
  }

  const sum = tokens.reduce((a, t) => a.plus(t.value), new Prisma.Decimal(0));
  if (!sum.equals(amount)) {
    return {
      kind: 'mismatch',
      detail: `amounts written in the text add up to ${sum.toString()} but the amount cell is ${amount.toString()}`,
      items: [single(text, amount)],
    };
  }

  const items: ParsedItem[] = [];
  let prevEnd = 0;
  for (const t of tokens) {
    const description = cleanDescription(text.slice(prevEnd, t.index));
    prevEnd = t.end;
    // "le350*3" and "le 1,400*8": first number is the unit cost, second the quantity (matches the Expenditure sheet's layout)
    items.push({
      description: description || '(no description)',
      total: t.value,
      quantity: t.mult ? Number(t.mult) : null,
      unitCost: t.mult ? t.unit : null,
    });
  }
  const trailing = cleanDescription(text.slice(prevEnd));
  if (trailing && items.length) items[items.length - 1].description += ` ${trailing}`;
  return { kind: items.length > 1 ? 'split' : 'single', items };
}

function single(text: string, amount: Prisma.Decimal): ParsedItem {
  return { description: cleanDescription(text) || '(no description)', total: amount, quantity: null, unitCost: null };
}
