# Notifications (Phase 9)

Code: `backend/src/notifications/`. Tests: `notifications.spec.ts` (Expo client, formatting) and `backend/test/notifications.e2e.spec.ts`
(29 end-to-end tests against real PostgreSQL, a scripted push provider and real WebSockets). Safeguards were mutation-checked.

## Architecture (as required)
```
Business event (after DB commit) ─▶ NotificationRules ─▶ recipients chosen ON THE SERVER (role + permission + status + preferences)
   ─▶ Notification row in PostgreSQL (in-app notification center = source of truth)
   ─▶ NotificationDelivery per registered device ─▶ Expo Push Service ─▶ APNs / FCM ─▶ phone
   ─▶ user taps ─▶ app opens the authenticated screen (deep link carries ids only) ─▶ POST /notifications/:id/opened
```
The mobile client never decides who is notified. Events come from the same in-process bus that feeds realtime (Phase 7); rules run after commit and
can never fail or slow the business operation (fire-and-forget with error logging).

## Recipients: role-based, permission-checked
| Event | Notified (never the person who caused it) | Category |
|---|---|---|
| Production recorded | Farm Manager (with `production.read`) | PRODUCTION |
| Missing shift (scheduled reminder) | Production Staff + Farm Manager (with `production.create`) | PRODUCTION |
| New sale / large sale | Owner + Farm Manager (`sales.read`) / Owner only (threshold configurable, off by default) | SALES |
| Payment received later against a sale | Owner + Accountant (`payments.read`) — the till payment is covered by the sale alert | PAYMENTS |
| New expense / monthly threshold exceeded | Owner + Farm Manager / Owner (threshold configurable, once per month) | EXPENSES |
| Low egg stock (below threshold, once per 24 h) | Owner, Farm Manager, Sales Staff (`inventory.read`) | INVENTORY |
| Inventory adjustment | Owner + Super Admin | INVENTORY |
| Offline sync needs attention / completed | the user who synced (success is in-app only, no buzz) | SYNC |
| New device, password change, MFA on/off/reset, lockout, replayed session, role change, disabled/re-enabled | the affected user | SECURITY |
| Repeated failed logins | Super Admin (with the user) | SECURITY |
| New user, role changed, user disabled | Super Admin + Owner (`users.manage`) | ADMIN |
| Daily summary | everyone with `dashboard.read`, figures limited to what they may see | DAILY_SUMMARY |

Production staff never receive sales, expense or payment notifications (tested). A **disabled** user receives no business notification;
the only thing they still get is "your account has been disabled" (the one exception, tested).

## Preferences
Users can mute PRODUCTION, INVENTORY, SALES, EXPENSES, PAYMENTS, SYNC and DAILY_SUMMARY. **SECURITY, ADMIN and SYSTEM cannot be turned off**
(the API refuses with 400). A muted category creates no notification and no push. `GET/PUT /v1/notifications/preferences`.

## Lock-screen privacy
Every notification has two texts: the **in-app** text (may contain details, shown inside the authenticated app) and a **push** text that is
deliberately generic ("A new sale was recorded.", "Your daily poultry summary is ready."). Tested: amounts, prices, customer names, coop names and
egg counts never appear in any push payload. The push `data` carries only `notificationId, type, entityType, entityId`. Security pushes use high priority.

## Delivery tracking
Per device: `PENDING → SENT (provider ticket) → DELIVERED (receipt, polled ~15 min later) → OPENED (app reports the tap)`, or `FAILED` with the provider's
error code. `DeviceNotRegistered` (from the ticket or the receipt) removes the device. Push-service outages leave the in-app notification intact
(`FAILED / TransportError`). Read state is tracked on the notification. When push is not configured no delivery work is created at all.

## Data retention
Stale devices (not seen for 90 days), delivery rows (90 days) and notifications (365 days) are purged daily. Tokens are unique per phone and move to the newly
signed-in user; users can only remove their own. Provider error text is scrubbed of token-like strings before storage.

## Scheduler
`NotificationScheduler.tick()` runs every minute (not in the test environment, where tests drive it): daily summary (default 18:00, configurable, one per user per day,
built from live database numbers with the same permission filter as the dashboard, optional e-mail copy that is **off by default**), production reminders
(Morning 10:00 / Afternoon 15:00 / Evening 19:00 by default, only if a coop really lacks that shift today), Expo receipt polling, purge. Times are in
`business.timezone`. It is idempotent (per-day de-duplication in the database), so restarts and multiple instances do not duplicate notifications.

## API
`GET /v1/notifications?status=unread|read|all&category=&page=&limit=` · `GET /unread-count` · `GET /:id` · `POST /:id/read` · `POST /read-all {category?}` · `POST /:id/opened` ·
`GET|PUT /preferences` · `POST /devices {pushToken, platform, deviceName?}` · `DELETE /devices {pushToken}` · `POST /test` (sends to your own devices) ·
admin `GET|PUT /config` (`notifications.manage`: daily summary on/off/time/e-mail, production reminder times, large-sale and monthly-expense thresholds; audited).
Realtime: a `notification.created` event (id + category only) goes to the recipient's own sockets so the badge updates instantly.

## Configuration & what you must do
- `PUSH_PROVIDER` = `expo` (default in staging/production) or `none` (default in development/test, so nothing is ever pushed by accident). `PUSH_NOTIFICATION_CONFIG` = optional Expo access token (needed only if you enable Expo "enhanced push security").
- For real delivery you need an Expo/EAS project with **FCM (Android) and APNs (iOS) credentials** added through EAS; the mobile app must request permission and register its token (Phase 11).
- Optional daily-summary e-mail needs Brevo (`BREVO_API_KEY`, `EMAIL_FROM`).

## Not implemented / unverified (honest list)
- **Real push delivery is unverified**: the Expo client is tested against the documented request/response shapes with a mocked network, and end-to-end with a scripted provider. Nothing has been sent to a real phone or to Expo from this environment.
- "Expense requires approval" is not implemented (no approval workflow exists yet). "Important system setting changed" has no source (no general settings screen yet).
- A "new login" notice is sent only for a **new device**, not for every login (every login is in the audit log).
- Single-instance only for the realtime part (Phase 7 limitation); the scheduler itself is safe with several instances.
- Notification text is English only.
