# Backend foundation — setup & operations (Phase 3)

## Local development
```bash
cd backend
cp .env.example .env            # fill in real values locally; never commit .env
npm ci
npx prisma migrate deploy       # applies migrations (init + constraints)
npm run db:seed                 # idempotent reference data (permissions, roles, shifts, units, categories, settings)
npm run start:dev
```
Health: `GET /health/live` (process) and `GET /health/ready` (database round-trip). All other routes are under `/v1`.

## Neon setup (you must do this; it cannot be done from the build sandbox)
1. Create a Neon project; create **separate branches/databases** for development, staging and production.
2. For each, copy two connection strings into that environment's secrets:
   - `DIRECT_DATABASE_URL` — direct (non-pooled) host, used **only** by `prisma migrate deploy`.
   - `DATABASE_URL` — pooled host (`-pooler`), used by the running server.
   Both must carry `sslmode=require`; the server refuses to start in staging/production without it.
3. Run `prisma migrate deploy` with the migration role, then `backend/prisma/sql/app_role.sql` to create the
   least-privilege `makarifor_app` role, and put **that** role in `DATABASE_URL`. The runtime role cannot
   alter schema, and cannot UPDATE/DELETE the audit log, inventory ledger or price history.
4. Generate secrets: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` (JWT ×2, must differ),
   and `... randomBytes(32).toString('base64')` for `DATA_ENCRYPTION_KEY`. Store in the host's secret manager.

## What is enforced at start-up
Config is validated with zod (`src/config/env.ts`). The server exits before listening if a secret is short, JWT secrets are
identical, the encryption key is not 32 bytes, or (staging/production) a placeholder value/wildcard CORS/non-TLS database URL is used.
Error messages name variables, never values.

## Security middleware in place
Helmet (CSP `default-src 'none'`, HSTS, no-referrer, frame denial), `Cache-Control: no-store`, no `X-Powered-By`, CORS allow-list
(empty by default), 256 kB body limit, global rate limit (120/min/client — auth routes get stricter limits in Phase 4),
validation pipe with `whitelist` + `forbidNonWhitelisted` (mass-assignment protection), correlation IDs (`X-Request-Id`),
pino logging with credential/token redaction and no bodies or query strings, a single exception filter returning
"Unable to complete this operation. Please check your connection and try again." for unexpected errors and mapping DB
constraint errors to safe 4xx responses without schema details.

## Database rules enforced by PostgreSQL itself
See `prisma/migrations/*_constraints`: non-negative quantities/money, sale arithmetic (`total = subtotal − discount`, paid ≤ total),
inventory ledger sign-by-type, one ACTIVE production record per coop/date/shift, one open price per unit,
case-insensitive unique e-mail, append-only `AuditLog` and `InventoryTransaction` (triggers block UPDATE/DELETE/TRUNCATE).

## Tests
`npm test` (unit), `npm run test:e2e` (real PostgreSQL; the global setup drops and rebuilds a database whose name ends in `_test` — it refuses any other name).
CI: `.github/workflows/backend-ci.yml` (typecheck, lint, unit, e2e against Postgres 16, `npm audit`, build).

## Not yet done in this phase (by design)
Authentication, RBAC guards, audit-writing service, MFA (Phase 4); importer (Phase 5); business modules (Phase 6);
Socket.IO (Phase 7). Prisma 6 is used; the `package.json#prisma` deprecation warning does not apply (no config there) but a move to
`prisma.config.ts` is needed before Prisma 7.
