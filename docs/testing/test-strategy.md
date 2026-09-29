# Testing (Phase 12)

## What runs where
| Layer | Command | Count | Environment |
|---|---|---|---|
| Backend unit | `cd backend && npm test` | 86 | Node, no database |
| Backend end-to-end | `cd backend && npm run test:e2e` | 245 in 13 suites | real PostgreSQL 16, real HTTP, real WebSockets, isolated schema per suite |
| Mobile logic + components | `cd mobile && NODE_OPTIONS="--experimental-sqlite --no-warnings" npx jest` | 83 | jest-expo (Node + react-test-renderer) |
| Mobile ↔ live backend | `backend/test/mobile-client.e2e.spec.ts` | 5 | the real mobile session/token/endpoint/realtime code against the real server |
| Static | `tsc --noEmit`, `eslint` (backend + mobile), `prisma migrate diff` drift check, `npm audit`, Android + iOS bundle | | CI |

CI: `.github/workflows/backend-ci.yml` (typecheck, drift, lint, unit, e2e against a Postgres service, audit, build) and `mobile-ci.yml` (typecheck, lint, Jest, audit, Android/iOS bundle).

## Coverage (measured, backend `src/`, unit + e2e together)
Statements 93.7 % · Branches 78.8 % · Functions 93.6 % · Lines 96.4 %. Unit tests alone: 87.7 % lines. Mobile coverage is not measured; its risk sits in
screens, which are only compiled/bundled and partly component-tested (see gaps).

## Test areas (all required categories)
- **Unit**: pricing/decimal maths, TOTP, password policy, CSV/PDF builders, bucketing, formatting, offline validators, stock estimate, app-lock policy, periods.
- **Integration / API contract**: every module has an e2e suite (auth, operations, sync, realtime, notifications, reports, audit, import, database constraints); the mobile client suite proves each typed endpoint path exists and is permission-checked.
- **Security** (`security.e2e.spec.ts`, plus auth/permission suites): deny-by-default (the running route table is walked and every non-public route must answer 401 unauthenticated), 403 for low-privilege users, forged/none-alg/wrong-secret/expired/wrong-type/tampered JWTs, refresh-token reuse → family revocation, IDOR on sessions, SQL/JS metacharacters in search and filters, hostile text stored verbatim, oversize/malformed bodies without internals leaking, prototype-pollution bodies, security headers/CORS, login throttling and no user enumeration, no secrets in user payloads. Earlier suites cover Argon2id, MFA replay, audit-chain tamper detection, mass assignment, and secrets redaction.
- **Offline / sync**: crash recovery, idempotent replays, ordering, dependency blocking, conflicts, backoff, single-flight refresh, per-user outbox ownership (`engine.spec`, `sync.e2e`, `session-manager.spec`).
- **Realtime**: 26 real-WebSocket tests (auth, topics, revocation, expiry, rate limits) + client tests + one live client↔server test.
- **Performance / concurrency** (`performance.e2e.spec.ts`, 30,000 sales, 10,800 production rows, 5,000 expenses): dashboard ≈0.1–0.2 s, paged lists <0.1 s, year reports 0.3–3.3 s, 30k-row CSV export ≈3.7 s; 40 concurrent sales on a 5-carton stock produce exactly 5 sales, no 500s and a consistent ledger; 10 concurrent idempotent replays create one record. Budgets are generous (CI); this is a regression net, not capacity planning.
- **Mutation checks**: safeguards were each disabled to prove tests fail (auth, sync, notifications, reports). Not automated (no mutation-testing tool in CI).

## Honest gaps
- No device/emulator tests (Detox/Maestro), no screenshot or accessibility tests; screens are compile-checked, bundled and partially component-tested.
- Push delivery, SMTP, Neon and EAS builds are untested against real services.
- Performance was measured on one shared machine with local PostgreSQL, not Neon over the network; the sales report loads rows into memory (≈3 s for a year of 30k sales) — a SQL aggregation path is the next optimisation if a farm outgrows this.
- No formal penetration test or third-party security review has been done; the suite is regression protection, not a certification.
