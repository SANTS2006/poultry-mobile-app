# Authentication, MFA, sessions, RBAC and audit (Phase 4)

Everything here is enforced by the Node.js backend; the mobile app only presents UI. Behaviour listed below is covered by
`backend/test/auth.e2e.spec.ts` (49 tests against real PostgreSQL) plus unit tests; the four most critical controls
(deny-by-default authorization, refresh-reuse detection, token-version check, MFA enforcement) were additionally verified by
mutation: breaking each one made a test fail.

## Login flow
```
POST /v1/auth/login {email,password}
  → {status:"authenticated", tokens, user}          normal users
  → {status:"mfa_required", mfaToken}                MFA enabled  → POST /v1/auth/mfa/verify {mfaToken, code | recoveryCode}
  → {status:"mfa_setup_required", setupToken}        role requires MFA but none enrolled: NO session is issued until
                                                     POST /v1/auth/mfa/enroll + /mfa/confirm (setupToken) succeed
```
- Passwords: Argon2id (m=19 MiB, t=2, p=1), policy = 12–128 chars, not common/repetitive, no e-mail name. Unknown e-mails are
  verified against a dummy hash so timing does not reveal valid accounts; wrong-password and unknown-e-mail responses are identical.
- Lockout: 5 failures → 1 min, doubling to 30 min (`429`); wrong MFA codes count too; audited (`auth.account.locked`).
- Per-route rate limits (per client IP): login/MFA 5 per minute, forgot-password/resend 3, other public auth 10; global 120.
- E-mail must be verified; disabled accounts get a clear message only after the password is proven.

## Tokens and sessions
- Access token: JWT HS256 (`JWT_SECRET`), 15 min, claims `sub, fid (session family), tv (tokenVersion), typ`; issuer/audience checked,
  algorithms pinned. Contains **no permissions**: the guard loads the user, roles and permissions from the database on every
  request and requires the session family to be live. Consequences: disabling a user, revoking a session, logout-all, password
  reset or a role change take effect on the next request, not at token expiry.
- Refresh token: 384-bit opaque random value, returned once, stored as HMAC-SHA256 keyed with `JWT_REFRESH_SECRET` (a database leak
  cannot mint tokens). **Rotation** on every refresh; **reuse of a retired token revokes the entire family** and is audited.
  Absolute lifetime 30 days (not extended by refreshing), idle timeout 14 days, max 10 devices per user.
- `logout` (this device), `logout-all` (all devices + tokenVersion bump), `GET/DELETE /auth/sessions` (device list/revoke),
  admin `DELETE /users/:id/sessions`.
- Password change signs out every *other* device; password reset signs out all devices.
- MFA intermediate tokens (`mfa` 5 min, `mfa-setup` 15 min) are single-purpose and are rejected as access tokens.

## MFA
TOTP (RFC 6238; verified against the RFC 4226/6238 test vectors), ±1 step drift, **each time-step accepted once** (replay-proof),
QR + secret at enrolment, secret encrypted at rest with AES-256-GCM (`DATA_ENCRYPTION_KEY`), 10 single-use recovery codes stored
hashed. Disable/regenerate need password + fresh code; disabling is refused for roles with `mfaRequired` (Super Admin and Owner by
default). Lost device: `POST /users/:id/reset-mfa` by an authorised admin (reason mandatory, audited, target signed out everywhere;
you cannot reset your own).

## Authorization
`JwtAuthGuard` → `PermissionsGuard` (global). **Deny-by-default**: an endpoint must declare `@Public()`, `@RequirePermissions(...)`
(all listed permissions required) or `@AnyAuthenticated()`; anything else returns 403. Privilege-escalation rules for user/role
administration: you can only assign roles whose permissions you already hold, cannot manage users above your own privilege,
cannot change your own roles or disable yourself, cannot edit the Super Admin role, and the last active Super Admin cannot be
removed. Unknown JSON properties are rejected on every route (mass-assignment).

## Invitations, verification, reset
Single-use, expiring (invite 72 h, verify 24 h, reset 1 h), SHA-256-hashed-at-rest tokens consumed with an atomic compare-and-set.
Forgot-password/resend answer identically for known and unknown addresses and skip disabled accounts. First administrator:
`npm run bootstrap:admin -- --email … --name …` (refuses if a Super Admin exists; nobody types a password into a script; the invitation carries a temporary password that must be replaced at first sign-in).

## Audit
`AuditService` writes append-only rows (DB triggers block UPDATE/DELETE/TRUNCATE) chained by SHA-256 (`prevHash`/`hash`);
`verifyChain()` detects edits even by someone who disables the trigger (tested). Before/after snapshots are scrubbed of
credential-like keys. Events include login success/failure, lockout, new device, refresh reuse, password change/reset, MFA
enable/disable/reset/recovery-use, invites, role and permission changes, disable/reactivate, session revocation.

## OWASP mapping (authentication-related)
A01 Broken access control → deny-by-default guards, live permission loading, escalation rules. A02 Cryptographic failures →
Argon2id, AES-GCM, HMAC-peppered refresh hashes, TLS enforced in config. A04/A07 Identification & authentication failures →
lockout, MFA, rate limits, rotation/reuse detection, no enumeration. A08 Integrity → hash-chained audit. A09 Logging → audit + redacted logs.

## Known limitations (honest list)
- **Security notifications** (new device, password changed, MFA changes, lockout) are recorded as audit events now; push/in-app
  delivery is built in Phase 9. Password-change and reset already send an e-mail.
- E-mail delivery is only exercised through an in-memory outbox in tests; **real Brevo delivery is unverified** until you configure `BREVO_API_KEY` and a verified `EMAIL_FROM`.
- After 5 failed attempts the API answers 429 for that account, which confirms the account exists to someone who guesses 5 times;
  the per-IP throttle limits the reach. Accepting this trade-off so real users learn why they are locked out.
- Rate-limit counters are in process memory: fine for one instance; use a Redis store before running multiple instances.
- A client that fires two simultaneous refreshes with the same token is treated as reuse and signed out (strict by design; the
  mobile client must serialise refreshes — planned in the mobile phase).
- Audit appends are serialised by an advisory lock: correct and simple, but a throughput ceiling for very high write rates.
- Biometric unlock, secure device storage and screen protection belong to the mobile phase and are not part of this one.

## Invitations and the temporary password (current design)
- An administrator invites a person (name, e-mail, role). The system creates the account with a **temporary password = initials of the business name + the year** (for example `MA2026`) and e-mails it through Brevo together with the business name, the person's role and what it allows, their sign-in e-mail, and the expiry. The account is marked `mustChangePassword`.
- **This password is guessable by design** (anyone who knows the business name and the year could guess it). It is made safe to use by limiting what it can do: it never produces a session. Signing in with it returns only a 15-minute `pwd-change` token whose single use is `POST /v1/auth/first-password` (new password must pass the full policy and differ from the temporary one). It expires after **72 hours**, a wrong guess counts toward the normal progressive lockout, an administrator can resend (new expiry), and MFA enrolment for privileged roles still follows the password change.
- The residual risk: until the invitee signs in, someone who knows the invitee's e-mail address and the pattern could set the first password before them (and would then also have to pass MFA enrolment if the role requires it). Mitigations: short expiry, audit entries (`auth.password.first_set`), and the invitee receives a "your password was set" e-mail. If this is unacceptable, switch to a random temporary password by changing `temporaryPassword()` in `backend/src/users/temp-password.ts` (one function).
- There is no invitation link or accept-invitation screen any more.
