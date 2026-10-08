# System audit and hardening report (October 2026)

Scope: the whole system (Expo app → NestJS API → PostgreSQL/Neon). Method: read the code and schema, ran the existing suites, wrote new tests,
measured. Everything below marked **Verified** was exercised here against a real local PostgreSQL 16; **Not verified** needs your infrastructure.

## 1. Architecture and data flow (as found)
Mobile (TanStack Query cache + encrypted SQLite outbox) → HTTPS `/v1` REST + Socket.IO hints → NestJS (guards: throttle → JWT → permissions, deny-by-default)
→ services (Prisma, transactions) → PostgreSQL (constraints, append-only audit triggers, hash-chained audit log). The server is authoritative: prices,
totals, stock and permissions are computed server-side; the app only sends intent and an idempotency key (`SyncOperation.clientId`).

## 2. Findings by criticality
| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **Critical** | No automated, off-server, encrypted backup; recovery was manual scripts only; nobody was told if a backup failed | **Fixed** — in-app daily backups, encryption, off-site storage support, verification, alerts, Super Admin dashboard, guarded recovery (this change). *Off-site storage and restore on your hosts: not verified until you configure the bucket and recovery server.* |
| 2 | High | API container had no `pg_dump`/`pg_restore`, so any backup feature would fail in production | **Fixed in Dockerfile** (PGDG client 17). *Docker build not run here.* |
| 3 | High | No graceful shutdown (`enableShutdownHooks`) and no HTTP request/headers timeouts: deploys could cut in-flight requests; stalled clients held sockets | **Fixed** (`main.ts`) |
| 4 | Medium | The audit trail had no record of backup/recovery actions | **Fixed** (`backup.*`, `recovery.*` audit actions, hash-chained) |
| 5 | Medium | `SyncOperation` (idempotency) rows never expire | **By design, documented.** Keeping them forever is what makes a very late retry safe. Table grows ~1 row per offline-created record (small). Revisit when it exceeds ~10 M rows. |
| 6 | Medium | Realtime events are published after commit with no outbox: a crash between commit and publish loses the *hint* | **Accepted, documented.** Hints are not data: clients re-fetch on reconnect and every 2 min (poll fallback), the unread-count/notification rows are in the database. A transactional outbox was judged unjustified complexity for hints. |
| 7 | Low | `express` trusts 1 proxy hop | Documented; adjust per host. |
| 8 | Low | `npm audit --omit=dev`: 0 vulnerabilities (backend) | Verified |

### Already sound (checked in code and by existing tests, not changed)
- **Atomic business writes**: sale + stock movement + audit in one transaction; stock changes use a single `UPDATE … WHERE qty >= n` statement; sales/payments lock their rows (`FOR UPDATE`).
- **No lost updates**: production, expenses, customers use a `version` column with compare-and-set; stale edits return `409 Conflict` with the current version.
- **Duplicate protection**: client-generated ids + `SyncOperation` primary key; offline re-sends are no-ops; another user cannot reuse an id. Tested for production, sales, expenses, payments, stock adjustments.
- **Ledger model**: stock = sum of an append-only movement ledger; `InventoryBalance` is a stored cache kept equal to it (reconciliation endpoint + restore-verify check). Money is `Decimal`; corrections are voids/adjustments, not rewrites.
- **Tests that prove it** (existing): 40 concurrent sales for a 5-carton stock never oversell and the ledger stays consistent; two simultaneous sales for the last eggs → exactly one succeeds; concurrent cashiers cannot overpay; single-statement stock never goes below zero under concurrency; offline re-sends idempotent.
- **Security**: Argon2id, rotating refresh tokens, TOTP MFA with replay protection, brute-force throttles, password history, 8-digit single-use 5-minute reset codes, deny-by-default permissions, farm scoping, parameterized queries (Prisma; the few raw queries use tagged templates), body limits, helmet, CORS allow-list, hash-chained append-only audit log, TLS required in production, secrets validated at boot, no secrets in the app bundle.

## 3. What was added in this change
Backend: `src/backup/*` (crypto, storage S3/local, retention, scheduler, service, recovery, controllers), migration `20261010000100_backup_recovery`
(tables `BackupJob`, `RecoveryOperation`, `BackupSetting`; permission `backups.manage` for SUPER_ADMIN only), `scripts/backup-cli.ts` (`npm run backup:cli`),
env validation, graceful shutdown/timeouts, Dockerfile client. Mobile: Administration → *Backups and recovery* (status, history, run now, integrity check,
restore test, guarded restore), detail sheet, full-screen restore flow. Docs: this file, `backup-recovery-dr.md`.

New routes (all `backups.manage`; Owner and every other role get 403 — tested): `GET /v1/backups/status`, `GET /v1/backups`, `GET /v1/backups/:id`, `POST /v1/backups`,
`POST /v1/backups/:id/verify {deep}`, `POST /v1/backups/:id/download {password,code}`, `PATCH /v1/backups/settings`, `GET/POST /v1/recoveries`, `GET /v1/recoveries/:id`.

## 4. Tests (actual results, this environment)
- Backend unit: **all pass** (new: encryption round-trip/tamper/truncation, retention policy, pg helpers, env rules).
- Backend e2e (real PostgreSQL 16, real `pg_dump`/`pg_restore`): **16 suites, 284 tests pass**, including 20 new backup/recovery tests: permissions (Owner 403/anonymous 401 on every route); encrypted file has no readable plaintext; checksum + auth;
  tampered file detected and alerted; deep restore test passes the invariants and leaves no scratch database; scheduler race (4 ticks → 1 job); unique window key (5 racers → 1); claim race (3 executors → 1 run);
  failed `pg_dump` → job FAILED, nothing stored, earlier backups untouched, bounded retries with back-off, alert only after the last attempt; stale "running" job failed; overdue alert; retention keeps newest/verified; download needs password + code;
  recovery refused without phrase / wrong password / unverified backup / for non-Super-Admin; recovery takes a safety snapshot, restores into a NEW database, production row counts unchanged; second concurrent recovery → 409;
  safety-snapshot failure stops everything; production database cannot be restored over or dropped.
- Mobile: tsc, eslint, jest pass; Android and iOS bundles compile.
- **Not run / not verified:** S3 storage against a real bucket (code written to the AWS SDK; local storage is what was exercised); Docker build; the mobile screens on a device; multi-process (true multi-instance) scheduling — simulated by concurrent calls into the same database guard, which is what enforces it; PITR; pg_dump against Neon (client version must be ≥ server).

## 5. Load baseline (local, one Node process, PostgreSQL on the same machine, autocannon, 10 s per run)
This measures the code on a laptop-class sandbox with a ~0–1 ms database. It says nothing about Neon latency (~0.7–1 s per query round trip from afar — see `monitoring-and-incident-response.md`) or about your hosting size. No capacity claim should be derived from it.

| Endpoint | Connections | Req/s | p50 | p97.5 | p99 | Errors |
|---|---|---|---|---|---|---|
| `/health/live` | 50 | 2 860 | 15 ms | 33 ms | 39 ms | 0 |
| `GET /v1/dashboard` | 10 | 986 | 9 ms | 15 ms | 17 ms | 0 |
| `GET /v1/dashboard` | 50 | 1 019 | 47 ms | 73 ms | 82 ms | 0 |
| `GET /v1/dashboard` | 200 | 1 016 | 194 ms | 284 ms | 303 ms | 0 |
| `GET /v1/sales?limit=25` | 50 | 568 | 85 ms | 127 ms | 137 ms | 0 |
| `GET /v1/production?limit=25` | 100 | 570 | 172 ms | 219 ms | 232 ms | 0 |
Throughput plateaus (single Node process, CPU-bound) and latency grows linearly with connections: no errors, no timeouts, and `/health/ready` was healthy right after. Write-path concurrency is covered by the e2e tests above, not by this table. Not measured: lock contention, DB connection utilisation, memory, sustained (>10 s) load, multi-instance behaviour.

## 6. Production deployment checklist
1. Take a manual backup first (`pg_dump` with `scripts/backup.sh`, or Neon branch). Note the rollback plan: redeploy previous image; the migration is additive (3 new tables, 4 enums, 1 permission row) and is not required by the old code.
2. Generate `BACKUP_ENCRYPTION_KEY`; store it in a vault **and** the host's secrets. Set `BACKUP_STORAGE=s3` + bucket variables, `RECOVERY_ADMIN_DATABASE_URL`, optional `BACKUP_ALERT_EMAILS`.
3. Build the new image (it now contains `postgresql-client-17`); confirm `pg_dump --version` ≥ your Neon server's major version inside the container.
4. `prisma migrate deploy` (tools image), then deploy the API. Existing SUPER_ADMIN users get `backups.manage` from the migration; sign out/in to refresh permissions.
5. In the app: Backups → *Back up now* → wait for *Successful* → open it → *Test restore (isolated)* → must pass. Only then treat backups as operational.
6. Check Backups shows *Stored at: s3://…* ("Off this server"), no warnings, next run at the scheduled time; confirm the next morning that a `Daily` backup exists.
7. Add an external monitor on `/health/ready` and keep e-mail alerts enabled; quarterly, repeat the restore test and the runbook in `backup-recovery-dr.md`.

## 7. Remaining risks and recommendations
- Until step 2/5 above are done, there is **no operational off-site backup** — the feature is built and tested, not yet configured against your accounts.
- Logical daily backups ⇒ up to ~24 h data loss. For minutes, use Neon PITR (not implemented here) and consider running the backup more often (change the schedule or add a second window).
- The mobile "download" route exists on the API (rate-limited, password + code, audited) but has no button; use the bucket or the CLI.
- Scale-out next steps: pooled DB URL (PgBouncer/Neon pooler) for the API with direct URL only for migrations/backups; API in the same region as the database; split backup scheduling to an external worker if you run many replicas; a real metrics stack (Prometheus/Grafana or the host's APM) fed from the structured logs — only logs and `/health/ready` exist today.
- Dependencies: backend has 0 known production vulnerabilities; `expo-doctor` could not be completed offline (config-schema check needs Expo's servers).
