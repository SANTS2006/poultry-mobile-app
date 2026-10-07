# Phase 2 — Architecture Proposal (for approval before implementation)

Stack (fixed): Expo/React Native + TypeScript + Expo Router + TanStack Query + Zustand → HTTPS/WebSocket → NestJS (Node/TypeScript) + Prisma → PostgreSQL on Neon. The mobile app never holds DB credentials.

## 1. Repository layout
Monorepo (npm workspaces): `backend/` (NestJS), `mobile/` (Expo), `migration/` (importer + reports; `source/` holds the untouched workbook), `docs/`, `.github/workflows/`. A shared `packages/domain` holds egg-unit conversion and money helpers used by importer, backend and mobile so the conversion rules exist in one place (values still come from `system_settings`).

## 2. Database schema (Prisma / Neon)
All PKs UUID; money `NUMERIC(14,2)`; quantities in **eggs** `INTEGER`/`BIGINT`; `timestamptz`; soft delete (`deleted_at`) on masters and financial docs; `version INT` on editable records; `client_id`/idempotency key unique where records can originate offline.

- **Identity/security:** `users`(email uq, password_hash argon2id, status, mfa_enabled, failed_attempts, locked_until, token_version), `profiles`, `roles`, `permissions`(code uq e.g. `sales.create`), `role_permissions`, `user_roles`, `sessions`(refresh-token hash, family_id, device, ip, revoked_at), `mfa_secrets`(encrypted), `recovery_codes`(hashed), `email_tokens`(verify/reset/invite, hashed, expiry).
- **Farm:** `farms`, `coops`(farm_id, name, active), `shifts`(MORNING/AFTERNOON/EVENING — table so it is configurable).
- **Catalog/pricing:** `products`(e.g. Table Egg), `product_units`(EGG, CRATE=30, CARTON=360 — the conversion source of truth), `prices`(product_id, unit_id, amount, effective_from/to, changed_by; never updated in place).
- **Production:** `production_records`(farm, coop, date, shift, unique(coop,date,shift), status, version, client_id uq), `production_entries`(record, unit, quantity, base_eggs). Corrections create a linked adjustment, not an overwrite.
- **Inventory:** `inventory_transactions`(product, type ∈ OPENING|PRODUCTION|SALE|USAGE|DAMAGE|LOSS|ADJUSTMENT|TRANSFER|CORRECTION, quantity_eggs signed, source_type/source_id, occurred_at, client_id uq, reason) — append-only; `inventory_balances` (per farm+product, maintained in the same DB transaction; reconciled nightly against `SUM(ledger)`; CHECK `>= 0` unless `allow_negative_stock`).
- **Sales/payments:** `customers`(type WALK_IN/REGULAR/WHOLESALE, credit_allowed, credit_limit), `sales`(number, customer, sale_date, subtotal, discount, total, paid_amount, payment_status, status, client_id uq), `sale_items`(product, unit, qty, unit_price_at_sale, line_total), `payments`(sale_id nullable, customer, amount, method, received_by, client_id uq) — customer balance = derived from sales − payments, never typed.
- **Expenses:** `expense_categories`(seeded: Feed, Transport, Labour, Medication, Packaging, Utilities, Loans/Debts, Miscellaneous), `suppliers`, `expenses`(category, description, quantity, unit_cost, total, date, supplier, payment_method, notes, needs_review, source_ref, recorded_by, client_id uq), `attachments`.
- **Cash (optional per Q7):** `cash_counts`(date, counted_amount, counted_by).
- **Platform:** `notifications`(user, type, category, title, body, entity ref, read_at, created_at), `notification_deliveries`(status sent/delivered/opened/failed), `notification_preferences`, `notification_devices`(expo token, platform, last_seen — purged when stale), `audit_logs`(append-only: revoke UPDATE/DELETE from the app role, plus hash-chain column), `system_settings`(key, JSONB, version), `sync_operations`(idempotency ledger: client_id, device, status, result), `import_batches`/`import_issues` (migration lineage: every migrated row keeps sheet/cell reference in `source_ref`).
- **Indexes:** (`production_records`: coop_id, date desc), (`sales`: sale_date, customer_id, payment_status), (`inventory_transactions`: product_id, occurred_at), (`expenses`: date, category_id), (`notifications`: user_id, read_at, created_at desc), (`audit_logs`: entity, entity_id, created_at), (`sessions`: user_id), all FKs.

### ERD (core)
```
farms 1─* coops 1─* production_records 1─* production_entries *─1 product_units *─1 products 1─* prices
products 1─* inventory_transactions   (source → production_records | sale_items | adjustments)
customers 1─* sales 1─* sale_items ; sales 1─* payments *─1 customers
expense_categories 1─* expenses *─0..1 suppliers ; expenses 1─* attachments
users *─* roles (user_roles) *─* permissions (role_permissions)
users 1─* sessions, notification_devices, notifications, audit_logs
```

## 3. Backend (NestJS) modules
`auth, users, roles, permissions, farms, production, inventory, sales, customers, payments, expenses, suppliers, notifications, realtime, synchronization, reports, audit, settings, common(guards, filters, interceptors)`. NestJS is chosen for DI + modular boundaries + built-in guards/pipes suiting this size. Global: Helmet, CORS allow-list, throttler, `ValidationPipe(whitelist, forbidNonWhitelisted)` (mass-assignment defence), exception filter returning generic messages + correlation ID, pino logging with redaction. Every write service method runs in `prisma.$transaction` and emits audit + domain event after commit.

## 4. Authentication & security
Argon2id; 15-min JWT access token, rotating opaque refresh token stored hashed with token-family reuse detection (reuse ⇒ revoke family + security notification); lockout with progressive delay; TOTP MFA (RFC 6238, secrets encrypted at rest with an app key, 10 hashed recovery codes), MFA mandatory for Super Admin/Owner; email verify/reset/invite via single-use hashed tokens; biometric = local app lock over the SecureStore session (no biometric data leaves the device); disabled user ⇒ `token_version` bump + socket disconnect + guard checks status on every request.
Authorization: `@RequirePermissions('sales.create')` guard reading permissions from DB/cache; roles seeded per the brief (Super Admin, Owner/Admin, Farm Manager, Production Staff, Sales Staff, Accountant). Prices, totals and stock checks are always server-side.

## 5. Sales transaction (server)
Guard → DTO validation → idempotency check (`client_id`) → lock inventory balance row (`SELECT … FOR UPDATE`) → load authoritative price → compute with `Prisma.Decimal` → insert sale, items, payment → ledger SALE row + balance decrement → audit row → COMMIT → emit `sale.created`/`inventory.updated` → notification rules. Any error ⇒ rollback.

## 6. Realtime
Socket.IO on the same Nest app; JWT verified in handshake; server joins the socket to rooms derived from *permissions* (`farm:{id}:inventory`, `…:sales`, `user:{id}`) — clients cannot choose arbitrary rooms; payloads are minimal ids/summary and clients refetch via REST (which re-checks permissions). Events per brief (`production.created`, `inventory.updated`, `sale.created`, …). Redis adapter is optional for multi-instance later.

## 7. Notifications
Business event → rule engine (event → audience by permission/role + preferences + account status; security & critical categories non-mutable) → insert `notifications` → fan-out to `notification_devices` via Expo Push Service (compatible with EAS; requires FCM/APNs credentials configured in EAS) → delivery receipts polled → deep link into authenticated screen. Push bodies are generic (no amounts/names). Scheduled jobs (`@nestjs/schedule`): morning-production reminder, daily summary (time from settings), low-stock check.

## 8. Offline sync
Mobile: local SQLite (expo-sqlite, encrypted key in SecureStore) holding an **outbox** of create operations (each with client-generated UUID + idempotency key) and cached read models. States: `pending → syncing → synced | failed | conflict`. `POST /sync/push` accepts a batch, returns a per-operation result (created / duplicate-returned / rejected with reason); server is idempotent via `sync_operations`. Financial documents are immutable (corrections via authorised adjustment records); editable config uses `version` optimistic locking (409 ⇒ user chooses). Sales made offline validate stock on sync; insufficient stock ⇒ operation flagged for manager decision, never silently dropped. `GET /sync/pull?since=` returns deltas. Never delete an outbox item until server ack.

## 9. Mobile screens (Expo Router)
`(auth)`: splash, login, verify-email, forgot/reset, mfa-setup, mfa-verify, biometric-setup. `(tabs)`: Home, Production, Sales, Inventory, More. Stack screens: add-production, production/[id], new-sale, sale/[id], inventory/transactions, customers, customer/[id], expenses, new-expense, expense/[id], payments, reports, notifications, profile, security(sessions/devices), settings. `admin/`: users, user/[id], roles, permissions, coops, products, prices, categories, suppliers, audit-logs, notification-config, security-config, system-settings. Menus render from the permission list returned at login (UX only; the API is the enforcement point).

## 10. API plan (prefix `/v1`)
- Auth: `POST /auth/login|refresh|logout|logout-all|verify-email|forgot-password|reset-password|change-password|change-email`, `PATCH /auth/profile`, `POST /auth/mfa/{enroll,verify,disable,recovery}`, `GET/DELETE /auth/sessions`.
- Admin: `/users`, `/roles`, `/permissions`, `/farms`, `/coops`, `/products`, `/prices`, `/expense-categories`, `/suppliers`, `/settings`, `/audit-logs`.
- Ops: `/production`, `/inventory` (+`/transactions`, `POST /inventory/adjustments`), `/sales`, `/customers`, `/payments`, `/expenses`, `/attachments`.
- Platform: `/notifications` (+read, read-all, preferences, devices), `/dashboard`, `/reports/{production,sales,expenses,inventory,financial}` (+`?format=csv|pdf`), `/sync/{push,pull}`, `/health`.
All list endpoints: server-side pagination + filters (date, coop, user, category, customer, status, product).

## 10b. Excel migration strategy
`migration/excel-import` (TypeScript, reads with `exceljs`, read-only on the source): (1) parse each sheet into staging rows with sheet+cell reference; (2) normalise units/spelling/dates; (3) validate + classify each row as `imported | flagged | rejected | duplicate`; (4) **dry-run by default** producing a report (counts + every issue with cell reference); (5) `--commit` loads in one transaction per batch, idempotent via `source_ref` unique key, so re-runs don't duplicate; (6) writes `migration/reports/*.md|csv`. Rules from Phase 1: Daily Egg Report is authoritative for production; Sheet1 sales imported as walk-in sales @ its price; Sheet2 differences reported not merged; expenses come from Sheet1 category columns (split when parseable) and Expenditure (undated/no-amount ⇒ flagged, balances ⇒ cash counts); Sheet1 cash columns are **not** imported. Opening stock is a reviewed adjustment (Q3), not invented.

## 11. Testing strategy
Jest unit tests (conversion incl. the workbook’s own vectors, e.g. 1 carton+7 crates ⇒ 570 eggs; money Decimal maths; inventory ledger; notification rules); integration tests with Supertest against a disposable Postgres (CI service container; Neon branch for staging) covering auth, RBAC matrix, sales transaction rollback, idempotency; security tests (invalid/expired token, refresh reuse, role escalation, lockout, MFA enforcement, mass assignment); realtime tests with socket.io-client; mobile: Jest + RNTL for outbox/sync state machine and duplicate prevention. **Migration is verified by reconciliation**: imported production total must equal 95,423 eggs (Daily Egg Report) and sales/expense totals must reconcile to the workbook to the flagged differences.

## 12. Roadmap
0. **Now:** review Phase 1/2 and answer the questions (defaults exist for all).
1. Foundation: monorepo, NestJS+Prisma schema+migrations, config, logging, security middleware, CI.
2. Auth/RBAC/MFA/sessions/audit.
3. Excel importer + reconciliation report (early, so real data drives the rest).
4. Production → Inventory ledger → Sales/Customers/Payments → Expenses.
5. Realtime + notifications + daily summary.
6. Reports/exports.
7. Mobile app (auth → offline/outbox → screens), then admin screens.
8. Hardening: security review (OWASP), performance, backup/recovery docs, EAS configs.

## 13. External prerequisites (cannot be done by me from this sandbox)
Neon project + branch DBs and connection strings; a hosting target for the Node backend (e.g. Render/Fly/Railway/VPS with HTTPS); SMTP provider; Expo/EAS account; Google Play developer account and Apple Developer Program membership; FCM/APNs credentials. I will supply configs and runbooks but **cannot verify** store builds, real push delivery, on-device biometrics, or a live Neon connection here — those will be marked unverified until you run them.
