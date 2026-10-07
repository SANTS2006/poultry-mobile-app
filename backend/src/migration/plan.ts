import { Prisma } from '@prisma/client';
import { parseExpenseText } from './expense-text';
import { Cell, columnLetter, Sheet, toIsoDate } from './workbook-reader';
import type {
  ImportPlan, Issue, PlannedExpense, PlannedPrice, PlannedProduction, PlannedSale, Severity,
} from './types';

type Units = Record<'EGG' | 'CRATE' | 'CARTON', number>;
const D = (v: string | number) => new Prisma.Decimal(v);
const ZERO = D(0);

const SHIFTS = ['MORNING', 'AFTERNOON', 'EVENING'] as const;
const CATEGORIES = [
  { code: 'FEED', item: 'K', amount: 'L' },
  { code: 'TRANSPORT', item: 'M', amount: 'N' },
  { code: 'LABOUR', item: 'O', amount: 'P' },
  { code: 'MEDICATION', item: 'Q', amount: 'R' },
  { code: 'PACKAGING', item: 'S', amount: 'T' },
  { code: 'UTILITIES', item: 'U', amount: 'V' },
  { code: 'LOANS_DEBTS', item: 'W', amount: 'X' },
  { code: 'MISC', item: 'Y', amount: 'Z' },
] as const;
/** Categories whose contents are ambiguous in the workbook (open business questions Q6/Q8) — imported but flagged. */
const NEEDS_CONFIRMATION = new Set(['MISC', 'LOANS_DEBTS']);

export function normalizeUnit(text: string): 'EGG' | 'CRATE' | 'CARTON' | null {
  const t = text.trim().toLowerCase();
  if (t.startsWith('carto')) return 'CARTON'; // Carton, Cartons, Cartoon, CARTOONS …
  if (t.startsWith('crate')) return 'CRATE';
  if (t.startsWith('single')) return 'EGG';
  return null;
}

class Issues {
  readonly list: Issue[] = [];
  add(severity: Severity, sheet: string, code: string, message: string, extra: { cell?: string; original?: string; review?: boolean } = {}) {
    this.list.push({ severity, sheet, code, message, cell: extra.cell, original: extra.original, needsManualReview: extra.review ?? severity === 'ERROR' });
  }
}

export class UnexpectedLayoutError extends Error {}

function expectHeader(sheet: Sheet, row: number, col: string, contains: string): void {
  const v = sheet.at(row, col).value;
  if (typeof v !== 'string' || !v.toLowerCase().includes(contains.toLowerCase())) {
    throw new UnexpectedLayoutError(`${sheet.name}!${col}${row}: expected a header containing "${contains}" but found ${JSON.stringify(v)}. The workbook layout changed; the importer must be updated before it can be trusted.`);
  }
}

// ───────────────────────── production ─────────────────────────

function planProduction(sheet: Sheet, units: Units, issues: Issues) {
  expectHeader(sheet, 4, 'A', 'date');
  type Col = { coop: string; shift: (typeof SHIFTS)[number]; unit: 'EGG' | 'CRATE' | 'CARTON'; col: number };
  const cols: Col[] = [];
  const totalCols = new Map<string, number>();
  const spellings = new Set<string>();
  let coop: string | null = null;
  let shift: (typeof SHIFTS)[number] | null = null;
  for (let c = 2; c <= 60; c++) {
    const h2 = sheet.cell(2, c).value;
    if (typeof h2 === 'string') {
      const m = h2.trim().match(/^coop\s*(\d+)$/i);
      if (m) coop = `Coop ${m[1]}`;
      else break; // "DAILY TOTAL" section reached
    }
    const h3 = sheet.cell(3, c).value;
    if (typeof h3 === 'string' && (SHIFTS as readonly string[]).includes(h3.trim().toUpperCase())) shift = h3.trim().toUpperCase() as (typeof SHIFTS)[number];
    const h4 = sheet.cell(4, c).value;
    if (typeof h4 !== 'string' || !coop) continue;
    if (/^total eggs$/i.test(h4.trim())) { totalCols.set(coop, c); continue; }
    const unit = normalizeUnit(h4);
    if (unit && shift) { cols.push({ coop, shift, unit, col: c }); spellings.add(h4.trim()); }
  }
  const coops = [...new Set(cols.map((c) => c.coop))];
  if (coops.length === 0) throw new UnexpectedLayoutError('Daily Egg Report: no coop columns found');
  const variants = [...spellings].filter((s) => !['Cartons', 'Crates', 'Single Eggs'].includes(s));
  if (variants.length) issues.add('INFO', sheet.name, 'UNIT_SPELLING_NORMALISED', `Unit header spellings normalised: ${variants.join(', ')} (all mapped to CARTON/CRATE/EGG)`, { review: false });

  const out: PlannedProduction[] = [];
  const seenDates = new Set<string>();
  let rowsRead = 0;
  let skippedBlank = 0;
  let templateRows = 0;
  let unnormalised = 0;
  const cellRange = (c: Col[]) => `${columnLetter(c[0].col)}:${columnLetter(c[c.length - 1].col)}`;

  for (let r = 5; r <= sheet.rowCount; r++) {
    const dateCell = sheet.cell(r, 1);
    const date = toIsoDate(dateCell.value);
    const hasAny = cols.some((c) => sheet.cell(r, c.col).value !== null);
    if (!date) {
      if (hasAny || dateCell.value !== null) issues.add('ERROR', sheet.name, 'ROW_WITHOUT_VALID_DATE', `Row ${r} has data but no valid date; not imported`, { cell: dateCell.addr, original: String(dateCell.value) });
      continue;
    }
    if (seenDates.has(date)) {
      issues.add('ERROR', sheet.name, 'DUPLICATE_DATE', `Date ${date} appears more than once; the later row was not imported`, { cell: dateCell.addr });
      continue;
    }
    seenDates.add(date);
    if (!hasAny) { templateRows++; continue; }
    rowsRead++;

    const perCoopTotals = new Map<string, number>();
    for (const cp of coops) {
      for (const sh of SHIFTS) {
        const group = cols.filter((c) => c.coop === cp && c.shift === sh);
        if (group.length === 0) continue;
        const cells = group.map((g) => ({ g, cell: sheet.cell(r, g.col) }));
        if (cells.every((x) => x.cell.value === null)) {
          skippedBlank++;
          issues.add('INFO', sheet.name, 'SHIFT_NOT_RECORDED', `${cp} ${sh.toLowerCase()} on ${date} is blank (not the same as an entered 0); no record created`, { cell: `${sheet.name}!${cellRange(group)}${r}`, review: false });
          continue;
        }
        const entries = [];
        let invalid = false;
        for (const { g, cell } of cells) {
          if (cell.value === null) continue;
          if (typeof cell.value !== 'number' || !Number.isInteger(cell.value) || cell.value < 0) {
            invalid = true;
            issues.add('ERROR', sheet.name, 'INVALID_QUANTITY', `${cp} ${sh.toLowerCase()} ${g.unit.toLowerCase()} on ${date} is not a whole non-negative number; this shift was not imported`, { cell: cell.addr, original: String(cell.value) });
            continue;
          }
          if ((g.unit === 'CRATE' && cell.value >= units.CARTON / units.CRATE) || (g.unit === 'EGG' && cell.value >= units.CRATE)) unnormalised++;
          entries.push({ unit: g.unit, quantity: cell.value, baseEggs: cell.value * units[g.unit] });
        }
        if (invalid) continue;
        const totalEggs = entries.reduce((a, e) => a + e.baseEggs, 0);
        perCoopTotals.set(cp, (perCoopTotals.get(cp) ?? 0) + totalEggs);
        out.push({
          sourceRef: `${sheet.name}!${columnLetter(group[0].col)}${r}:${columnLetter(group[group.length - 1].col)}${r}#${cp}/${sh}`,
          date, coop: cp, shift: sh, entries, totalEggs, needsReview: false,
        });
      }
      // Cross-check against the workbook's own coop total formula
      const tc = totalCols.get(cp);
      if (tc) {
        const stored = sheet.cell(r, tc);
        if (typeof stored.value === 'number' && stored.value !== (perCoopTotals.get(cp) ?? 0)) {
          issues.add('ERROR', sheet.name, 'PRODUCTION_TOTAL_MISMATCH', `${cp} on ${date}: workbook total ${stored.value} ≠ sum of shifts ${perCoopTotals.get(cp) ?? 0}`, { cell: stored.addr });
        }
      }
    }
  }
  if (templateRows) issues.add('INFO', sheet.name, 'EMPTY_TEMPLATE_ROWS', `${templateRows} dated rows with no production entered (future dates) were skipped`, { review: false });
  if (unnormalised) issues.add('INFO', sheet.name, 'UNNORMALISED_UNITS', `${unnormalised} cells hold more crates than a carton or more singles than a crate; totals are unaffected because everything is stored as eggs`, { review: false });
  return { coops, out, rowsRead, skippedBlank };
}

// ───────────────────────── Sheet1: sales, prices, expenses ─────────────────────────

function checkSheet1Layout(s: Sheet): void {
  expectHeader(s, 3, 'A', 'date');
  expectHeader(s, 3, 'G', 'sold');
  expectHeader(s, 3, 'I', 'price');
  expectHeader(s, 3, 'J', 'sales');
  for (const c of CATEGORIES) {
    expectHeader(s, 3, c.item, 'item');
    expectHeader(s, 3, c.amount, 'amount');
  }
  expectHeader(s, 3, 'AA', 'total expenses');
}

function parseSold(cell: Cell, price: Cell, stored: Cell, units: Units, sheet: string, issues: Issues, date: string): PlannedSale | null {
  const v = cell.value;
  if (v === null || v === 0) return null;
  const p = price.value;
  if (typeof p !== 'number' || p <= 0) {
    issues.add('ERROR', sheet, 'SALE_WITHOUT_PRICE', `Sale on ${date} has quantity but no valid price; not imported`, { cell: cell.addr, original: String(v) });
    return null;
  }
  let cartons: number;
  let crates = 0;
  let note: string | undefined;
  let review = false;
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0) {
      issues.add('ERROR', sheet, 'INVALID_QUANTITY', `Cartons sold on ${date} is not a whole non-negative number; not imported`, { cell: cell.addr, original: String(v) });
      return null;
    }
    cartons = v;
  } else if (typeof v === 'string') {
    const m = v.match(/^\s*(\d+)\s*(?:cartons?|cartoons?)?\s*\+\s*(\d+)\s*crates?\s*$/i);
    if (!m) {
      issues.add('ERROR', sheet, 'UNPARSEABLE_QUANTITY', `Cannot read the quantity sold on ${date}; not imported (needs a person to enter it)`, { cell: cell.addr, original: v });
      return null;
    }
    cartons = Number(m[1]);
    crates = Number(m[2]);
    review = true;
    note = `Quantity was typed as text "${v}"`;
    issues.add('WARNING', sheet, 'TEXT_QUANTITY_PARSED', `Quantity "${v}" on ${date} read as ${cartons} cartons + ${crates} crates`, { cell: cell.addr, original: v, review: true });
  } else {
    issues.add('ERROR', sheet, 'UNPARSEABLE_QUANTITY', `Unsupported quantity type on ${date}`, { cell: cell.addr, original: String(v) });
    return null;
  }
  const cartonPrice = D(p);
  const items: PlannedSale['items'] = [];
  if (cartons > 0) items.push({ unit: 'CARTON', quantity: cartons, baseEggs: cartons * units.CARTON, unitPrice: cartonPrice, lineTotal: cartonPrice.times(cartons) });
  if (crates > 0) {
    // The workbook priced these by hand (J = 15*1550 + 775). Use the workbook's own amount; never invent a crate price.
    const storedTotal = typeof stored.value === 'number' ? D(stored.value) : null;
    const crateAmount = storedTotal ? storedTotal.minus(cartonPrice.times(cartons)) : cartonPrice.times(crates).dividedBy(units.CARTON / units.CRATE);
    items.push({ unit: 'CRATE', quantity: crates, baseEggs: crates * units.CRATE, unitPrice: crateAmount.dividedBy(crates).toDecimalPlaces(2), lineTotal: crateAmount });
    issues.add('WARNING', sheet, 'CRATE_PRICE_DERIVED', `Crates on ${date} were priced by hand in the workbook (${crateAmount.toString()} for ${crates} crates); the crate price is not defined anywhere else (Sheet2 uses 125, pro-rata would be ${cartonPrice.dividedBy(units.CARTON / units.CRATE).toDecimalPlaces(2).toString()}). See business question Q2`, { cell: stored.addr, original: stored.formula ?? undefined, review: true });
  }
  const total = items.reduce((a, i) => a.plus(i.lineTotal), ZERO);
  if (typeof stored.value === 'number' && !D(stored.value).equals(total)) {
    issues.add('ERROR', sheet, 'SALE_TOTAL_MISMATCH', `Sales amount on ${date}: workbook says ${stored.value}, quantity × price gives ${total.toString()}`, { cell: stored.addr });
    review = true;
  }
  return { sourceRef: `${sheet}!${cell.addr}`, date, items, total, needsReview: review, note };
}

function planSheet1(s: Sheet, units: Units, issues: Issues) {
  checkSheet1Layout(s);
  const sales: PlannedSale[] = [];
  const expenses: PlannedExpense[] = [];
  const prices: PlannedPrice[] = [];
  const hardcoded: string[] = [];
  const cashShapes = new Set<string>();
  const cashHardcoded: string[] = [];
  const sheet1Production = new Map<string, number>();
  let storedExpenseTotal = ZERO;
  let priceRun: { amount: number; from: string } | null = null;

  for (let r = 5; r <= s.rowCount; r++) {
    const dateCell = s.at(r, 'A');
    const date = toIsoDate(dateCell.value);
    const rowHasData = ['B', 'C', 'D', 'G', 'H', ...CATEGORIES.flatMap((c) => [c.item, c.amount])].some((c) => s.at(r, c).value !== null);
    if (!date) {
      if (rowHasData) issues.add('ERROR', s.name, 'ROW_WITHOUT_VALID_DATE', `Row ${r} has data but no valid date; not imported`, { cell: dateCell.addr });
      continue;
    }
    // production typed on this sheet (used only to cross-check the Daily Egg Report)
    const b = s.at(r, 'B').value, c = s.at(r, 'C').value, d = s.at(r, 'D').value;
    if ([b, c, d].every((x) => typeof x === 'number')) {
      sheet1Production.set(date, (b as number) * units.CARTON + (c as number) * units.CRATE + (d as number));
    }
    const sale = parseSold(s.at(r, 'G'), s.at(r, 'I'), s.at(r, 'J'), units, s.name, issues, date);
    if (sale) sales.push(sale);
    const jCell = s.at(r, 'J');
    if (jCell.value !== null && jCell.formula === null && typeof jCell.value === 'number' && jCell.value !== 0) hardcoded.push(jCell.addr);

    // price history from the price column, only on rows that carry real activity (not pre-filled template rows)
    const activity = rowHasData || sale;
    const priceVal = s.at(r, 'I').value;
    if (activity && typeof priceVal === 'number' && priceVal > 0) {
      if (!priceRun) priceRun = { amount: priceVal, from: date };
      else if (priceRun.amount !== priceVal) {
        prices.push({ unit: 'CARTON', amount: D(priceRun.amount), effectiveFrom: priceRun.from, effectiveTo: date });
        priceRun = { amount: priceVal, from: date };
      }
    }

    // expenses
    let rowItemsTotal = ZERO;
    for (const cat of CATEGORIES) {
      const itemCell = s.at(r, cat.item);
      const amtCell = s.at(r, cat.amount);
      const text = typeof itemCell.value === 'string' ? itemCell.value : itemCell.value !== null ? String(itemCell.value) : null;
      const amt = amtCell.value;
      if ((amt === null || amt === 0) && text === null) continue;
      if (amt === null || amt === 0) {
        issues.add('WARNING', s.name, 'EXPENSE_ITEM_NO_AMOUNT', `"${text}" on ${date} has no amount; not imported (amount cannot be invented)`, { cell: itemCell.addr, original: text ?? undefined, review: true });
        continue;
      }
      if (typeof amt !== 'number' || amt < 0) {
        issues.add('ERROR', s.name, 'INVALID_AMOUNT', `Expense amount on ${date} is not a valid non-negative number; not imported`, { cell: amtCell.addr, original: String(amt) });
        continue;
      }
      const original = [text, amtCell.formula ? `formula: =${amtCell.formula}` : null].filter(Boolean).join(' | ') || null;
      const parsed = text ? parseExpenseText(text, D(amt)) : { kind: 'single' as const, items: [{ description: '(no description)', total: D(amt), quantity: null, unitCost: null }], detail: undefined };
      if (!text) issues.add('WARNING', s.name, 'EXPENSE_WITHOUT_DESCRIPTION', `Amount ${amt} on ${date} has no item description`, { cell: amtCell.addr, review: true });
      if (parsed.kind === 'mismatch') issues.add('WARNING', s.name, 'EXPENSE_BREAKDOWN_MISMATCH', `${parsed.detail}; kept as ONE expense with the cell amount`, { cell: amtCell.addr, original: text ?? undefined, review: true });
      if (parsed.kind === 'split') issues.add('INFO', s.name, 'EXPENSE_SPLIT', `Cell held ${parsed.items.length} items whose amounts add up exactly; imported as ${parsed.items.length} expenses`, { cell: amtCell.addr, original: text ?? undefined, review: false });
      const confirm = NEEDS_CONFIRMATION.has(cat.code);
      parsed.items.forEach((it, i) => {
        rowItemsTotal = rowItemsTotal.plus(it.total);
        expenses.push({
          sourceRef: `${s.name}!${amtCell.addr}${parsed.items.length > 1 ? `#${i + 1}` : ''}`,
          date, categoryCode: cat.code, description: it.description, quantity: it.quantity, unitCost: it.unitCost, total: it.total,
          originalText: original, needsReview: confirm || parsed.kind === 'mismatch' || !text,
          notes: confirm ? 'Category to be confirmed with the business (see business questions Q6/Q8)' : undefined,
        });
      });
    }
    // reconcile with the workbook's own daily total
    const aa = s.at(r, 'AA');
    if (typeof aa.value === 'number') {
      storedExpenseTotal = storedExpenseTotal.plus(aa.value);
      if (aa.formula === null && aa.value !== 0) hardcoded.push(aa.addr);
      if (!D(aa.value).equals(rowItemsTotal)) {
        issues.add('WARNING', s.name, 'EXPENSE_TOTAL_MISMATCH', `${date}: workbook "Total Expenses" is ${aa.value} but the line items add up to ${rowItemsTotal.toString()} (difference ${rowItemsTotal.minus(aa.value).toString()}). The importer uses the line items.`, { cell: aa.addr, original: aa.formula ?? String(aa.value), review: true });
      }
    } else if (!rowItemsTotal.isZero()) {
      issues.add('WARNING', s.name, 'EXPENSE_TOTAL_MISSING', `${date}: expenses of ${rowItemsTotal.toString()} exist but the workbook's "Total Expenses" cell is empty`, { cell: aa.addr, review: true });
    }
    // cash column audit
    const ac = s.at(r, 'AC');
    if (ac.formula) cashShapes.add(ac.formula.replace(/\d+/g, '#'));
    else if (typeof ac.value === 'number') cashHardcoded.push(ac.addr);
  }
  if (priceRun) prices.push({ unit: 'CARTON', amount: D(priceRun.amount), effectiveFrom: priceRun.from, effectiveTo: null });

  if (hardcoded.length) issues.add('INFO', s.name, 'HARDCODED_TOTALS', `Typed numbers sit where formulas belong: ${hardcoded.join(', ')}. Line items are used instead of these totals.`, { review: false });
  issues.add(
    'WARNING', s.name, 'CASH_COLUMN_NOT_IMPORTED',
    `"Cash Remaining" (AC) and the unlabelled running column (AB) are not imported: ${cashShapes.size} different formula shapes and ${cashHardcoded.length} typed value(s) (${cashHardcoded.join(', ') || 'none'}). Cash flow is recomputed from sales and expenses instead.`,
    { cell: 'AB:AC', review: true },
  );
  return { sales, expenses, prices, storedExpenseTotal, sheet1Production };
}

// ───────────────────────── Sheet2 (second copy of sales) ─────────────────────────

function compareSheet2(s: Sheet, sales: PlannedSale[], units: Units, issues: Issues): void {
  expectHeader(s, 3, 'B', 'date');
  const byDate = new Map(sales.map((x) => [x.date, x]));
  for (let r = 5; r <= s.rowCount; r++) {
    const date = toIsoDate(s.at(r, 'B').value);
    if (!date) continue;
    const cartons = Number(s.at(r, 'C').value ?? 0);
    const crates = Number(s.at(r, 'D').value ?? 0);
    const amount = s.at(r, 'G').value;
    const s1 = byDate.get(date);
    const s2Eggs = cartons * units.CARTON + crates * units.CRATE;
    if (!s1) {
      issues.add('WARNING', s.name, 'SALES_SOURCE_CONFLICT', `${date}: Sheet2 shows a sale (${cartons} cartons, ${crates} crates, ${amount}) but Sheet1 records none; not imported`, { cell: s.at(r, 'B').addr, review: true });
      continue;
    }
    const s1Eggs = s1.items.reduce((a, i) => a + i.baseEggs, 0);
    const same = s1Eggs === s2Eggs && typeof amount === 'number' && s1.total.equals(amount);
    if (same) {
      issues.add('INFO', s.name, 'SALES_SOURCES_AGREE', `${date}: Sheet2 agrees with Sheet1`, { cell: s.at(r, 'B').addr, review: false });
    } else {
      s1.needsReview = true;
      issues.add('WARNING', s.name, 'SALES_SOURCE_CONFLICT', `${date}: Sheet1 = ${s1Eggs} eggs / ${s1.total.toString()}; Sheet2 = ${s2Eggs} eggs (${cartons} cartons + ${crates} crates) / ${amount ?? 'n/a'} (Sheet2 unit prices: ${s.at(r, 'E').value} per carton, ${s.at(r, 'F').value} per crate). Sheet1 was imported and flagged; Sheet2 was not.`, { cell: s.at(r, 'G').addr, review: true });
    }
  }
}

// ───────────────────────── Expenditure notebook ─────────────────────────

function reconcileExpenditure(s: Sheet, expenses: PlannedExpense[], sales: PlannedSale[], issues: Issues) {
  expectHeader(s, 3, 'C', 'item');
  const used = new Set<PlannedExpense>();
  let date: string | null = null;
  let lines = 0, duplicates = 0, queued = 0;
  for (let r = 4; r <= s.rowCount; r++) {
    const d = toIsoDate(s.at(r, 'A').value);
    if (d) date = d;
    const item = s.at(r, 'C').value;
    if (item === null) continue;
    lines++;
    const desc = String(item).trim();
    const total = s.at(r, 'F');
    const ref = `${s.name}!C${r}`;
    const review = (code: string, msg: string, sev: Severity = 'WARNING') => {
      queued++;
      issues.add(sev, s.name, code, msg, { cell: ref, original: `${desc}${typeof total.value === 'number' ? ` = ${total.value}` : ''}`, review: true });
    };
    if (/money at hand/i.test(desc)) { review('CASH_BALANCE_NOTE', `"money at hand" ${total.value ?? ''} (${date ?? 'undated'}) is a cash balance, not an expense; not imported. Whether it is a physical count is business question Q7`); continue; }
    if (/^sales?$/i.test(desc)) {
      const sale = sales.find((x) => x.date === date);
      if (sale && typeof total.value === 'number' && sale.total.equals(total.value)) { duplicates++; issues.add('INFO', s.name, 'EXPENDITURE_DUPLICATE_OF_SHEET1', `Income line "sales" ${total.value} on ${date} equals the Sheet1 sale; skipped`, { cell: ref, review: false }); }
      else review('EXPENDITURE_INCOME_LINE', `Income line "sales" ${total.value ?? ''} on ${date ?? 'undated'} does not match a Sheet1 sale; not imported`);
      continue;
    }
    if (typeof total.value !== 'number') { review('EXPENDITURE_LINE_NO_AMOUNT', `"${desc}" has no amount; not imported (amount cannot be invented)`); continue; }
    const same = (e: PlannedExpense) => !used.has(e) && e.total.equals(total.value as number);
    if (date) {
      const hit = expenses.find((e) => e.date === date && same(e));
      if (hit) { used.add(hit); duplicates++; issues.add('INFO', s.name, 'EXPENDITURE_DUPLICATE_OF_SHEET1', `"${desc}" ${total.value} on ${date} matches ${hit.sourceRef}; skipped to avoid double-counting`, { cell: ref, review: false }); continue; }
      review('EXPENDITURE_UNMATCHED', `"${desc}" ${total.value} on ${date} is not in Sheet1 for that date. Not imported (could be a missing entry or a different figure); please decide`);
    } else {
      const hint = expenses.find(same);
      review('EXPENDITURE_UNDATED', `"${desc}" ${total.value} has no date${hint ? ` (same amount as ${hint.sourceRef} on ${hint.date} — if it is that purchase it is a duplicate)` : ''}; not imported`);
    }
  }
  return { lines, duplicates, queued };
}

// ───────────────────────── orchestration ─────────────────────────

export function buildPlan(sheets: Map<string, Sheet>, units: Units): ImportPlan {
  const need = (n: string) => {
    const s = sheets.get(n);
    if (!s) throw new UnexpectedLayoutError(`Worksheet "${n}" not found (found: ${[...sheets.keys()].join(', ')})`);
    return s;
  };
  const issues = new Issues();
  const prod = planProduction(need('Daily Egg Report'), units, issues);
  const s1 = planSheet1(need('Sheet1'), units, issues);
  compareSheet2(need('Sheet2'), s1.sales, units, issues);

  // Production typed twice: Daily Egg Report (per shift) is authoritative
  const perDate = new Map<string, number>();
  for (const p of prod.out) perDate.set(p.date, (perDate.get(p.date) ?? 0) + p.totalEggs);
  for (const [date, eggs] of s1.sheet1Production) {
    const other = perDate.get(date);
    if (other !== undefined && other !== eggs) {
      issues.add('WARNING', 'Sheet1', 'PRODUCTION_SOURCE_CONFLICT', `${date}: Sheet1 says ${eggs} eggs produced but Daily Egg Report (per coop and shift) says ${other} (difference ${eggs - other}). Daily Egg Report was imported.`, { cell: `Sheet1!B:D (${date})`, review: true });
      for (const p of prod.out.filter((x) => x.date === date)) p.needsReview = true;
    }
  }

  const exp = reconcileExpenditure(need('Expenditure'), s1.expenses, s1.sales, issues);

  const productionEggs = prod.out.reduce((a, p) => a + p.totalEggs, 0);
  const salesEggs = s1.sales.reduce((a, x) => a + x.items.reduce((b, i) => b + i.baseEggs, 0), 0);
  const balance = productionEggs - salesEggs;

  // Chronological stock check (a sale can't precede the eggs that were produced)
  const days = new Map<string, number>();
  for (const p of prod.out) days.set(p.date, (days.get(p.date) ?? 0) + p.totalEggs);
  for (const x of s1.sales) days.set(x.date, (days.get(x.date) ?? 0) - x.items.reduce((b, i) => b + i.baseEggs, 0));
  let running = 0;
  let lowest = 0;
  let lowestDate = '';
  for (const date of [...days.keys()].sort()) {
    running += days.get(date) as number;
    if (running < lowest) { lowest = running; lowestDate = date; }
  }
  if (lowest < 0) {
    issues.add('WARNING', 'Sheet1', 'NEGATIVE_STOCK_ON_DATE', `Recorded sales exceed recorded production by up to ${-lowest} eggs (worst on ${lowestDate}), so at least ${-lowest} eggs must have been in stock on 2026-06-17 before the first entry. The opening stock is not in the workbook and is not invented; supply it with --opening-stock once known (business question Q3)`, { review: true });
  }
  if (balance > 0) {
    issues.add('WARNING', 'Sheet1', 'UNACCOUNTED_STOCK', `Production (${productionEggs}) minus sales (${salesEggs}) leaves ${balance} eggs that no sheet accounts for (unrecorded sales, breakage, own use, or physical stock). The system will show this as stock; a person must confirm and post an adjustment. See business question Q3`, { review: true });
  }
  const stockCells = need('Sheet1');
  for (let r = 5; r <= stockCells.rowCount; r++) {
    const h = stockCells.at(r, 'H');
    if (h.value !== null) issues.add('INFO', 'Sheet1', 'STOCK_NOTE_IGNORED', `Free-text "Stock" note "${h.value}" on ${toIsoDate(stockCells.at(r, 'A').value) ?? 'row ' + r} has no defined meaning and was not used`, { cell: h.addr, original: String(h.value), review: false });
  }
  const blankCEO = need('Sheet1').at(3, 'F').value;
  if (blankCEO) issues.add('INFO', 'Sheet1', 'EMPTY_COLUMN', `Column "${blankCEO}" contains no data`, { cell: 'Sheet1!F', review: false });

  const expenseTotal = s1.expenses.reduce((a, e) => a.plus(e.total), ZERO);
  return {
    coops: prod.coops,
    production: prod.out,
    sales: s1.sales,
    expenses: s1.expenses,
    prices: s1.prices,
    issues: issues.list,
    stats: {
      productionRowsRead: prod.rowsRead,
      productionShiftsSkippedBlank: prod.skippedBlank,
      productionEggs,
      salesEggs,
      salesRevenue: s1.sales.reduce((a, x) => a.plus(x.total), ZERO),
      expenseTotal,
      ledgerBalanceEggs: balance,
      sheet1ExpenseTotalAsStored: s1.storedExpenseTotal,
      expenditureLinesTotal: exp.lines,
      expenditureMatchedDuplicates: exp.duplicates,
      expenditureQueuedForReview: exp.queued,
    },
  };
}
