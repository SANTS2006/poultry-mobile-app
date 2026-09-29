# Migration report — Makarifor workbook

- Mode: **DRY RUN (nothing written to any database)**
- Source: `Makarifor Agriculture Management- Poultry.xlsx` (SHA-256 `d510f95ae3b649971c7799c1df945eb26764b3cf0693c56340d244489b672fd3`)
- The source file is opened read-only and is never modified.

## Summary

| Entity | Imported | Flagged for review | Notes |
|---|---:|---:|---|
| Production records (coop × day × shift) | 321 | 9 | 36 dated rows read; 3 blank shifts not created |
| Sales (one per day, walk-in, cash) | 22 | 6 | Sheet1 is authoritative |
| Expenses (line items) | 93 | 36 | Sheet1 category columns |
| Expenditure sheet lines | — | 14 | 28 lines: 14 duplicates of Sheet1 skipped, 14 queued for a person to decide; none imported automatically |
| Price history (carton) | 1 | 0 | 1550 from 2026-06-17 |

Findings: **0 errors**, **27 warnings**, 38 informational; **27 need a person's decision** (all listed in `issues.csv`).

## Reconciliation (independent of the database)

| Check | Value |
|---|---:|
| Eggs produced (Daily Egg Report) | 95,423 |
| Eggs sold (Sheet1) | 78,300 |
| Opening stock supplied for this run | 0 |
| **Resulting stock after import** | **17,123** |
| Sales revenue imported | 337125 |
| Expense line items imported | 290437 |
| Sheet1 "Total Expenses" column as stored | 285037 |
| Sales minus expenses (cash-flow indication, **not profit**) | 46688 |

## What needs a person

| Code | Count | Example |
|---|---:|---|
| EXPENDITURE_UNMATCHED | 6 | "Paid debt to Mr Ibrahim" 14000 on 2026-06-20 is not in Sheet1 for that date. Not imported (could be a missing entry or a different figure); please decide |
| SALES_SOURCE_CONFLICT | 5 | 2026-06-17: Sheet1 = 1440 eggs / 6200; Sheet2 = 1620 eggs (4 cartons + 6 crates) / 6750 (Sheet2 unit prices: 1500 per carton, 125 per crate). Sheet1 was imported and flagged; Sheet2 was not. |
| EXPENDITURE_UNDATED | 5 | "Concentrate" 11200 has no date (same amount as Sheet1!L14 on 2026-06-26 — if it is that purchase it is a duplicate); not imported |
| EXPENSE_TOTAL_MISMATCH | 2 | 2026-07-01: workbook "Total Expenses" is 16000 but the line items add up to 21000 (difference 5000). The importer uses the line items. |
| CASH_BALANCE_NOTE | 2 | "money at hand" 26020 (2026-06-27) is a cash balance, not an expense; not imported. Whether it is a physical count is business question Q7 |
| TEXT_QUANTITY_PARSED | 1 | Quantity "15 + 6 Crates" on 2026-07-04 read as 15 cartons + 6 crates |
| CRATE_PRICE_DERIVED | 1 | Crates on 2026-07-04 were priced by hand in the workbook (775 for 6 crates); the crate price is not defined anywhere else (Sheet2 uses 125, pro-rata would be 129.17). See business question Q2 |
| CASH_COLUMN_NOT_IMPORTED | 1 | "Cash Remaining" (AC) and the unlabelled running column (AB) are not imported: 7 different formula shapes and 1 typed value(s) (AC24). Cash flow is recomputed from sales and expenses instead. |
| PRODUCTION_SOURCE_CONFLICT | 1 | 2026-06-21: Sheet1 says 3145 eggs produced but Daily Egg Report (per coop and shift) says 2065 (difference 1080). Daily Egg Report was imported. |
| EXPENDITURE_LINE_NO_AMOUNT | 1 | "Marie - Dept" has no amount; not imported (amount cannot be invented) |
| NEGATIVE_STOCK_ON_DATE | 1 | Recorded sales exceed recorded production by up to 7751 eggs (worst on 2026-07-04), so at least 7751 eggs must have been in stock on 2026-06-17 before the first entry. The opening stock is not in the workbook and is not  |
| UNACCOUNTED_STOCK | 1 | Production (95423) minus sales (78300) leaves 17123 eggs that no sheet accounts for (unrecorded sales, breakage, own use, or physical stock). The system will show this as stock; a person must confirm and post an adjustme |

## Informational

| Code | Count |
|---|---:|
| SHIFT_NOT_RECORDED | 3 |
| EMPTY_TEMPLATE_ROWS | 1 |
| UNNORMALISED_UNITS | 1 |
| EXPENSE_SPLIT | 15 |
| HARDCODED_TOTALS | 1 |
| EXPENDITURE_DUPLICATE_OF_SHEET1 | 14 |
| STOCK_NOTE_IGNORED | 2 |
| EMPTY_COLUMN | 1 |

## Rules applied

- Daily Egg Report is authoritative for production; Sheet1 for sales, prices and expenses; Sheet2 and Expenditure are compared, never merged.
- Conversion factors come from the configurable unit table (crate = 30 eggs, carton = 12 crates = 360 eggs).
- A blank shift is "not recorded"; an entered 0 is a recorded zero. Blank rows in the future are skipped.
- A multi-item expense cell is split only when the amounts in its text add up exactly to the amount cell.
- Misc and Loan/Debt lines are imported but flagged (their meaning is open business questions Q6/Q8).
- Cash-remaining figures are not imported; nothing is invented (no opening stock, no crate price, no customers).
