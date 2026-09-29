import { createHash } from 'crypto';
import { copyFileSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import * as ExcelJS from 'exceljs';
import { EGG_UNITS } from '../common/permissions';
import { buildPlan, normalizeUnit, UnexpectedLayoutError } from './plan';
import { issuesCsv, markdownReport } from './report';
import { readWorkbook } from './workbook-reader';

const SOURCE = resolve(__dirname, '../../../migration/source/Makarifor Agriculture Management- Poultry.xlsx');
const units = Object.fromEntries(EGG_UNITS.map((u) => [u.code, u.eggsPerUnit])) as Record<'EGG' | 'CRATE' | 'CARTON', number>;
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

async function mutated(edit: (wb: ExcelJS.Workbook) => void): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(SOURCE);
  edit(wb);
  const path = join(mkdtempSync(join(tmpdir(), 'mk-')), 'mutated.xlsx');
  await wb.xlsx.writeFile(path);
  return path;
}

describe('Excel plan against the real workbook', () => {
  const shaBefore = sha(SOURCE);
  let plan: ReturnType<typeof buildPlan>;
  beforeAll(async () => { plan = buildPlan(await readWorkbook(SOURCE), units); });

  it('reconciles production to the workbook totals (95,423 eggs over 36 days × 9 shifts − 3 blank)', () => {
    expect(plan.stats.productionEggs).toBe(95_423);
    expect(plan.production).toHaveLength(321);
    expect(new Set(plan.production.map((p) => p.coop))).toEqual(new Set(['Coop 1', 'Coop 2', 'Coop 3']));
    expect(new Set(plan.production.map((p) => p.shift))).toEqual(new Set(['MORNING', 'AFTERNOON', 'EVENING']));
    // 17 Jun, Coop 1 morning = 1 carton + 7 crates = 570 eggs (workbook cell K5 includes afternoon 8 crates + 10 singles)
    const first = plan.production.find((p) => p.date === '2026-06-17' && p.coop === 'Coop 1' && p.shift === 'MORNING')!;
    expect(first.totalEggs).toBe(570);
    expect(first.entries).toEqual([
      { unit: 'CARTON', quantity: 1, baseEggs: 360 }, { unit: 'CRATE', quantity: 7, baseEggs: 210 }, { unit: 'EGG', quantity: 0, baseEggs: 0 },
    ]);
    const coop1Day1 = plan.production.filter((p) => p.date === '2026-06-17' && p.coop === 'Coop 1').reduce((a, p) => a + p.totalEggs, 0);
    expect(coop1Day1).toBe(820); // workbook K5
  });

  it('distinguishes blank shifts (not recorded) from entered zeros and skips future template rows', () => {
    const blank = plan.issues.filter((i) => i.code === 'SHIFT_NOT_RECORDED');
    expect(blank).toHaveLength(3); // 13 Jul evening × 3 coops
    expect(blank[0].message).toContain('2026-07-13');
    expect(plan.production.filter((p) => p.date === '2026-07-13' && p.shift === 'EVENING')).toHaveLength(0);
    expect(plan.production.some((p) => p.date > '2026-07-22')).toBe(false);
    expect(plan.production.find((p) => p.date === '2026-06-17' && p.coop === 'Coop 1' && p.shift === 'EVENING')?.totalEggs).toBe(0);
  });

  it('reconciles sales to Sheet1 (22 days, revenue 337,125, 78,300 eggs) and parses the text quantity', () => {
    expect(plan.sales).toHaveLength(22);
    expect(plan.stats.salesRevenue.toString()).toBe('337125');
    expect(plan.stats.salesEggs).toBe(78_300);
    const mixed = plan.sales.find((s) => s.date === '2026-07-04')!;
    expect(mixed.items.map((i) => [i.unit, i.quantity])).toEqual([['CARTON', 15], ['CRATE', 6]]);
    expect(mixed.total.toString()).toBe('24025');
    expect(mixed.needsReview).toBe(true);
  });

  it('records the carton price from the workbook and no crate price', () => {
    expect(plan.prices).toHaveLength(1);
    expect(plan.prices[0]).toMatchObject({ unit: 'CARTON', effectiveFrom: '2026-06-17', effectiveTo: null });
    expect(plan.prices[0].amount.toString()).toBe('1550');
  });

  it('flags every disagreement between Sheet1 and Sheet2 instead of choosing silently', () => {
    const conflicts = plan.issues.filter((i) => i.code === 'SALES_SOURCE_CONFLICT');
    expect(conflicts).toHaveLength(5);
    expect(conflicts.every((c) => c.needsManualReview)).toBe(true);
    expect(plan.sales.filter((s) => s.needsReview && s.date <= '2026-06-21')).toHaveLength(5);
  });

  it('flags the production conflict on 21 June and imports the per-shift figures', () => {
    const c = plan.issues.find((i) => i.code === 'PRODUCTION_SOURCE_CONFLICT')!;
    expect(c.message).toMatch(/3145.*2065.*1080/);
    expect(plan.production.filter((p) => p.date === '2026-06-21').every((p) => p.needsReview)).toBe(true);
    expect(plan.issues.filter((i) => i.code === 'PRODUCTION_SOURCE_CONFLICT')).toHaveLength(1);
  });

  it('itemises expenses and exposes the workbook’s own total errors', () => {
    expect(plan.expenses).toHaveLength(93);
    expect(plan.stats.expenseTotal.toString()).toBe('290437');
    expect(plan.stats.sheet1ExpenseTotalAsStored.toString()).toBe('285037');
    const mism = plan.issues.filter((i) => i.code === 'EXPENSE_TOTAL_MISMATCH').map((i) => i.message);
    expect(mism).toHaveLength(2);
    expect(mism.join(' ')).toMatch(/2026-07-01.*5000/);
    expect(mism.join(' ')).toMatch(/2026-07-10.*400/);
    const jun27 = plan.expenses.filter((e) => e.date === '2026-06-27' && e.categoryCode === 'LABOUR');
    expect(jun27.map((e) => e.total.toNumber())).toEqual([3500, 6350, 500, 3500, 400]);
    expect(new Set(plan.expenses.map((e) => e.categoryCode))).toEqual(new Set(['FEED', 'TRANSPORT', 'LABOUR', 'MEDICATION', 'PACKAGING', 'UTILITIES', 'LOANS_DEBTS', 'MISC']));
  });

  it('flags ambiguous categories (Misc, Loan) and keeps the original workbook text', () => {
    const misc = plan.expenses.filter((e) => e.categoryCode === 'MISC' || e.categoryCode === 'LOANS_DEBTS');
    expect(misc.length).toBeGreaterThan(20);
    expect(misc.every((e) => e.needsReview)).toBe(true);
    expect(plan.expenses.every((e) => e.originalText !== null)).toBe(true);
    expect(new Set(plan.expenses.map((e) => e.sourceRef)).size).toBe(plan.expenses.length); // unique lineage
  });

  it('never double-counts the Expenditure notebook: duplicates skipped, everything else queued for a person', () => {
    expect(plan.stats.expenditureLinesTotal).toBe(28);
    expect(plan.stats.expenditureMatchedDuplicates + plan.stats.expenditureQueuedForReview).toBe(28);
    expect(plan.stats.expenditureMatchedDuplicates).toBe(14);
    expect(plan.stats.expenditureQueuedForReview).toBe(14);
    const dup = plan.issues.filter((i) => i.code === 'EXPENDITURE_DUPLICATE_OF_SHEET1');
    expect(dup.some((i) => i.message.includes('General MBS') && i.message.includes('Sheet1!Z15'))).toBe(true);
    expect(dup.some((i) => i.message.includes('sales') && i.message.includes('2026-07-14'))).toBe(true); // income line, not an expense
    expect(dup.every((i) => !i.needsManualReview)).toBe(true);
    const codes = plan.issues.filter((i) => i.sheet === 'Expenditure').map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['EXPENDITURE_UNDATED', 'EXPENDITURE_UNMATCHED', 'CASH_BALANCE_NOTE', 'EXPENDITURE_LINE_NO_AMOUNT', 'EXPENDITURE_DUPLICATE_OF_SHEET1']));
    // nothing from the Expenditure sheet became an expense
    expect(plan.expenses.every((e) => e.sourceRef.startsWith('Sheet1!'))).toBe(true);
  });

  it('reports the unexplained stock and the opening stock that must have existed, without inventing either', () => {
    expect(plan.stats.ledgerBalanceEggs).toBe(17_123);
    const neg = plan.issues.find((i) => i.code === 'NEGATIVE_STOCK_ON_DATE')!;
    expect(neg.message).toMatch(/up to 7751 eggs.*2026-07-04/); // independently verified with a separate script
    expect(plan.issues.some((i) => i.code === 'UNACCOUNTED_STOCK' && i.needsManualReview)).toBe(true);
  });

  it('has no ERROR-level findings on the real workbook and never touches the source file', () => {
    expect(plan.issues.filter((i) => i.severity === 'ERROR')).toEqual([]);
    expect(sha(SOURCE)).toBe(shaBefore);
  });

  it('produces a report and CSV that list every finding', () => {
    const md = markdownReport(plan, { sourceFile: 'x.xlsx', sha256: 'abc', mode: 'DRY RUN (nothing written to any database)', openingStockEggs: 0 });
    expect(md).toContain('95,423');
    expect(md).toContain('17,123');
    expect(md).toContain('needs a person');
    const csv = issuesCsv(plan.issues);
    expect(csv.trim().split('\n')).toHaveLength(plan.issues.length + 1);
  });

  it('normalises the workbook’s unit spellings', () => {
    for (const t of ['Cartons', 'Cartoon', 'CARTOONS', 'CARTOON', 'carton']) expect(normalizeUnit(t)).toBe('CARTON');
    for (const t of ['Crates', 'CRATE', 'crates']) expect(normalizeUnit(t)).toBe('CRATE');
    for (const t of ['Single Eggs', 'SINGLE EGG', 'Single Egg']) expect(normalizeUnit(t)).toBe('EGG');
    expect(normalizeUnit('Pallet')).toBeNull();
  });
});

describe('Excel plan rejects or flags bad data instead of dropping it', () => {
  it('flags text/negative/fractional quantities and drops only the affected shift', async () => {
    const path = await mutated((wb) => {
      const ws = wb.getWorksheet('Daily Egg Report')!;
      ws.getCell('C6').value = 'seven'; // Coop 1 morning crates on 18 Jun
      ws.getCell('F7').value = -3; // Coop 1 afternoon crates 19 Jun
      ws.getCell('N8').value = 2.5; // Coop 2 morning singles 20 Jun
    });
    const p = buildPlan(await readWorkbook(path), units);
    const bad = p.issues.filter((i) => i.code === 'INVALID_QUANTITY');
    expect(bad.map((b) => b.cell).sort()).toEqual(['C6', 'F7', 'N8']);
    expect(bad.every((b) => b.severity === 'ERROR' && b.needsManualReview)).toBe(true);
    expect(p.production).toHaveLength(321 - 3);
    expect(p.production.find((x) => x.date === '2026-06-18' && x.coop === 'Coop 1' && x.shift === 'MORNING')).toBeUndefined();
  });

  it('reports duplicate dates and rows without a valid date', async () => {
    const path = await mutated((wb) => {
      const ws = wb.getWorksheet('Daily Egg Report')!;
      ws.getCell('A9').value = ws.getCell('A8').value; // duplicate 20 Jun
      ws.getCell('A10').value = 'yesterday';
    });
    const p = buildPlan(await readWorkbook(path), units);
    expect(p.issues.some((i) => i.code === 'DUPLICATE_DATE' && i.severity === 'ERROR')).toBe(true);
    expect(p.issues.some((i) => i.code === 'ROW_WITHOUT_VALID_DATE' && i.original === 'yesterday')).toBe(true);
  });

  it('refuses to import a sale that has quantity but no price, or an unreadable quantity', async () => {
    const path = await mutated((wb) => {
      const ws = wb.getWorksheet('Sheet1')!;
      ws.getCell('I5').value = null;
      ws.getCell('G6').value = 'a few';
    });
    const p = buildPlan(await readWorkbook(path), units);
    expect(p.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['SALE_WITHOUT_PRICE', 'UNPARSEABLE_QUANTITY']));
    expect(p.sales).toHaveLength(22 - 2);
  });

  it('keeps an expense whose text disagrees with its amount as ONE flagged record', async () => {
    const path = await mutated((wb) => {
      const ws = wb.getWorksheet('Sheet1')!;
      ws.getCell('Z23').value = 2100; // text says 1,500 + 500
    });
    const p = buildPlan(await readWorkbook(path), units);
    expect(p.issues.some((i) => i.code === 'EXPENSE_BREAKDOWN_MISMATCH' && i.cell === 'Z23')).toBe(true);
    const rows = p.expenses.filter((e) => e.sourceRef.startsWith('Sheet1!Z23'));
    expect(rows).toHaveLength(1);
    expect(rows[0].total.toString()).toBe('2100');
    expect(rows[0].needsReview).toBe(true);
  });

  it('does not import an item that has no amount, and flags an amount with no description', async () => {
    const path = await mutated((wb) => {
      const ws = wb.getWorksheet('Sheet1')!;
      ws.getCell('L8').value = null; // condiment without amount
      ws.getCell('K14').value = null; // concentrate description removed, amount stays
    });
    const p = buildPlan(await readWorkbook(path), units);
    expect(p.issues.some((i) => i.code === 'EXPENSE_ITEM_NO_AMOUNT')).toBe(true);
    expect(p.issues.some((i) => i.code === 'EXPENSE_WITHOUT_DESCRIPTION')).toBe(true);
    expect(p.expenses.find((e) => e.sourceRef === 'Sheet1!L14')?.needsReview).toBe(true);
  });

  it('stops with a clear message when the workbook layout changed', async () => {
    const path = await mutated((wb) => { wb.getWorksheet('Sheet1')!.getCell('G3').value = 'Boxes'; });
    let error: unknown;
    try { buildPlan(await readWorkbook(path), units); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(UnexpectedLayoutError);
    expect((error as Error).message).toMatch(/Sheet1!G3.*sold/);
  });

  it('stops when a worksheet is missing', async () => {
    const path = await mutated((wb) => { wb.removeWorksheet(wb.getWorksheet('Sheet2')!.id); });
    let error: unknown;
    try { buildPlan(await readWorkbook(path), units); } catch (e) { error = e; }
    expect((error as Error).message).toMatch(/Sheet2.*not found/);
  });

  it('copies of the source are byte-identical (sanity for the mutation helper)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mk-'));
    copyFileSync(SOURCE, join(dir, 'a.xlsx'));
    expect(sha(join(dir, 'a.xlsx'))).toBe(sha(SOURCE));
  });
});

