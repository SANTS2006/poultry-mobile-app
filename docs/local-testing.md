# Run locally and test on a real phone

## Quickest way: Expo Go (no build, no accounts)
1. Start the API on the laptop (section A below, including `npm run demo:data -- --no-mfa`).
2. Install **Expo Go** on the phone (Play Store / App Store; it must be a version that supports **SDK 57**).
3. Laptop and phone on the same Wi-Fi, then:
   ```bash
   cd mobile && npm ci
   npm run go          # detects your LAN IP, checks the API answers, starts Expo and shows a QR code
   ```
   Scan the QR code (Android: inside Expo Go; iPhone: the Camera app). Sign in with a demo account (section C).
   If Wi-Fi blocks the connection: `npm run go -- --tunnel` for the app bundle (the phone still needs to reach the API at the printed address; if it cannot, expose the API with a tunnel such as `ngrok http 3000` and run `API_URL=https://<name>.ngrok-free.app npm run go -- --tunnel`).

**What differs in Expo Go (by design, shown in Settings and on the sign-in screen):** the on-phone database is plain SQLite, not encrypted; remote push notifications are unavailable (in-app notifications work); links such as `makarifor://reset-password` do not open the app (paste the token instead); iPhone Face ID may fall back to the passcode. Production builds refuse to start without database encryption. Everything else (sign-in, MFA, offline recording and sync, sales, reports, admin) runs the same code.
Status: I verified that the Expo dev server starts and serves an SDK 57 manifest and the Android bundle with your API address inside, and that tests, typecheck and lint pass. I could **not** open it in Expo Go on a phone from here, so the first scan is the real test.

## Full device build (encrypted database, push)

Use the same Wi-Fi for laptop and phone. Commands are for macOS/Linux; on Windows use WSL2 (recommended) or Git Bash.

## A. Laptop: database + API
Install: Node 22, PostgreSQL 16, Git.
```bash
git clone <repo> && cd poultry-mobile-app && git checkout claude/festive-goodall-5u4fwi
createdb makarifor_dev
cd backend && npm ci
cat > .env <<'EOF'
APP_ENV=development
PORT=3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/makarifor_dev
DIRECT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/makarifor_dev
JWT_SECRET=dev-only-jwt-secret-change-me-0123456789
JWT_REFRESH_SECRET=dev-only-refresh-secret-change-me-0123456789
DATA_ENCRYPTION_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=
EOF
npx prisma generate && npx prisma migrate deploy && npm run db:seed
npm run demo:data -- --no-mfa               # (add --allow-remote only for a throwaway Neon test database) demo users, coops, prices, customers, 5,000 eggs opening stock
npm run start:dev                           # API on port 3000 (listens on all interfaces)
```
Check: `curl localhost:3000/health/ready` → `{"status":"ok"}`. Find the laptop's LAN IP (`ipconfig` / `ifconfig` / `ip addr`), e.g. `192.168.1.25`, and open port 3000 in the laptop firewall.
From the phone's browser, `http://192.168.1.25:3000/health/live` must show `{"status":"ok"}` — if not, fix Wi-Fi/firewall before going on (guest/"client isolation" networks block it).

## B. Phone app
Expo Go **cannot** run this app (encrypted SQLite, biometrics, push need native code), so you need a *development build*:

**Android (easiest, free):**
```bash
cd mobile && npm ci && npm i -g eas-cli && eas login && eas init       # creates the project id in app.json
# edit eas.json -> build.device.env.EXPO_PUBLIC_API_URL = http://192.168.1.25:3000
eas build --profile device --platform android                          # ~15 min in Expo's cloud; open the link on the phone, install the APK
EXPO_PUBLIC_API_URL=http://192.168.1.25:3000 npx expo start --dev-client   # keep running; open the installed app, it connects to this
```
Alternative without an Expo account: install Android Studio + enable USB debugging, then `EXPO_PUBLIC_API_URL=http://192.168.1.25:3000 npx expo run:android` with the phone plugged in.

**iPhone:** needs an Apple Developer account (paid) for `eas build --profile device --platform ios` (register the device with `eas device:create`), or a Mac with Xcode (`npx expo run:ios --device`, free 7-day signing).

## C. Login data (development only)
Password for all: `demo-password-tractor-2026`
| Email | Role | Try |
|---|---|---|
| `superadmin@demo.local` | **Super Admin (demo)** | everything, including roles and security; can add coops and invite owners |
| `owner@demo.local` | Owner | everything incl. admin, audit, reports export, adding coops |
| `manager@demo.local` | Farm Manager | production, stock, sales, expenses, view reports |
| `production@demo.local` | Production Staff | record eggs only (no money screens) |
| `sales@demo.local` | Sales Staff | sales, customers, payments |
| `accountant@demo.local` | Accountant | finance views, reports + export |
Without `--no-mfa` the Owner must set up an authenticator app on first sign-in (Google/Microsoft Authenticator) — good for testing MFA. These accounts exist only through `demo:data`, which refuses to run outside local development.

## D. What to test
1. Sign in as production → Record production (Coop 1, Morning, 5 crates) → appears in Production tab and Stock.
2. Airplane mode → record another shift → banner “Offline”, record saved → turn Wi-Fi on → it syncs (More → Sync).
3. Sales → New sale (2 cartons, paid in full); then credit sale for “Mama Kadi” → Customers shows what she owes → record a payment.
4. Sign in as owner → Reports → Share PDF; Admin → Audit log → “Check integrity”.
5. Sign in as production → confirm no finance screens; Home shows production figures (today, yesterday, 7 days, month); Settings → Lock app with fingerprint.
6. Sign in as sales → Home shows sales figures (today, 7 days, month, average sale, top customers) and customer counts, but no expenses or production.
7. Sign in as owner → More → Administration → Coops → Add a coop (name, optional capacity); it appears in the production form straight away.
8. Owner → Administration → Users → Invite a user: the invitee gets an email (needs `BREVO_API_KEY`; without it the message is captured in memory and not sent) with a temporary password (business initials + year, for example `DF2026` for "Demo Farm"). Signing in with it asks for a new password immediately.
9. Tap your photo (top right) → Dark mode / Settings / Log out. Settings → Appearance also has Light / Dark / Same as phone.

> The demo super admin is for **local or throwaway databases only**. For a real system create the first Super Admin with `npm run bootstrap:admin`.
6. Password change signs you out everywhere; Devices and sessions lists the phone.
Push notifications additionally need a real EAS project id + FCM/APNs credentials (`docs/mobile/release-eas.md`); everything else works without them.

## Troubleshooting
- “No connection to the server”: wrong IP, laptop firewall, different network, or API not running; test the browser URL from the phone.
- Build fails on the project id: run `eas init`. API URL changes need a rebuild only if baked in; with `expo start` the env var is read at start.
- Reset demo data: `dropdb makarifor_dev && createdb makarifor_dev`, then repeat step A.
Status: this exact flow was verified for the laptop side (migrate, seed, demo data, API start, demo logins). The phone build/installation steps have NOT been run by me (no phone/Expo account here).
