# Monitoring, alerting and incident response

Nothing here is wired to a monitoring vendor yet (no account exists); the application exposes the signals, you choose the tool.

## Signals the app already provides
- `GET /health/live` (process), `GET /health/ready` (database round-trip; 503 on failure) — point the host's health check and an external uptime monitor (e.g. UptimeRobot, Better Stack) at `/health/ready` every minute, alert on 2 consecutive failures.
- JSON logs (pino) with request ids (the `X-Request-Id` response header and the `requestId` field of every error body let a user report be matched to a log line) and secrets redacted. Ship stdout to the host's log service; alert on `level>=50` bursts.
- Audit log events worth alerting on: `auth.account.locked`, repeated `auth.login.failed`, `auth.refresh.reuse_detected` (stolen token), `user.roles_changed`, `report.exported`, `inventory.adjustment` / `inventory.damage` / `inventory.loss` / `inventory.usage`, `price.changed`. Admins already receive in-app/push security notices for the first three. A weekly `GET /v1/audit/verify` check should be scripted and alert if `intact:false`.
- Business integrity checks: `GET /v1/inventory/reconciliation` (`consistent:true`), the restore drill's SQL assertions.

## Suggested alert rules
| Signal | Threshold | Action |
|---|---|---|
| `/health/ready` failing | 2 min | check Neon status, connection limits, redeploy |
| HTTP 5xx rate | >2 % for 5 min | see logs by request id |
| p95 latency | >1.5 s for 10 min | check Neon compute size/cold starts, slow queries (reports) |
| Login failures / lockouts | >20 in 10 min | possible credential stuffing: consider a stricter throttle or IP block at the proxy |
| Backup job | no new dump in 26 h | run manually, fix |
| Push failures | sustained `FAILED` deliveries | check Expo credentials (FCM/APNs) |

## Incident response (small team)
1. **Detect & triage** — who noticed, what is broken, is data at risk? Note the time. Severity: S1 data exposure / integrity loss, S2 outage, S3 degraded.
2. **Contain** — S1 suspected token/credential leak: rotate secrets, revoke sessions (`DELETE /v1/users/:id/sessions`, or rotate `JWT_*` for everyone), disable affected users. Suspected bad data: stop writers (maintenance response at the proxy) before repairing.
3. **Preserve evidence** — export logs and `GET /v1/audit` for the window; do not delete anything (audit rows cannot be deleted by the app role).
4. **Recover** — playbooks in `backup-recovery-dr.md`; verify with reconciliation + audit verify.
5. **Notify** — inform the business owner immediately; if personal data of customers was exposed, follow the obligations of the jurisdiction the farm operates in (get local legal advice — this document is not legal advice).
6. **Review** — write a short post-mortem; add a regression test for the failure.

## Known operational limits
Single API instance; no automatic failover. Neon free/low tiers can cold-start the database (first request slow). Realtime is best-effort; the app always works without it.

## Why requests can be slow, and what was done about it
Almost all of the time in a request is **round trips to the database**: each query waits for the network. If the API and the database are far apart (for example the API on a laptop in Africa and Neon in `us-east-2`), one query can cost 0.5–1 s, and a record that needs 15–25 queries takes 10–20 s. Measured from the logs of a real session: sign-in state, settings, reference data and dashboards each cost several round trips, and a production record needed more than 5 s inside a transaction (the old Prisma limit), so it failed half-way and was retried forever.

What the code now does: fewer queries per request (cached sign-in state for 10 s with immediate invalidation, cached settings/units/farm/coops/shifts, one-statement stock updates, parallel dashboard and reference queries, dashboard sections cached 15 s and emptied by any business event), a 60 s transaction limit, and on the phone small sync batches (5 records), a 90 s push limit, and last-known answers kept on the phone so screens open instantly.

What only deployment can fix: **put the API in the same region as the database**. Check with `GET /health/ready`: `dbRoundTripMs` should be under about 20 ms in production; if it is hundreds of milliseconds, move the API or the Neon project (and use Neon's pooled connection string, host containing `-pooler`).
