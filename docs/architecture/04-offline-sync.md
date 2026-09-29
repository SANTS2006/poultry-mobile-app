# Offline-first and synchronisation (Phase 8)

Server: `backend/src/sync/` (`POST /v1/sync/push`, `GET /v1/sync/reference`). Device logic (pure TypeScript, storage- and network-agnostic):
`mobile/src/sync/` (engine, outbox storage incl. SQLite, validators, reference cache, HTTP transport) and `mobile/src/services/`
(secure-store token manager, API client). Verified by 30 device-side tests (real SQLite through `node:sqlite`) and 22 end-to-end tests where the
**real engine talks to the real server over HTTP** (`backend/test/sync.e2e.spec.ts`). Every safeguard listed below was also mutation-checked
(breaking it made a test fail).

## The flow
```
enqueue ─▶ validate (fast, client side) ─▶ store durably in SQLite (status pending) ─▶ if online: sync
 sync ─▶ recover items left "syncing" by a crash ─▶ pick due items in creation order (dependencies first) ─▶ POST /sync/push (≤ 25)
       ◀─ one result per operation:  accepted | duplicate → synced      conflict → held for a decision
                                     rejected → held, visible            error(retryable) / network / 5xx → stays pending, back-off
```
Status shown to users: `pending → syncing → synced`, or `conflict`, `rejected`, `blocked`. `summary()` gives counts, `lastSyncedAt`, online flag
and whether a sync is running, for the offline / sync indicators (Phase 11).

## Guarantees
| Requirement | How it is met |
|---|---|
| Never silently lose a record | The outbox is durable (SQLite) and an item leaves it only when the server accepted it (kept 7 days for history) or the user explicitly discards a conflicted/rejected one (logged locally with the full payload). Malformed-request 4xx, missing results, timeouts, 5xx and auth failures all leave the item in the outbox. |
| No duplicates | Every operation has a client-generated UUID that is also the record's `clientId`. The server applies each id at most once (unique constraint + a `SyncOperation` ledger) and answers `duplicate` on a re-send. A **lost response** (server saved, device never heard) is therefore safe: tested end-to-end — one sale, stock deducted once. Another user re-using an id is refused. |
| Order and dependencies | Operations are sent in creation order. A sale may reference a customer created offline by `customerClientId`, a payment a sale by `saleClientId`; the device holds dependents back until the dependency synced and marks them `blocked` (not dropped) if it fails; the server resolves the ids and rejects unknown ones. |
| Server is the authority | Offline records carry only *what happened*. The server re-validates, **prices sales at the sale date** with the price in force (a price change between "sold offline" and "synced" is handled by the server), computes totals, checks stock, audits, and publishes events — through the same services as the online API. Clients that send `total`, `unitPrice`, `createdById`… are rejected. |
| Per-operation authorisation | Each operation is checked against the user's permissions; a forbidden or invalid one never blocks the others in the batch. |
| Explicit conflict handling | `INSUFFICIENT_STOCK` (with available/requested eggs), `ALREADY_RECORDED` (another device recorded the same coop/date/shift) and other conflicts are **held** — never retried automatically, never overwritten. The user chooses `retry` (e.g. after the missing production or stock is recorded — tested) or `discard`; rejected records can be corrected and resent under the same id. |
| Transient failures | Exponential back-off with jitter (capped at 15 min); offline retries are free (no penalty), auto-sync on reconnect and on a timer; one sync at a time. |
| Auth handling | On 401 the client refreshes once (single-flight) and retries; if the session is really gone the engine stops, keeps everything as `pending`, raises `auth_required`, and resumes after sign-in (tested with a disabled account). A network failure during refresh never signs the user out. |
| Refresh-token safety | Token refresh is **single-flight**: N parallel requests → exactly one refresh call. (The server treats a reused refresh token as theft, so parallel refreshes would log the user out. Tested against the real server: no `reuse_detected` audit entries.) Tokens live in the platform secure store, never in URLs or AsyncStorage. |
| Reference data offline | `GET /sync/reference` returns coops, shifts, units, current prices, customers (incremental with tombstones), stock and categories, **filtered by role** (production staff get no prices/customers; customer credit/balances are never included). The cache survives offline; prices there are for display/estimates only. |
| Local estimate | `estimateStockEggs` = last known stock + unsent production − unsent sales, to warn before an offline sale that probably will not fit. Advisory only. |

## What can and cannot be done offline
Offline (queued): record production, sales (walk-in or registered customer), expenses, new customers, payments.
**Online only, by design:** corrections and voids, price changes, stock adjustments, user/admin actions, approvals, reports/exports — anything where a
stale device could overwrite newer facts. Edits use version checks online (a stale write is refused and the user told), never silent overwrite.

## Server API
`POST /v1/sync/push` `{ deviceId?, operations: [{ clientId, type, payload }] }` (1–50, types `production.create | sale.create | expense.create |
customer.create | payment.create`) → `200 { serverTime, results: [{ clientId, status, entityType, entityId?, code?, message?, retryable, detail? }] }`.
Status `error` (`retryable: true`) means "the server could not process this yet" and is **not** recorded as an outcome; internals are never leaked.
Codes: `FORBIDDEN, VALIDATION, BUSINESS_RULE, REJECTED, CLIENT_ID_IN_USE, DEPENDENCY_MISSING, INSUFFICIENT_STOCK, ALREADY_RECORDED, CONFLICT, SERVER_ERROR`.
`GET /v1/sync/reference[?since=<cursor>]` → reference data + `cursor` for the next incremental call.

## Device integration notes (wired up in Phase 11)
- Storage: `SqliteOutboxStorage` over an `expo-sqlite` adapter (`run`/`all`). Enable SQLCipher (`expo-sqlite` config plugin) with a random key kept in
  `expo-secure-store`, so the outbox is encrypted at rest. Minimal sensitive data is stored: no passwords; tokens only in the secure store.
- Network: implement `NetworkMonitor` with `@react-native-community/netinfo`; call `engine.startAutoSync()` on app start and `resumeAfterLogin()` after sign-in.
- The engine is also the single writer of the outbox: screens call `enqueue()` and read `list()` / `subscribe()`.

## Limitations (honest list)
- Verified with the real engine + real server + real SQLite, but **not yet on a phone**: the Expo adapters (expo-sqlite, NetInfo, secure-store) are thin and untested until Phase 11.
- The sync ledger is kept indefinitely (small rows); a retention job is not built.
- Two phones editing the *same existing record* offline is not offered (edits are online-only); conflicts arise only for new records and stock.
- Offline validation uses the cached business date/limits; a phone with a wrong clock can be refused by the server's date rules (then shown as rejected with the reason).
- Conflicted offline sales mean goods may already have left the farm: the UI must make the decision (record the missing stock and retry, or discard) unmissable — designed in Phase 11.
