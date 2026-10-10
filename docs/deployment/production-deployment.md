# Production deployment (Phase 13)

Status of what is verified: the build and start steps (`npm ci` → `npm run build` → `node dist/main.js` → health checks) were run in a sandbox, but **nothing has been deployed to Neon or any host**. Treat the first staging deploy as the real test. The project does not use Docker.

## Topology
```
Phone (Expo app) ──HTTPS/WSS──▶ API process (NestJS, single instance) ──TLS──▶ Neon PostgreSQL (pooled URL for the app, direct URL for migrations)
                                        └──▶ Expo Push service · Brevo (e-mail)
```
The phone never connects to the database. Terminate TLS at the host's proxy; the API trusts exactly one proxy hop (`trust proxy 1`, change in `app.setup.ts` if your host differs).
**Run one API instance**: realtime events are in-process (see `docs/architecture/03-realtime.md`). Scaling out needs the Socket.IO Redis adapter and Redis-published domain events first.

## 1. Neon (do this in the Neon console)
1. Create a project in the region closest to the farm; create separate **staging** and **production** projects (or branches with separate credentials).
2. Create two roles: an owner/migration role (used only by `prisma migrate` from CI or an operator) and the runtime role `makarifor_app`.
3. Copy two connection strings: **pooled** (`-pooler` host) → `DATABASE_URL` for the API; **direct** → `DIRECT_DATABASE_URL` for migrations/backups. Both must contain `sslmode=require`; the API refuses to start otherwise in staging/production.
4. After the first `prisma migrate deploy`, run `prisma/sql/app_role.sql` with the direct URL to grant the runtime role least privilege (append-only tables have UPDATE/DELETE/TRUNCATE revoked). **Re-run it after every migration that adds tables.**
5. Enable point-in-time restore retention appropriate to your plan (see `docs/operations/backup-recovery-dr.md`).

## 2. Environment variables (host secret store; never in git)
| Variable | Required | Notes |
|---|---|---|
| `APP_ENV` | yes | `staging` or `production` (turns on TLS-required DB, mandatory Brevo key and sender, forbids `THROTTLE_OFF`) |
| `PORT` | no | default 3000 |
| `DATABASE_URL` / `DIRECT_DATABASE_URL` | yes | see above, `sslmode=require` |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | yes | ≥32 chars, different from each other and per environment: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `DATA_ENCRYPTION_KEY` | yes | base64 of 32 random bytes (encrypts MFA seeds). **Losing it locks every MFA user out; back it up separately from the database.** Rotation is not implemented |
| `BREVO_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_NAME` | yes in production | all e-mail goes through Brevo's transactional API: invitations (with the temporary password), password reset, security notices, daily summary. `EMAIL_FROM` must be a verified sender in Brevo |
| `CORS_ORIGINS` | no | empty is correct for the native app; only list web origins you actually serve |
| `PUSH_PROVIDER`, `PUSH_NOTIFICATION_CONFIG` | no | `expo` by default in staging/production; token only if Expo enhanced push security is on |
| `APP_LINK_BASE` | no | deep-link scheme for e-mail links (`makarifor://`) |
| `LOG_LEVEL` | no | `info`; logs are JSON with secrets redacted |

## 3. First deploy
```bash
# operator machine or CI (has DIRECT_DATABASE_URL); a checkout with `npm ci` in backend/
npx prisma migrate deploy                       # schema + constraints + triggers
npm run db:seed                                 # roles, permissions, shifts, units, categories (idempotent)
psql "$DIRECT_DATABASE_URL" -v app_password="'<generated>'" -f prisma/sql/app_role.sql
npm run bootstrap:admin -- --email owner@… --name "Full Name"   # first Super Admin gets an invitation e-mail with a temporary password (add --print-password to also print it)
```
Then run the API on your host with the variables above:
```bash
cd backend && npm ci && npm run build        # build (prisma generate + nest build)
npm run start                                # node dist/main.js  (needs Node 22)
```
Health checks: `GET /health/live`, `GET /health/ready`. **Install the PostgreSQL client tools (version ≥ your database's, e.g. `postgresql-client-17`) on the same host**, because the in-app backups run `pg_dump`; if your host does not let you install packages (many managed Node hosts do not), use a small VM, or run `npm run backup:cli -- tick` from a machine that has them.

Excel history is imported **once**, after review: `docs/deployment/excel-migration.md` (dry run first; the importer writes a reconciliation report; the workbook is never modified).

## 4. Releases and rollback
- `git tag vX.Y.Z` → `release-backend` runs a **manual-approval `migrate` job** that takes a logical backup and runs `prisma migrate deploy`. Add your host's deploy step there (or deploy by pulling the tag on the server, `npm ci && npm run build`, restart).
- Migrations are forward-only and additive by convention. Rollback = redeploy the previous tag (schema is backward compatible for one release) or restore the pre-migration backup (`docs/operations/backup-recovery-dr.md`). Never edit an applied migration.
- CI blocks schema drift (`prisma migrate diff`), so what is tested is what is deployed.

## 5. Host choices (not decided here)
Any host with a persistent Node process, WebSocket support, static egress not required, and TLS termination works (Render, Fly.io, Railway, a small VM with Caddy). Serverless/function platforms are **not** suitable (long-lived WebSockets, in-process scheduler). The notification scheduler is idempotent, so a brief overlap during a rolling deploy does not duplicate messages.

## 6. Local development
the native flow in `backend-foundation.md` (PostgreSQL 16 installed locally, `npm ci`, `npx prisma migrate deploy`, `npm run db:seed`, `npm run start:dev`).
