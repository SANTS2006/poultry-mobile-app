# Core operations API (Phase 6)

All routes are under `/v1`, need `Authorization: Bearer <access token>`, and are authorised on the server (deny-by-default; see
`docs/security/authentication-and-access-control.md`). Money is always a **decimal string** (`"1550"`, `"387.51"`), never a JSON
number; egg quantities are integers of base eggs. Dates are `YYYY-MM-DD` in the business time zone (`business.timezone`, default `Africa/Freetown`).
Lists are server-side paginated: `?page=1&limit=25` (max 100) and return `{ items, page, limit, total }`.

## Rules that apply to every write
- **Atomic**: each operation is one database transaction (business rows + inventory ledger + audit record). A failure leaves nothing behind.
- **Idempotent offline re-sends**: every create accepts an optional client-generated `clientId` (UUID). The first request returns `201`; an identical
  re-send returns `200` with the original record and changes nothing. Another user re-using the same id gets `409`.
- **Corrections, not edits, for financial facts**: sales are immutable — a mistake is corrected by `POST …/void` (reason ≥ 5 chars) and re-entry.
  Production and expenses can be corrected with `PATCH` using `version` (optimistic lock; a stale version returns `409`) and a `reason`.
  Nothing financial is ever physically deleted.
- **Unknown fields are rejected (400)**, so a client cannot supply totals, prices, statuses, user ids, etc.
- **Events** (`production.created`, `inventory.updated`, `sale.created`, `payment.created`, `expense.created`, …) are published in-process only *after commit*.
  A rolled-back or replayed request publishes nothing. WebSocket delivery and notifications subscribe to these in Phases 7 and 9.

## Endpoints
| Area | Endpoint | Permission | Notes |
|---|---|---|---|
| Reference | `GET /coops`, `GET /units` | `production.read` | units expose egg conversion (from the database unit table) |
| | `POST /coops`, `PATCH /coops/:id` | `farms.manage` | |
| | `GET /products` | `sales.read` | includes current prices |
| | `GET /prices`, `POST /prices` | `prices.manage` | append-only; a new price closes the open one; reason required; audited |
| Production | `POST /production` | `production.create` | `{coopId, shift, entries:[{unit,quantity}], productionDate?, notes?, clientId?}`; server converts units and totals |
| | `GET /production`, `GET /production/:id` | `production.read` | filters: from, to, coopId, shift, recordedById, status, needsReview |
| | `PATCH /production/:id` | `production.update` | `{entries, version, reason}`; only the difference is posted to the ledger |
| | `POST /production/:id/void` | `production.delete` | reversing ledger entry; frees the coop/date/shift slot |
| Inventory | `GET /inventory` | `inventory.read` | balance, carton/crate/egg breakdown, low-stock flag |
| | `GET /inventory/transactions`, `GET /inventory/reconciliation` | `inventory.read` | ledger history; proves balance = ledger sum |
| | `POST /inventory/adjustments` | `inventory.adjust` | types ADJUSTMENT (+`direction`), DAMAGE, LOSS, USAGE; reason required; never below zero |
| Customers | `POST/GET/PATCH /customers` | `customers.create/read/update` | credit terms and balances need `customers.financial` |
| | `GET /customers/:id/statement` | `customers.financial` | sales + payments history |
| Sales | `POST /sales` | `sales.create` | see below |
| | `GET /sales`, `GET /sales/:id` | `sales.read` | filters: from, to, customerId, walkIn, paymentStatus, createdById, status, needsReview |
| | `POST /sales/:id/void` | `sales.delete` | stock returns via a correction entry; payments voided |
| Payments | `POST /payments` | `payments.create` | `saleId` **or** `customerId` (oldest sale first); never above what is owed |
| | `GET /payments` | `payments.read` | |
| | `POST /payments/:id/void` | `sales.delete` | |
| Expenses | `POST/GET/PATCH /expenses`, `POST /expenses/:id/void` | `expenses.create/read/update/delete` | total = quantity × unit cost computed on the server |
| | `GET /expense-categories` | `expenses.read` | |
| | `GET/POST/PATCH /suppliers` | `suppliers.read/manage` | |

## Creating a sale (server-side flow)
Request: `{ customerId?, saleDate?, items:[{unit, quantity}], discount?, paymentMethod?, amountPaid?, notes?, clientId? }` — **no price or total fields exist**.
1. validate; 2. resolve customer (omitted = walk-in); 3. look up the price **in force on the sale date** for each unit (`422` if a unit has no price);
4. compute subtotal/discount/total with exact decimals; 5. apply payment rules; 6. lock the stock row and deduct eggs (`409` if insufficient);
7. create sale, items, payment; 8. write audit; 9. commit; 10. publish events.
- `amountPaid` omitted → paid in full; `"0"` → on credit; between → part payment. Anything less than the total needs credit enabled
  (`sales.creditEnabled`, **off by default**), a registered customer approved for credit, and outstanding + new debt ≤ the customer's credit limit.
- Discounts need `sales.update` (Owner / Super Admin by default). Sales older than `sales.backdateDays` (31) need `sales.update`.
- The sale keeps the unit price used at the time; later price changes never alter it.

## Settings used (system_settings, editable by administrators in a later phase)
`production.maxEggsPerRecord` (50,000), `production.backdateDays` (7), `sales.backdateDays` (31), `sales.creditEnabled` (false),
`inventory.lowStockThresholdEggs` (1,000), `business.timezone`.

## Deliberately not implemented yet (so nothing is faked)
- **Expense approval workflow** (business question Q12): the `expenses.approvalThreshold` setting exists but is not enforced.
- **Receipt attachments**: the table exists; file storage is not chosen or built.
- **Employees/wages, transfers between coops, stock-in from suppliers**: no source data in the workbook; not modelled as features.
- **Editing a sale**: by design only void + re-enter.
- **Negative stock**: impossible (checked in code and by a database CHECK). The historical workbook needed an opening stock (see migration docs).
- Reports, exports, dashboard: Phase 7 (dashboard/realtime) and Phase 10.
