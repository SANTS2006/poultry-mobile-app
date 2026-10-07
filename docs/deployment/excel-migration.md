# Excel → PostgreSQL migration (Phase 5)

Code: `backend/src/migration/` (parser, planner, loader, report) and `backend/scripts/import-excel.ts` (CLI).
The tool lives in the backend package because it shares the Prisma client, unit table and audit service; `migration/` holds
the archived source workbook and generated reports. `exceljs` is a **dev** dependency: the operator runs the tool, it is not shipped with the API.

## Running it
```bash
cd backend
# 1. Dry run (default). Reads the workbook only, touches NO database, writes migration/reports/{migration-report.md,issues.csv}
npm run import:excel -- --file "../migration/source/Makarifor Agriculture Management- Poultry.xlsx" --out ../migration/reports

# 2. Commit (after `prisma migrate deploy` and `npm run db:seed`; uses DATABASE_URL)
npm run import:excel -- --file "…xlsx" --commit [--opening-stock <eggs>]
```
The commit is **one database transaction** (farm, coops, production, ledger, prices, sales, payments, expenses, balance, import log,
audit record): it succeeds completely or leaves nothing behind. Every record carries a unique `sourceRef` (e.g. `Sheet1!Z15#3`), so
re-running skips what already exists (verified: a second run inserts 0 rows). The workbook is opened read-only; its SHA-256 is stored with the import batch.

## What is imported, and from where
| Data | Source | Rule |
|---|---|---|
| Production | Daily Egg Report | one record per coop × day × shift; quantities stored as eggs using the database unit table (crate 30, carton 360); cross-checked with the sheet's own totals |
| Sales | Sheet1 col G × I | one walk-in **cash** sale per day + a payment + a ledger SALE row; the price used is stored on the sale item |
| Price | Sheet1 col I | carton price history only. **No crate price is invented** |
| Expenses | Sheet1 eight category column pairs | text cells split into items only when the written amounts add up exactly to the amount cell; original text kept |
| Stock | ledger | PRODUCTION and SALE rows; balance = ledger sum. **No opening stock unless you pass `--opening-stock`** |

Never imported (queued for a person instead, all in `issues.csv`): Expenditure-sheet lines that are not exact duplicates of a Sheet1 line
(undated lines, unmatched amounts, "money at hand" balances, lines without an amount), Sheet2 sales (compared with Sheet1, conflicts flagged),
the "Cash Remaining"/running columns (inconsistent formulas; cash is recomputed from transactions).

## Result on the current workbook (dry run, reproducible)
321 production records = **95,423 eggs**; 22 sales = **337,125**; 93 expense lines = **290,437**; 0 errors, 27 findings that need a person.
See `migration/reports/migration-report.md`. Key findings:
- The workbook's own **"Total Expenses" is 285,037**: two days omit items (1 Jul omits a 5,000 Misc payment that the cash formula treats as *income*; 10 Jul omits 400 of medication) and three cells are typed numbers.
- Production on 21 Jun is typed twice with different values (3,145 vs 2,065 eggs); the per-shift sheet was used.
- Sheet1 and Sheet2 disagree on all five days they overlap (quantities and unit prices 1,550 vs 1,500).
- Sales total 78,300 eggs, production 95,423: **17,123 eggs unaccounted for**, and sales outran recorded production by up to **7,751 eggs (4 Jul)**, so a real opening stock existed that the workbook never recorded. The system will show the ledger balance (17,123) until a person confirms the opening stock and any losses/own use.

## After the import: what a person must do
1. Work through `issues.csv` (`needs_manual_review = yes`). Flagged records exist in the database with `needsReview = true` (production, sales, expenses, ledger rows), so they can be filtered in the app.
2. Confirm the opening stock (physical count) and post inventory adjustments; then re-run the commit with `--opening-stock <eggs>`: it is added once (a second value is ignored, never doubled) and flagged for confirmation. Corrections after that go through the normal inventory-adjustment feature (Phase 6).
3. Decide the open business questions (Q2 price/crate price, Q3 stock, Q6 Misc payments, Q7 cash, Q8 loans). Answers change flags/categories, not the archived workbook.
4. Do not enter new operations in Excel after cut-over: the database is then the source of truth.

## Safety properties (all tested in `plan.spec.ts` / `import.e2e.spec.ts`)
Layout drift stops the run with a message naming the cell; bad values (text/negative/fractional quantities, duplicate or missing dates, sale without price, unreadable quantity, item without amount) are reported with cell references and only the affected record is withheld; a failure mid-load rolls everything back; a load that would make stock negative is refused; unit conversions in the plan must equal the database table.

## Limitations
- Times of day are not in the workbook: ledger/payment timestamps use 12:00 UTC of the business date.
- Every sale is assumed cash and walk-in (the workbook has no customers or credit) — confirm with Q5.
- Misc/Loan lines are flagged wholesale rather than classified; the tool does not guess whether a name is a supplier, employee or advance.
- Only the current workbook layout is supported; a layout change is refused, not guessed.
