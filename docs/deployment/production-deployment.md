# Production deployment (Phase 13)

Status of what is verified: the API image steps were simulated (build → prune dev dependencies → start `dist/main.js` → health checks) but **`docker build` itself was not run**
(no Docker daemon in the build sandbox), and **nothing has been deployed to Neon or any host**. Treat the first staging deploy as the real test.

## Topology
```
Phone (Expo app) ──HTTPS/WSS──▶ API container (NestJS, single instance) ──TLS──▶ Neon PostgreSQL (pooled URL for the app, direct URL for migrations)
                                        └──▶ Expo Push service · SMTP provider
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
| `APP_ENV` | yes | `staging` or `production` (turns on TLS-required DB, mandatory SMTP host, forbids `THROTTLE_OFF`) |
| `PORT` | no | default 3000 |
| `DATABASE_URL` / `DIRECT_DATABASE_URL` | yes | see above, `sslmode=require` |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | yes | ≥32 chars, different from each other and per environment: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `DATA_ENCRYPTION_KEY` | yes | base64 of 32 random bytes (encrypts MFA seeds). **Losing it locks every MFA user out; back it up separately from the database.** Rotation is not implemented |
| `EMAIL_HOST/PORT/USER/PASSWORD/FROM` | yes in production | invitations, password reset, alerts |
| `CORS_ORIGINS` | no | empty is correct for the native app; only list web origins you actually serve |
| `PUSH_PROVIDER`, `PUSH_NOTIFICATION_CONFIG` | no | `expo` by default in staging/production; token only if Expo enhanced push security is on |
| `APP_LINK_BASE` | no | deep-link scheme for e-mail links (`makarifor://`) |
| `LOG_LEVEL` | no | `info`; logs are JSON with secrets redacted |

## 3. First deploy
```bash
# operator machine or CI (has DIRECT_DATABASE_URL); uses the "tools" image target or a checkout with npm ci
npx prisma migrate deploy                       # schema + constraints + triggers
npm run db:seed                                 # roles, permissions, shifts, units, categories (idempotent)
psql "$DIRECT_DATABASE_URL" -v app_password="'<generated>'" -f prisma/sql/app_role.sql
npm run bootstrap:admin -- --email owner@… --name "Full Name"   # first Super Admin gets an invitation e-mail; nobody types a password here
```
Then deploy the `runtime` image (`ghcr.io/<org>/<repo>/api:<tag>`, built by the `release-backend` workflow) with the variables above; health checks: `GET /health/live`, `GET /health/ready`.

Excel history is imported **once**, after review: `docs/deployment/excel-migration.md` (dry run first; the importer writes a reconciliation report; the workbook is never modified).

## 4. Releases and rollback
- `git tag vX.Y.Z` → `release-backend` builds and pushes the image, then a **manual-approval `migrate` job** takes a logical backup and runs `prisma migrate deploy`. Add your host's deploy step there.
- Migrations are forward-only and additive by convention. Rollback = redeploy the previous image (schema is backward compatible for one release) or restore the pre-migration backup (`docs/operations/backup-recovery-dr.md`). Never edit an applied migration.
- CI blocks schema drift (`prisma migrate diff`), so what is tested is what is deployed.

## 5. Host choices (not decided here)
Any container host with a persistent process, WebSocket support, static egress not required, and TLS termination works (Render, Fly.io, Railway, a small VM with Caddy). Serverless/function platforms are **not** suitable (long-lived WebSockets, in-process scheduler). The notification scheduler is idempotent, so a brief overlap during a rolling deploy does not duplicate messages.

## 6. Local development
`docker compose up --build` then `docker compose run --rm migrate` (compose file and Dockerfile are unverified in this sandbox, see above), or the native flow in `backend-foundation.md`.
