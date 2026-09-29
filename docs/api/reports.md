# Reports and exports (Phase 10)

Code: `backend/src/reports/`. Tests: `reports.spec.ts` (CSV, PDF, bucketing) and `backend/test/reports.e2e.spec.ts`
(20 end-to-end tests against real PostgreSQL with a deterministic June-2026 dataset; safeguards were mutation-checked).

## Endpoints (all under `/v1/reports`)
| View (JSON) | Download | Filters (besides `from`, `to`, `groupBy=day\|week\|month`, `detail=true`) |
|---|---|---|
| `GET /production` | `GET /production/export` | `coopId`, `shift` |
| `GET /sales` | `GET /sales/export` | `customerId`, `walkIn`, `paymentStatus`, `unit`, `createdById` |
| `GET /expenses` | `GET /expenses/export` | `categoryCode`, `supplierId`, `recordedById`, `needsReview` |
| `GET /inventory` | `GET /inventory/export` | – |
| `GET /financial` | `GET /financial/export` | – |

Exports add `format=csv|pdf` (required) and, for CSV, an optional `table=<name>` to download one table instead of every section.
Unknown parameters are rejected (400), as is a reversed, invalid or longer-than-366-day range.

## Who can see what
- Viewing needs `reports.read`; downloading additionally needs `reports.export` (Owner, Super Admin, Accountant by default; a Farm Manager may view but not download).
- Every report also requires the **data permissions** it is built from — checked for both views and exports, so a report can never contain more than the caller may already see:
  production → `production.read`; sales → `sales.read`; expenses → `expenses.read`; inventory → `inventory.read`; financial → `sales.read` + `expenses.read` + `payments.read`.
- Per-customer paid/outstanding columns and the "outstanding customer balances" table need `customers.financial`; without it they are omitted from JSON, CSV and PDF alike.
- Exports are rate limited (10 per minute per client) and **every successful export is audited** (`report.exported`: who, which report, range, filters, format, row count, bytes — never the data).

## Response shape
```
{ meta: { report, title, from, to, groupBy, filters, generatedAt, currency, timezone, notes[] },
  summary: { … flat key/values … },
  tables: [ { name, title, columns[{key,label,type}], rows[], totals? } ] }
```
Money is always a fixed 2-decimal **string** (`"8345.89"`) computed with exact decimal arithmetic, never a floating-point number. Counts are integers.
Empty periods appear as zero rows (no gaps in charts). Voided sales, payments, production records and expenses are excluded everywhere.

## Business rules
- **Dates** are business-calendar dates in `business.timezone`. Payments and stock movements are bucketed by that zone, not UTC (tested with a zone 12 h ahead).
  Back-dated production and sales now post their stock movement at noon of the business date, so inventory reports place them in the right period;
  voids and corrections stay dated "now" (they are corrections made today).
- **Weeks** are ISO weeks (Monday start). Week/month totals always equal the day totals (tested).
- **Financial report is cash flow, not profit.** Net cash flow = cash received in the period − expenses recorded in the period. It excludes cost of goods,
  stock valuation and depreciation, says so in `meta.notes` and in the PDF, and no field is named "profit". `salesMinusExpenses` (sales value − expenses) is shown separately.
- **Sales report `paid` / `outstanding`** are *as of now* for the sales in the period (a later collection reduces `outstanding`); use the financial report for cash received *in* a period.
- **Inventory report** reconciles opening + production + opening-stock entries − sales − own use − damage − loss ± adjustments/corrections = closing from the append-only ledger.
  When the range reaches today, `closingMatchesCurrentBalance` proves the ledger equals the cached balance. A note is added when sales exceeded recorded stock (missing opening stock).
- Undated imported expenses cannot appear in any period; they are counted in `undatedExpensesExcluded` and noted. Records flagged during the Excel import show as `needsReview`.

## CSV
UTF-8 with BOM (opens correctly in Excel), CRLF line ends, RFC-4180 quoting. **Formula injection guard:** text cells beginning with `= + - @ TAB CR` are prefixed with `'`
(genuine numbers, including negatives, are left alone). Tested with a malicious expense description.

## PDF
Generated with pdfkit (A4, title, period, generated-by/at, summary, tables with repeated headers, page footer numbering, caveat notes). Tests read the produced file back with an
independent PDF parser and assert the title, figures and "NOT profit" text are actually in it.

## Limits and honest caveats
- Reports are computed on demand from PostgreSQL (max 366 days, 100,000 export rows, 5,000 rows for JSON detail). Suitable for a single farm; there is no pre-aggregation or caching.
- Excel (.xlsx) export is not provided — CSV opens in Excel; add if the business needs formatting.
- PDF layout was verified by text extraction and page counts, not by visual inspection on a device.
- Scheduled/e-mailed reports are not implemented (the daily summary notification from Phase 9 is separate).
