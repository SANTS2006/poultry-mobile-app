# Backup, recovery and disaster recovery

Two independent layers, because one is never enough:

| Layer | What | Protects against | Verified here? |
|---|---|---|---|
| Neon point-in-time restore / branching | provider-side history within your plan's retention window | bad deploy, accidental delete, corruption noticed quickly | **No** (needs a Neon project) |
| Logical dumps `backend/scripts/backup.sh` | `pg_dump` custom-format file + SHA-256, kept **outside** Neon | provider outage or account loss, retention gaps, long-term archive | **Yes** — dumped and restored a real database |

## Targets (proposal — confirm with the owner)
RPO ≤ 24 h from logical dumps (schedule daily; PITR gives minutes within its window). RTO ≈ 2–4 h to a new database + redeploy. Tighten by running the dump more often.

## Daily backup
`DIRECT_DATABASE_URL=… ./backend/scripts/backup.sh /secure/path 30` (needs `postgresql-client` 16+). Schedule it from a small always-on machine or a CI cron job, and **copy the file to encrypted storage in a different account/provider**.
Dumps contain customer and financial data: encrypt at rest, restrict access, never send by e-mail or chat, and delete per your retention policy.
Also back up, separately and securely: `DATA_ENCRYPTION_KEY`, `JWT_*` secrets (a leaked/lost JWT secret only forces re-login; a lost encryption key strands MFA seeds), and the EAS credentials.

## Restore drill (do this quarterly and before go-live)
```bash
ADMIN_DATABASE_URL=postgresql://…/postgres ./backend/scripts/restore-verify.sh backups/makarifor-YYYYmmdd-HHMMSSZ.dump
```
It checks the checksum, restores into a throw-away database, and asserts: users exist · **stock balance = sum of the ledger** · no negative stock · sale totals = item lines − discount · audit append-only triggers exist · audit hash-chain linkage has no gaps. Exit code 0 means the backup is usable.
Verified behaviour: passes on a clean database; fails (exit 1) on a corrupted dump; flags rows inserted around the safeguards (it flagged deliberately raw-inserted test rows).
After a real restore also call `GET /v1/audit/verify` (Owner/Super Admin) to re-verify the full cryptographic audit chain, and `GET /v1/inventory/reconciliation`.

## Recovery playbooks
1. **Bad data change / bad deploy (minutes–hours ago)**: use Neon PITR to create a branch at the time before the incident, compare, then either promote the branch (update `DATABASE_URL`) or copy the affected rows. Prefer restoring into a *new* branch first; never restore over production blindly.
2. **Database lost or provider outage**: create a Postgres 16 database anywhere (a new Neon project or another host), `pg_restore --no-owner --no-privileges --dbname=$NEW_DIRECT_URL <dump>`, run `prisma migrate deploy` (no-op if current), re-run `prisma/sql/app_role.sql`, point `DATABASE_URL`/`DIRECT_DATABASE_URL` at it, redeploy, run the checks above. Phones keep their unsent records; they sync when the API is back.
3. **API host lost**: redeploy the last image tag from GHCR with the saved environment variables. No state lives in the API process except realtime connections (clients reconnect) and the notification scheduler (idempotent).
4. **Secret compromise**: rotate `JWT_SECRET`/`JWT_REFRESH_SECRET` (all users must sign in again — acceptable), database passwords, Brevo API key, Expo token. `DATA_ENCRYPTION_KEY` rotation is not implemented: if leaked, reset MFA for all users after introducing a new key (requires a code change — see security review).
5. **Lost phone**: an administrator disables the user or revokes their sessions (Admin → Users); the device's tokens stop working immediately and its sockets are dropped. The offline database on the phone is encrypted (SQLCipher, key in Keychain/Keystore) but unsent records on a lost phone are lost to the business — another reason to sync often.

## Data retention
Notifications 365 days, delivery rows and stale devices 90 days (automatic). Audit log, ledger and prices are append-only and never purged. Define legal retention for financial records with your accountant; nothing here deletes them.
