# Mobile app (Phase 11)

Code: `mobile/` (Expo SDK 57, React Native 0.86, TypeScript strict, Expo Router). Tests: 60+ Jest tests in `mobile/src` and
`backend/test/mobile-client.e2e.spec.ts` (the real mobile session/token/endpoint/realtime code against the real backend and PostgreSQL).
Verified here: `tsc`, `eslint` (0 problems), Jest, and a full Metro/Hermes **bundle for Android and iOS**. **Not verified**: running on a device or
emulator, EAS builds, real push delivery, SQLCipher on device, biometrics on hardware (see "Unverified" below).

## Structure
```
src/app/            Expo Router screens. Guard: signed-out → (auth); signed-in → (app); biometric lock → /lock (Stack.Protected)
src/services/       secure store, encrypted SQLite, network monitor, API client + single-flight token refresh, SessionManager,
                    RealtimeClient (Socket.IO), push, biometrics, report export/share
src/sync/           offline outbox engine (Phase 8)         src/api/  every REST call in one typed place
src/state/          zustand stores + AppProvider (boot, realtime/push/sync lifecycle)     src/ui/  design-system components
```
Data: TanStack Query for server data (`networkMode: offlineFirst`, refetch on realtime hints/reconnect), zustand for session/sync/lock state,
SQLite (SQLCipher, key in Keychain/Keystore) for the offline outbox and cached reference data.

## Screens
Sign-in (password → MFA code / recovery code; mandatory MFA enrolment for privileged roles with QR and recovery codes), forgot/reset password,
accept invitation, biometric lock · Home dashboard (only sections the role may see; cash flow labelled "not profit") · Production (list, record, correct, void) ·
Sales (list, new sale, detail, payment, void) · Customers (list, detail, new) · Expenses (list, new) · Stock (balance, history, adjustments, ledger check) ·
Reports (5 reports, period presets, PDF/CSV share sheet) · Notification centre + preferences + push registration · Sync centre (waiting / attention / discard) ·
Notification detail (opening one marks it read) · Stock movement detail (who, when, stock afterwards, link to the source sale/production) ·
Every main screen has a bell with a live unread count and a profile button (photo or initials) at the top right; the profile button opens Settings ·
Settings (edit profile photo and name, change email, password, MFA, devices/sessions, biometric lock, sign-out) · Admin (users, roles, invite, prices, notification rules, audit log with integrity check).

## Security decisions
- Tokens only in the platform secure store (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`); never AsyncStorage, never URLs (realtime token in the handshake `auth`).
- The phone never talks to the database; every permission is enforced by the server. Hidden buttons are convenience only (proved by an e2e test where a production user is refused finance endpoints).
- Half-finished sign-in secrets (MFA/setup tokens) live in memory only. Recovery codes are shown once, never stored.
- **Offline data belongs to a user**: another user cannot sign in over unsent records; sign-out with unsent records is refused unless explicitly discarded (tested).
- Offline records are validated on the phone, saved durably first, then sent with idempotency keys; the server prices and totals everything. Stock corrections, voids, price changes are online-only.
- Sensitive changes (void, correction, disable user, price change) require a typed reason that goes to the audit log.
- Report exports are downloaded with the bearer header, written to the private cache, shared, then deleted; each export is audited server-side.
- Release builds must use HTTPS (`config.ts` refuses otherwise). Lock-screen pushes are generic; details load inside the authenticated app.

## Backend additions in this phase
`GET /v1/audit` (filters, paging, `audit.read`) and `GET /v1/audit/verify` (recomputes the hash chain) — read-only, no write routes (4 e2e tests).

### Profile, email and stock detail (added later)
- `PATCH /v1/auth/profile` `{ fullName?, avatar? }` — own name and picture. The picture is a JPEG/PNG/WebP **data URL** (the phone crops to a square and shrinks to 256 px, ~20–40 KB; the server accepts at most 200,000 characters and checks the type). It is stored in `Profile.avatar`, returned by `/auth/me` and at sign-in, kept **in memory only** on the phone (too large for the secure store) and re-read at start-up. The audit log records *that* it changed, never the image.
- `POST /v1/auth/change-email` `{ newEmail, currentPassword }` — needs the current password and starts a **pending** change: the sign-in address does not change until the link e-mailed to the *new* address is used (so a typo cannot lock anyone out); the old address is told when it changes. Throttled like the password routes.
- `GET /v1/inventory/transactions/:id` — one ledger entry with the recording user and the stock level straight after it.
- The unread count updates through the same realtime event that already refreshes the notification list (`notification.created`), with a 2-minute poll as the fallback when the socket is down.

## Build & run
`cd mobile && npm ci && cp .env.example .env` (set `EXPO_PUBLIC_API_URL`), then `npx expo start` (development build needed: SQLCipher, biometrics and push are not in Expo Go).
EAS profiles are in `eas.json` (development / preview APK / production AAB+IPA). Placeholders you must replace: `extra.eas.projectId` in `app.json`,
API URLs in `eas.json` (`*.example.invalid`), iOS `ascAppId`, and FCM/APNs credentials in EAS.

## Unverified / not done (honest list)
- No device or emulator run; no screenshots. UI layout, keyboard behaviour, dark mode and accessibility (TalkBack/VoiceOver) are untested on hardware.
- SQLCipher via `expo-sqlite` plugin, `expo-local-authentication`, `expo-notifications` push tokens and channels: written to the SDK 57 type definitions, unexercised at runtime.
- No push notification runs in the background app-refresh sense; sync runs while the app is open (foreground auto-sync + on reconnect).
- "Fix and resend" for a refused record is not in the UI (retry or discard only; the engine's `correctAndRetry` exists).
- Charts are simple bars (no chart library). Report tables show the first columns/rows; the export has everything.
- English only, no tablet layouts.
- The photo picker/camera (`expo-image-picker`, `expo-image-manipulator`) and the new screens were type-checked, unit-tested where logic exists and bundled for Android and iOS, but not run on a device.
- The sign-in screen follows the supplied template's layout (brand header, rounded white sheet, pill fields and button) in the app's own green/amber palette. The template's Google/Facebook buttons and "agree to terms" checkbox are not built: there is no social sign-in, and no terms document to link to. Accounts are invite-only.
- Expense receipt photos and approval workflow are not implemented (as documented in Phase 6).
