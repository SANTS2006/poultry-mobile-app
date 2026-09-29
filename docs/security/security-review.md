# Security review (Phase 13)

Scope: the code in this repository at the Phase 13 commit. Method: design review against the OWASP API Security Top 10 (2023) and OWASP Mobile Top 10, plus the automated
regression suites listed in `docs/testing/test-strategy.md`. **This is a self-review, not a penetration test or certification, and nothing here claims the system is “100 % secure”.**

## OWASP API Top 10 (2023) mapping
| Risk | Controls in place | Evidence |
|---|---|---|
| API1 Broken object-level authorization | Single-farm data model; user-scoped resources (notifications, sessions, devices) always filter by the caller; admin resources need permissions; UUID ids | notification/session IDOR tests, `security.e2e` |
| API2 Broken authentication | Argon2id, 12-char policy + common-password list, progressive lockout, TOTP MFA (replay-proof) mandatory for Owner/Super Admin, 15-min JWT re-validated against the database on every request, rotating opaque refresh tokens with reuse detection (family revoke), step-up (password + code) for MFA changes, generic login errors | `auth.e2e` (100+ tests), JWT forgery matrix |
| API3 Broken object property level authorization | Global whitelist validation (`forbidNonWhitelisted`), server-owned fields (totals, prices, status, actor ids) rejected if sent; role-based response shaping (customer balances need `customers.financial`; reports drop columns) | mass-assignment tests, reports e2e |
| API4 Unrestricted resource consumption | Global throttling (120/min), strict limits on login/MFA/reset, export limit 10/min, 256 kB body limit, page size ≤100, report span ≤366 days and row caps, socket limits (5/user, message size, message rate) | throttle, 413, realtime limit tests |
| API5 Broken function-level authorization | Deny-by-default guard: a route with no declaration is refused; every route declares a permission or `@AnyAuthenticated`/`@Public` | the running route table is walked in `security.e2e` |
| API6 Unrestricted access to sensitive business flows | Idempotency keys, row-locked stock (no overselling, 40-way race tested), void-instead-of-edit with reasons, credit rules, adjustments audited | performance/concurrency suite |
| API7 SSRF | The server makes outbound calls only to the Expo push API and the configured SMTP host; no user-supplied URLs are fetched | code review |
| API8 Security misconfiguration | Helmet, CORS allow-list (empty default), env validation refuses weak secrets / non-TLS DB / missing SMTP in production, no stack traces, `THROTTLE_OFF` forbidden in production | env tests, headers test |
| API9 Improper inventory management | One versioned surface (`/v1`), no debug routes in production; probe routes exist only in the test harness | route walk |
| API10 Unsafe consumption of APIs | Expo push responses are shape-validated; provider errors scrubbed before storage | notifications tests |

## Other controls
Injection: Prisma parameterisation; the few raw queries use tagged templates; search fields tested with SQLi/XSS payloads. Data at rest: MFA seeds AES-256-GCM; recovery codes and refresh tokens stored only as hashes; TLS required to the database.
Integrity: append-only, hash-chained audit log (DB triggers + revoked privileges + verification endpoint); append-only stock ledger with DB CHECK against negative stock; money in `numeric`, never floats. Logging: secrets redacted, no request bodies, request ids.
Mobile (OWASP M1–M10): tokens in Keychain/Keystore, encrypted local database, no secrets in the bundle (`EXPO_PUBLIC_*` are public by design), HTTPS enforced for release builds, generic lock-screen pushes, biometric app lock, no sensitive data in URLs/logs, recovery codes never persisted.

## Residual risks and gaps (accepted or open — decide before go-live)
1. **No external penetration test**; no SAST/DAST in CI. Enable GitHub secret scanning and Dependabot; consider a paid pen-test before scale.
2. **Audit chain is tamper-evident, not tamper-proof**: someone with database write access and the code could recompute every hash. Anchor the latest hash off-database periodically (e.g. in the daily backup job) to close this.
3. **`DATA_ENCRYPTION_KEY` rotation is not implemented** (single key). A leak requires a code change plus MFA resets.
4. **Rate limiting is per instance, in memory**; behind a proxy that hides client IPs it would limit everyone together — verify `trust proxy` for the chosen host. No WAF / bot protection.
5. **Single API instance** (realtime) — availability, not confidentiality.
6. **Mobile**: no jailbreak/root detection, no certificate pinning, no screenshot blocking, no device attestation. A rooted phone can extract the token store. Mitigations: 15-min access tokens, server-side session revocation, biometric lock, encrypted DB.
7. **Dependency advisories**: backend `npm audit --omit=dev` = 0. Mobile shows 15 *moderate* findings in transitive Expo build-time tooling (`@expo/config-plugins` chain, `uuid`, `decode-uri-component`) that are not part of the runtime bundle; track upstream Expo SDK patches.
8. Email is the recovery channel for passwords; a compromised mailbox compromises the account unless MFA is on (it is mandatory only for privileged roles — consider making it mandatory for all).
9. Not implemented: expense approval workflow, receipt attachments, IP allow-listing, admin-initiated forced password reset (users can request one), SMS OTP.
10. Personal data: customer names/phones and financial records are stored. Publish a privacy notice, define retention with legal advice, and honour deletion/export requests manually (no self-service yet).
