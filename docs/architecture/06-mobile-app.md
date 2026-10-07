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
Settings (password, MFA, devices/sessions, biometric lock, sign-out) · Admin (users, roles, invite, prices, notification rules, audit log with integrity check).

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
- Icons are emoji/text (no icon font), English only, no tablet layouts.
- Expense receipt photos and approval workflow are not implemented (as documented in Phase 6).
