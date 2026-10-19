# Backup, recovery and disaster recovery

> **New (automated, in-app):** daily encrypted backups, restore tests and a guarded recovery workflow managed by the Super Admin
> (Administration → Backups and recovery). **No PostgreSQL client tools (`pg_dump` / `pg_restore`) are needed anywhere**: the API reads the database
> itself (one consistent snapshot, `COPY` per table) and restores by replaying `prisma/migrations` and loading the data. Backups go only to Cloudflare R2.
> The older `backup.sh` / `restore-verify.sh` scripts were removed; use `npm run backup:cli` instead. See [Automated backups](#automated-backups-in-app) first.

Two independent layers, because one is never enough:

| Layer | What | Protects against | Verified here? |
|---|---|---|---|
| Neon point-in-time restore / branching | provider-side history within your plan's retention window | bad deploy, accidental delete, corruption noticed quickly | **No** (needs a Neon project) |
| Logical dumps (in-app, `npm run backup:cli`) | built-in dump (gzip + AES-256-GCM + SHA-256) kept in **Cloudflare R2**, outside Neon | provider outage or account loss, retention gaps, long-term archive | **Yes** — dumped and restored a real database |

## Targets (proposal — confirm with the owner)
RPO ≤ 24 h from logical dumps (schedule daily; PITR gives minutes within its window). RTO ≈ 2–4 h to a new database + redeploy. Tighten by running the dump more often.

## Daily backup
The API takes it by itself every day (Administration → Backups) and stores it in Cloudflare R2. To take one from a shell: `npm run backup:cli -- run`. Consider copying the R2 object to a second account/provider too.
Dumps contain customer and financial data: encrypt at rest, restrict access, never send by e-mail or chat, and delete per your retention policy.
Also back up, separately and securely: `DATA_ENCRYPTION_KEY`, `JWT_*` secrets (a leaked/lost JWT secret only forces re-login; a lost encryption key strands MFA seeds), and the EAS credentials.

## Restore drill (do this quarterly and before go-live)
In the app: Backups → a backup → *Test restore*, or from a shell: `npm run backup:cli -- verify <jobId> --deep`.
It checks the checksum, restores into a throw-away database, and asserts: users exist · **stock balance = sum of the ledger** · no negative stock · sale totals = item lines − discount · audit append-only triggers exist · audit hash-chain linkage has no gaps. Exit code 0 means the backup is usable.
Verified behaviour: passes on a clean database; fails (exit 1) on a corrupted dump; flags rows inserted around the safeguards (it flagged deliberately raw-inserted test rows).
After a real restore also call `GET /v1/audit/verify` (Owner/Super Admin) to re-verify the full cryptographic audit chain, and `GET /v1/inventory/reconciliation`.

## Recovery playbooks
1. **Bad data change / bad deploy (minutes–hours ago)**: use Neon PITR to create a branch at the time before the incident, compare, then either promote the branch (update `DATABASE_URL`) or copy the affected rows. Prefer restoring into a *new* branch first; never restore over production blindly.
2. **Database lost or provider outage**: create a Postgres 16 database anywhere (a new Neon project or another host), `pg_restore --no-owner --no-privileges --dbname=$NEW_DIRECT_URL <dump>`, run `prisma migrate deploy` (no-op if current), re-run `prisma/sql/app_role.sql`, point `DATABASE_URL`/`DIRECT_DATABASE_URL` at it, redeploy, run the checks above. Phones keep their unsent records; they sync when the API is back.
3. **API host lost**: redeploy the last release tag (`npm ci && npm run build && npm run start`) with the saved environment variables. No state lives in the API process except realtime connections (clients reconnect) and the notification scheduler (idempotent).
4. **Secret compromise**: rotate `JWT_SECRET`/`JWT_REFRESH_SECRET` (all users must sign in again — acceptable), database passwords, Brevo API key, Expo token. `DATA_ENCRYPTION_KEY` rotation is not implemented: if leaked, reset MFA for all users after introducing a new key (requires a code change — see security review).
5. **Lost phone**: an administrator disables the user or revokes their sessions (Admin → Users); the device's tokens stop working immediately and its sockets are dropped. The offline database on the phone is encrypted (SQLCipher, key in Keychain/Keystore) but unsent records on a lost phone are lost to the business — another reason to sync often.

## Data retention
Notifications 365 days, delivery rows and stale devices 90 days (automatic). Audit log, ledger and prices are append-only and never purged. Define legal retention for financial records with your accountant; nothing here deletes them.


## Automated backups (in-app)
**What runs.** `BackupScheduler` ticks every minute inside the API. At the configured local time (default 02:00 in `business.timezone`) it creates the
day's job under a *database-unique* key, so any number of API instances produce exactly one backup per day; a job is claimed with a compare-and-set,
so only one instance runs it (tested: 4 concurrent ticks → 1 job; 5 racing creators → 1 job; 3 racing executors → 1 run). If the server was down at the
scheduled time the next tick after start-up catches up. A job stuck "running" for 3 h (process died) is failed and retried. Failures retry after 5 and 15
minutes (3 attempts), then alert. For stricter isolation set `BACKUP_ENABLED=0` on the API and run `npm run backup:cli -- tick` every minute from an
external scheduler (or `-- run` once a day) — it uses the same code and the same database guard.

**How a backup is made.** The database is read in one read-only REPEATABLE READ transaction (a consistent snapshot) and every table is streamed with `COPY … TO STDOUT`, then gzip, then AES-256-GCM (key `BACKUP_ENCRYPTION_KEY`, job id bound as authenticated data) into a
temp file, SHA-256 of the *stored bytes* is recorded, the file is uploaded to Cloudflare R2, then **read back, checksummed,
decrypted, authenticated and fully read (every table's row count must match)**. Success is decided by those checks, never by "a file exists".
A failed run never overwrites or deletes an earlier backup (each backup is a new object).

**Verification levels.** *File check* (automatic after every backup) and *Test restore* (Super Admin button / `verify --deep`): restores into a scratch
database on `RECOVERY_ADMIN_DATABASE_URL`, runs the business invariants (stock = ledger sum, no negative stock, sale totals, audit append-only triggers,
audit hash-chain linkage), then drops the scratch database. A deep result is not downgraded by a later file check.

**Retention** (Super Admin can change: 7–365 days, 0–36 monthly): keep everything younger than `retentionDays`; always keep the newest successful backup,
the newest verified backup, and the newest backup of each of the last `keepMonthly` months; safety snapshots (taken before a restore) are kept 30 days.
Only successful backups are ever deleted; deletion is audited. Defaults: 14 days + 6 monthly. Storage estimate: (compressed dump size) × ~20 copies.

**Alerts** (e-mail through Brevo to `BACKUP_ALERT_EMAILS`, else all active Super Admins): final failure after retries, failed verification, overdue
(no good backup within `BACKUP_STALE_HOURS`, at most every 6 h), failed recovery. The Backups screen shows latest success, latest failure, age, next run,
destination, warnings, history, and recoveries.

### Recovery (Super Admin only)
Requires: backup is successful **and verified**; password **and** a fresh authenticator code; typing `RESTORE <first 8 chars of the backup id>`;
`RECOVERY_ADMIN_DATABASE_URL` configured; no other recovery running (advisory lock). The API then (1) takes a fresh **safety snapshot** of the current
database — if that fails, nothing else happens; (2) fetches, checksums and decrypts the backup; (3) restores it into a **new** database
`recovery_<time>_<id>` on the recovery server (it refuses the production database name and never drops anything it did not create);
(4) runs the invariants and compares the migrations the running code expects against the backup; (5) reports. **The API never overwrites the live
database.** Going live with the restored data is a separate operator step (below). This is a deliberate design choice: a phone cannot be allowed to
destroy production, and the operator gets to inspect the result first.
It is a *logical daily backup*, **not point-in-time recovery**: worst-case data loss is up to ~24 h (up to the interval since the last backup). PITR is
provided only by the host (Neon) — see Layer 1 above — and is not implemented or tested here.

### Runbook: restore service from a backup
1. Decide the recovery point. In the app: Backups → pick a *Successful* (verified) backup. (If the app is down: `npm run backup:cli -- list`.)
2. **Preferred (app up):** Backups → backup → *Restore this backup…* → follow the prompts. Wait for "Restored and checked". Note the database name.
   **App down / manual:**
   ```bash
   cd backend
   # file from the bucket (or Backups → download); the job id is in the file name
   BACKUP_ENCRYPTION_KEY=… npm run backup:cli -- decrypt makarifor-<time>-<jobId>.dump.enc <jobId> restore.dump
   # an EMPTY database (create it in the Neon console or with any SQL client), never the production one:
   npm run backup:cli -- restore restore.dump <empty database url>   # builds the schema from prisma/migrations, loads the data, re-checks every foreign key
   ```
3. **Promote** (this is the step that makes old data live; announce downtime first):
   - Put the API in maintenance (scale to 0, or deploy with `DATABASE_URL` pointing at the recovery database after step 4).
   - Run `prisma migrate deploy` against the recovery database if the report listed missing migrations; re-run `prisma/sql/app_role.sql` (least-privilege app role).
   - Change `DATABASE_URL` / `DIRECT_DATABASE_URL` in the host to the recovery database; redeploy; check `/health/ready`, sign in, open Admin → Audit log → *verify chain*, Stock → reconciliation.
   - Keep the previous database untouched for at least 7 days (rollback = point the URLs back).
4. Phones keep unsent records and sync when the API is back; records made between the backup time and the incident are **lost** unless they are still queued on a phone — tell staff to re-enter anything missing.
5. Rotate nothing unless a secret was exposed; if `BACKUP_ENCRYPTION_KEY` is lost, existing backups are unreadable — keep it in a vault, separate from the bucket.

## What you must provide (the code is ready; it has not been run against your Cloudflare account)
- **Cloudflare R2 bucket** (private), an R2 API token with *Object Read & Write* scoped to that bucket, and your account id → `BACKUP_R2_ACCOUNT_ID`, `BACKUP_R2_BUCKET`, `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY` (EU/FedRAMP jurisdiction buckets also set `BACKUP_R2_ENDPOINT`). Add an R2 object-lifecycle/bucket-lock rule if you want extra protection against deletion.
- `RECOVERY_ADMIN_DATABASE_URL`: a Postgres 16/17 server/branch where `CREATEDB` is allowed. On Neon: a separate project — **do not** point it at production.
- Nothing to install on the API host: no `pg_dump` / `pg_restore`. The API only needs the `prisma/migrations` folder next to it (it is part of the project; set `MIGRATIONS_DIR` if you moved it).
- `BACKUP_ENCRYPTION_KEY` in your secret store, and a copy outside the host.
Until R2 is configured, backups stay **off** and the Backups screen says so; nothing falls back to the computer's disk.
