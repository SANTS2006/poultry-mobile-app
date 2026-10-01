# Run locally and test on a real phone

Use the same Wi-Fi for laptop and phone. Commands are for macOS/Linux; on Windows use WSL2 (recommended) or Git Bash.

## A. Laptop: database + API
Install: Node 22, PostgreSQL 16 (or Docker), Git.
```bash
git clone <repo> && cd poultry-mobile-app && git checkout claude/festive-goodall-5u4fwi
createdb makarifor_dev                      # or:  docker run -d --name pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16 && createdb -h localhost -U postgres makarifor_dev
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
npx prisma migrate deploy && npm run db:seed
npm run demo:data -- --no-mfa               # demo users, coops, prices, customers, 5,000 eggs opening stock
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
| `owner@demo.local` | Owner | everything incl. admin, audit, reports export |
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
5. Sign in as production → confirm no finance screens; Settings → Lock app with fingerprint.
6. Password change signs you out everywhere; Devices and sessions lists the phone.
Push notifications additionally need a real EAS project id + FCM/APNs credentials (`docs/mobile/release-eas.md`); everything else works without them.

## Troubleshooting
- “No connection to the server”: wrong IP, laptop firewall, different network, or API not running; test the browser URL from the phone.
- Build fails on the project id: run `eas init`. API URL changes need a rebuild only if baked in; with `expo start` the env var is read at start.
- Reset demo data: `dropdb makarifor_dev && createdb makarifor_dev`, then repeat step A.
Status: this exact flow was verified for the laptop side (migrate, seed, demo data, API start, demo logins). The phone build/installation steps have NOT been run by me (no phone/Expo account here).
