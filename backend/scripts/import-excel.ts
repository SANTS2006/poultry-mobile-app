/* Excel → PostgreSQL migration tool.
     npm run import:excel -- --file <path.xlsx> [--out <reports dir>]                    dry run (default): analyse + write reports, touch no database
     npm run import:excel -- --file <path.xlsx> --commit [--opening-stock <eggs>]       load into the database from DATABASE_URL
   The workbook is opened read-only. Re-running --commit is safe: every record carries a unique source reference. */
import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { EGG_UNITS } from '../src/common/permissions';
import { commitPlan } from '../src/migration/loader';
import { buildPlan } from '../src/migration/plan';
import { issuesCsv, markdownReport, sha256File } from '../src/migration/report';
import { readWorkbook } from '../src/migration/workbook-reader';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : undefined; };
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const file = arg('file');
  if (!file) throw new Error('Usage: import-excel --file <workbook.xlsx> [--out dir] [--commit] [--opening-stock <eggs>]');
  const out = resolve(arg('out') ?? 'migration/reports');
  const openingStock = arg('opening-stock') ? Number(arg('opening-stock')) : 0;
  if (!Number.isInteger(openingStock) || openingStock < 0) throw new Error('--opening-stock must be a whole number of eggs ≥ 0');

  const units = Object.fromEntries(EGG_UNITS.map((u) => [u.code, u.eggsPerUnit])) as Record<'EGG' | 'CRATE' | 'CARTON', number>;
  const plan = buildPlan(await readWorkbook(file), units);
  const commit = flag('commit');
  let loaded;
  if (commit) loaded = await commitPlan(plan, { openingStockEggs: openingStock, sourceFile: file, sha256: sha256File(file) });

  mkdirSync(out, { recursive: true });
  const ctx = { sourceFile: file.split('/').pop() as string, sha256: sha256File(file), mode: (commit ? 'COMMIT' : 'DRY RUN (nothing written to any database)') as 'COMMIT', openingStockEggs: openingStock, loaded };
  writeFileSync(resolve(out, 'migration-report.md'), markdownReport(plan, ctx));
  writeFileSync(resolve(out, 'issues.csv'), issuesCsv(plan.issues));
  process.stdout.write(`${commit ? 'Committed' : 'Dry run complete'}. Reports written to ${out}\n`);
  process.stdout.write(`Production ${plan.production.length}, sales ${plan.sales.length}, expenses ${plan.expenses.length}; ${plan.issues.filter((i) => i.needsManualReview).length} findings need a person.\n`);
}

main().catch((e: unknown) => { process.stderr.write(`${e instanceof Error ? e.message : 'failed'}\n`); process.exit(1); });
