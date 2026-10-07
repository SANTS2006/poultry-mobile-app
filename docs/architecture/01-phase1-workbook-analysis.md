# Phase 1 — Workbook Analysis

Source: `migration/source/Makarifor Agriculture Management- Poultry.xlsx`
(SHA-256 `d510f95a…d3`, 42,566 bytes). The file is an untouched archive copy and must never be edited.
All figures below were read directly from the workbook (formulas and cached values). Currency is written "Le" in the workbook; the brief uses NLe. **Confirm** (Q1).

## 1. Workbook inventory

| Sheet | Range | What it actually is |
|---|---|---|
| `Daily Egg Report` | A1:AR45 | Production log: 1 row per date; 3 coops × 3 shifts × (Cartons, Crates, Single Eggs) typed by hand; formulas compute per-coop totals, all-coop total, and a re-split into cartons/crates/singles |
| `Sheet1` | A3:AE50 | Daily business ledger: production summary (typed), eggs sold, price, sales, 8 expense-category column pairs (Item + Amount), daily expense total, running "cash remaining" |
| `Sheet2` | B2:I9 | Sales detail for **5 days only** (17–21 Jun): cartons and crates sold, unit prices, amount |
| `Expenditure` | A2:F37 | Free-form expense/cash notebook: numbered list, occasional date rows, "money at hand" balances, and one income row ("sales") |

No hidden sheets, no defined names, no macros. Data span: **17 Jun 2026 – 22 Jul 2026** (36 production days; rows to 27 Jul / 31 Jul are pre-filled empty template rows carrying only the price 1550).

## 2. Business process analysis

Excel is currently doing five jobs at once:

1. **Production recording** (3 coops, 3 shifts, three units).
2. **Egg stock** — *not actually done*. Sheet1 has a "Stock" column with only two text entries (`5`, `4 Crate`). There is no inventory ledger.
3. **Sales** — cash-only, walk-in, priced per carton; no customer names anywhere.
4. **Expenses** — categorised in Sheet1, uncategorised free-text in Expenditure.
5. **Cash position** — a running "Cash Remaining" that mixes sales, expenses, and hand-adjusted values.

## 3. Mapping: Excel → function → table → API → screen → logic

| Excel source | Business function | Tables | API | Screen | Logic |
|---|---|---|---|---|---|
| Daily Egg Report B:J, L:T, V:AD | Shift production per coop | `production_records`, `production_entries` | `POST/GET /production` | Production, Add Production | store base eggs (canonical) + entered units; totals derived |
| Daily Egg Report K/U/AE/AF/AG:AR | Coop/day totals + carton/crate/single re-split | *(derived, not stored)* | reports/dashboard | Dashboard, Reports | `cartons=INT(t/360)`, `crates=INT(MOD(t,360)/30)`, `singles=MOD(t,30)` |
| Sheet1 A,G,I,J; Sheet2 | Sales | `sales`, `sale_items`, `prices` | `POST /sales` | New Sale | qty × server price (NUMERIC) |
| Sheet1 H "Stock" | Inventory | `inventory_transactions` (ledger), `inventory_balances` (cache) | `/inventory` | Inventory | opening + production − sales ± adjustments |
| Sheet1 K:Z (8 category pairs), Expenditure | Expenses | `expenses`, `expense_categories`, `suppliers` | `/expenses` | New Expense | one row per item |
| Sheet1 X "Loan", Expenditure "Paid debt…" | Debt repayment | `expenses` (category *Loans/Debts*) + `suppliers` | `/expenses` | Expenses | needs Q6 |
| Sheet1 AB/AC, Expenditure "money at hand" | Cash position | *(derived)* + optional `cash_counts` | `/reports/financial` | Dashboard | see Q7 — must be computed, not typed |

## 4. Data dictionary

**Units (confirmed by formulas):** 1 crate = 30 eggs; 1 carton = 12 crates = 360 eggs. Canonical stored unit: **egg**.

**Daily Egg Report:** `A` date; per coop/shift `Cartons`, `Crates`, `Single Eggs` (cols B–J Coop 1, L–T Coop 2, V–AD Coop 3); `K/U/AE` coop total eggs `=(cartons*12*30)+(crates*30)+singles` summed over 3 shifts; `AF` = K+U+AE; `AG:AR` per-coop and total re-split.

**Sheet1:** `A` date; `B:D` eggs produced (cartoon/crates/single, typed); `E` `=B*360+C*30+D`; `F` "CEO/Visitors" (empty; header only); `G` cartons sold; `H` stock (nearly empty); `I` price/carton (1550); `J` `=G*I`; expense pairs Feed (K,L), Transport (M,N), Labour (O,P), Medication (Q,R), Packaging (S,T), Utilities (U,V), Loan (W,X), Misc (Y,Z); `AA` total expenses; `AB` cumulative sales (unlabelled); `AC` cash remaining.

**Sheet2:** `B` date; `C,D` cartons/crates sold; `E,F` unit price (1500/carton, 125/crate); `G` amount.

**Expenditure:** `B` no.; `C` item; `D` unit (really quantity); `E` cost; `F` total; `A` occasional date marker.

## 5. Business rules discovered

- R1 crate=30 eggs, carton=12 crates=360 eggs (used in every formula, hard-coded ×360/×30 — to become configurable settings).
- R2 Three coops, three shifts (Morning/Afternoon/Evening); an empty shift is entered as 0 or left blank.
- R3 Sale amount = quantity × unit price; sales are recorded in cartons on Sheet1.
- R4 Price currently 1550 per carton (Sheet1) — but Sheet2 uses 1500 per carton and 125 per crate.
- R5 Eight expense categories: **Feed, Transport, Labour, Medication, Packaging, Utilities, Loan, Miscellaneous**.
- R6 Fractional cartons are priced pro-rata: 15 cartons + 6 crates = `15*1550 + 775` (6 crates = ½ carton). (Sheet2 instead prices crates at 125, which is 1500/12.)
- R7 Eggs are sometimes used as payment in kind (`Cartoon eggs for Brigadier`, 3×1500).
- R8 Feed pattern: concentrate 8 bags × 1,400 (later 1,450 × 12), corn purchased from "Mr Ibrahim", PKC 200/bag, egg crates 300–350 each, cartons 20 each.

## 6. Data inconsistencies discovered

| # | Finding | Evidence | Handling in migration |
|---|---|---|---|
| I1 | Production typed twice and disagreeing | 21 Jun: Daily Egg Report 2,065 eggs vs Sheet1 3,145 (diff 1,080 = 3 cartons; Sheet1 says 8 cartons, coop sheet implies 5). All other 35 dates agree. Totals 95,423 vs 96,503 | Use Daily Egg Report (per-shift detail); flag 21 Jun for review |
| I2 | Sales recorded twice with different values | 17 Jun: Sheet1 4 cartons = 6,200; Sheet2 4 cartons + 6 crates = 6,750. 18–21 Jun: Sheet1 1550/carton vs Sheet2 1500/carton (7,750 vs 7,500 etc.) | Flag; do not pick silently. Sheet2 has only 5 days |
| I3 | Sold quantity text cell | Sheet1 `G23` = "15 + 6 Crates" (J23 hand-formula `=(15*1550)+775`) | Parse to 15 cartons + 6 crates, flag |
| I4 | Sales vs production gap | 78,300 eggs sold (incl. `15 + 6 Crates` on 4 Jul) vs 95,423 produced → **17,123 eggs unaccounted for**; and running stock would have been negative by up to **7,751 eggs (4 Jul)** — so an opening stock of at least that size must have existed but is not in the workbook. No stock, damage or usage is recorded. *(Corrected in Phase 5: the earlier figure of 17,123 omitted the text-typed sale.)* | Cannot invent; opening stock must be supplied/confirmed (Q3) |
| I5 | Cash formulas inconsistent | `AC5=J-AA`; `AC14=J-AA`; `AC15=AC14-AA15+J15`; `AC20=AC18+Z20-AA20` (adds a *Misc expense* as income); `AC24` hard-coded 7020; `AB` column mixes cumulative sales and cash | Do not migrate cash figures; recompute from transactions; report the differences |
| I6 | Hard-coded totals overriding formulas | `AA25=840`, `AA31=2300`, `AA36=0`, `AA40=1530`; `AA20` omits the Misc amount `Z20` | Recompute expense totals from line items; flag mismatches |
| I7 | Multiple items in one cell | e.g. `O15` five people, `Y37` six items, `U20` "Feeders (300*13), Bike Tire (500)"; amounts as formulas `=3500+6350+…` | Split where parseable; else import as one flagged record with original text |
| I8 | Category misuse | "Misc" holds mostly named-person payments (Abu Kamara, Baba, Gen MBS, Marie Kamara…); "Labour" holds "Popo d bag", welder, funeral contribution; "Utilities" holds feeders and bike tyre | Import as recorded category, flag `needs_review`; do not reclassify silently |
| I9 | Expenditure vs Sheet1 disagree | 20 Jun: Sheet1 Loan 21,000 to "Mr Ibrahim & Mr Hassan" vs Expenditure 14,000 (+1,000 Hassan); board 700 vs 720 | Flag |
| I10 | Undated / unquantified Expenditure lines | Items 1–5 have no date; `Marie – Dept` has no amount; `Top up Brigadier` 200 no qty; `sales` 7 × 1550 sits in Expenditure as income; `money at hand` 26,020 / 13,300 are balances not expenses | Undated → manual review; balances → cash-count records; income row excluded from expenses |
| I11 | Spelling | Cartoon/Cartons/CARTOON(S), Crates/CRATE, "Single Egg(s)" | Normalise to unit codes CARTON/CRATE/EGG |
| I12 | Un-normalised units | `W18` = 21 crates in one shift (>12) | Keep as entered; base-egg total is unaffected |
| I13 | Blank vs 0 | 13 Jul evening shift blank for all coops; future rows show 0 totals | Blank ⇒ "not recorded", not 0; empty future rows skipped |
| I14 | Empty column | `CEO/Visitors` has no data | Ask Q4 (eggs given away?) |
| I15 | No customers, no credit/payment data | none in any sheet | Customers/credit modelled but start empty |

## 7. Business questions requiring confirmation

Defaults in brackets are implemented as configurable settings so work is not blocked.

1. **Currency**: Le (old) vs NLe? [NLe display, configurable]
2. **Price**: is the carton price 1550 (Sheet1) or 1500 (Sheet2)? Crate = price/12 (129.17) or a fixed 125? Who may change prices? [prices table with effective dates; only Owner/Super Admin]
3. **Stock**: what was the opening egg stock on 17 Jun? Where did the 17,123 eggs go (and what was the opening stock — at least 7,751 eggs) (stock, breakage, personal use, sold in crates/singles unrecorded)? [Opening stock = 0 with a flagged adjustment for review]
4. **"CEO/Visitors"** column: eggs given away/consumed? [Internal-usage transaction type]
5. **Credit sales** and named customers: does the farm sell on credit? Are there regular customers/wholesalers? [Walk-in default; credit enabled but off]
6. **"Misc" payments to individuals** (Abu Kamara, Baba, Gen MBS, Marie…): wages, advances, loans repaid, or personal? Should there be an Employees/advances category? [Import as-is, flagged]
7. **Cash**: is "money at hand" counted physically? Should the app track a cash balance with periodic counts? [Derived cash-flow only; optional cash-count entries]
8. **Loans/debts**: are Mr Ibrahim / Mr Hassan suppliers with running balances (corn bought on credit)? [Suppliers created; payables not tracked until confirmed]
9. **Eggs used as payment** ("Cartoon eggs for Brigadier"): count as internal usage or as a sale/expense? [Internal usage + expense at value, flagged]
10. **Who may edit/delete historical production and sales?** [No delete; correction records requiring permission + reason]
11. **Multiple farms** or just one? [One farm; schema is multi-farm capable]
12. **Expense approval** workflow needed? [Off; threshold configurable]
13. **Staff list and roles** (names/emails) and whether Owner requires MFA. [MFA enforced for Super Admin/Owner]
14. **Notification times** for daily summary and morning-production reminder; who receives them. [Configurable]
15. **Reference date**: workbook runs to 22 Jul 2026 — is data after that still on paper/Excel and to be added before go-live?
