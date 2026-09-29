import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import type { ImportPlan, Issue } from './types';

const n = (v: number) => v.toLocaleString('en-US');
const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

export function issuesCsv(issues: Issue[]): string {
  const rows = [['severity', 'needs_manual_review', 'sheet', 'cell', 'code', 'message', 'original']];
  const order = { ERROR: 0, WARNING: 1, INFO: 2 } as const;
  for (const i of [...issues].sort((a, b) => order[a.severity] - order[b.severity] || a.code.localeCompare(b.code))) {
    rows.push([i.severity, i.needsManualReview ? 'yes' : 'no', i.sheet, i.cell ?? '', i.code, i.message, i.original ?? '']);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

export interface ReportContext {
  sourceFile: string;
  sha256: string;
  mode: 'DRY RUN (nothing written to any database)' | 'COMMIT';
  openingStockEggs: number;
  loaded?: { production: number; sales: number; expenses: number; skippedExisting: Record<string, number> };
}

export function markdownReport(plan: ImportPlan, ctx: ReportContext): string {
  const s = plan.stats;
  const by = (sev: Issue['severity']) => plan.issues.filter((i) => i.severity === sev).length;
  const review = plan.issues.filter((i) => i.needsManualReview);
  const flaggedProduction = plan.production.filter((p) => p.needsReview).length;
  const flaggedSales = plan.sales.filter((x) => x.needsReview).length;
  const flaggedExpenses = plan.expenses.filter((e) => e.needsReview).length;
  const grouped = new Map<string, Issue[]>();
  for (const i of plan.issues) grouped.set(i.code, [...(grouped.get(i.code) ?? []), i]);
  const closing = s.ledgerBalanceEggs + ctx.openingStockEggs;

  const L: string[] = [];
  L.push('# Migration report — Makarifor workbook', '');
  L.push(`- Mode: **${ctx.mode}**`, `- Source: \`${ctx.sourceFile}\` (SHA-256 \`${ctx.sha256}\`)`, '- The source file is opened read-only and is never modified.', '');
  L.push('## Summary', '', '| Entity | Imported | Flagged for review | Notes |', '|---|---:|---:|---|');
  L.push(`| Production records (coop × day × shift) | ${n(plan.production.length)} | ${n(flaggedProduction)} | ${n(s.productionRowsRead)} dated rows read; ${n(s.productionShiftsSkippedBlank)} blank shifts not created |`);
  L.push(`| Sales (one per day, walk-in, cash) | ${n(plan.sales.length)} | ${n(flaggedSales)} | Sheet1 is authoritative |`);
  L.push(`| Expenses (line items) | ${n(plan.expenses.length)} | ${n(flaggedExpenses)} | Sheet1 category columns |`);
  L.push(`| Expenditure sheet lines | — | ${n(s.expenditureQueuedForReview)} | ${n(s.expenditureLinesTotal)} lines: ${n(s.expenditureMatchedDuplicates)} duplicates of Sheet1 skipped, ${n(s.expenditureQueuedForReview)} queued for a person to decide; none imported automatically |`);
  L.push(`| Price history (carton) | ${plan.prices.length} | 0 | ${plan.prices.map((p) => `${p.amount.toString()} from ${p.effectiveFrom}`).join('; ')} |`);
  L.push('', `Findings: **${by('ERROR')} errors**, **${by('WARNING')} warnings**, ${by('INFO')} informational; **${review.length} need a person's decision** (all listed in \`issues.csv\`).`, '');
  L.push('## Reconciliation (independent of the database)', '', '| Check | Value |', '|---|---:|');
  L.push(`| Eggs produced (Daily Egg Report) | ${n(s.productionEggs)} |`, `| Eggs sold (Sheet1) | ${n(s.salesEggs)} |`);
  L.push(`| Opening stock supplied for this run | ${n(ctx.openingStockEggs)} |`, `| **Resulting stock after import** | **${n(closing)}** |`);
  L.push(`| Sales revenue imported | ${s.salesRevenue.toString()} |`, `| Expense line items imported | ${s.expenseTotal.toString()} |`, `| Sheet1 "Total Expenses" column as stored | ${s.sheet1ExpenseTotalAsStored.toString()} |`);
  L.push(`| Sales minus expenses (cash-flow indication, **not profit**) | ${s.salesRevenue.minus(s.expenseTotal).toString()} |`, '');
  if (ctx.loaded) {
    L.push('## Load result', '', `- Inserted: ${ctx.loaded.production} production, ${ctx.loaded.sales} sales, ${ctx.loaded.expenses} expenses`);
    for (const [k, v] of Object.entries(ctx.loaded.skippedExisting)) L.push(`- Already present from an earlier run (skipped): ${k} ${v}`);
    L.push('');
  }
  L.push('## What needs a person', '');
  const codes = [...grouped.entries()].filter(([, v]) => v.some((i) => i.needsManualReview)).sort((a, b) => b[1].length - a[1].length);
  L.push('| Code | Count | Example |', '|---|---:|---|');
  for (const [code, list] of codes) L.push(`| ${code} | ${list.length} | ${list[0].message.replace(/\|/g, '/').slice(0, 220)} |`);
  L.push('', '## Informational', '', '| Code | Count |', '|---|---:|');
  for (const [code, list] of [...grouped.entries()].filter(([, v]) => v.every((i) => !i.needsManualReview))) L.push(`| ${code} | ${list.length} |`);
  L.push('', '## Rules applied', '',
    '- Daily Egg Report is authoritative for production; Sheet1 for sales, prices and expenses; Sheet2 and Expenditure are compared, never merged.',
    '- Conversion factors come from the configurable unit table (crate = 30 eggs, carton = 12 crates = 360 eggs).',
    '- A blank shift is "not recorded"; an entered 0 is a recorded zero. Blank rows in the future are skipped.',
    '- A multi-item expense cell is split only when the amounts in its text add up exactly to the amount cell.',
    '- Misc and Loan/Debt lines are imported but flagged (their meaning is open business questions Q6/Q8).',
    '- Cash-remaining figures are not imported; nothing is invented (no opening stock, no crate price, no customers).', '');
  return L.join('\n');
}
