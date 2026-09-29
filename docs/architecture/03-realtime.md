# Realtime architecture (Phase 7)

Implemented in `backend/src/realtime/` (Socket.IO gateway), `backend/src/dashboard/` (live dashboard) and the in-process event bus
`backend/src/domain/events.service.ts`. Verified by `backend/test/realtime.e2e.spec.ts` (26 tests using real WebSocket clients against a
listening server and real PostgreSQL).

## Flow
```
HTTP write ─▶ service transaction ─COMMIT─▶ DomainEvents.emit (only after commit; never on rollback or idempotent replay)
                                                   │
                                     RealtimeGateway.route()
                                    ┌──────────────┼───────────────────────────┐
                              topic room      user room                internal actions
                        (permission-checked)  (notification.created)   session.revoked → disconnect
                                                                        access.changed → re-check rooms
                                                                        dashboard events → debounced hint
```
Events carry **ids and non-sensitive facts only** (`name, entityId, farmId, actorId, data, at`); clients refetch details over the normal
REST API, which re-checks permissions. Verified: no amounts, prices or customer names ever appear in a payload.

## Connecting (mobile client contract)
```ts
const socket = io(API_URL, { path: '/realtime', transports: ['websocket'], auth: { token: accessToken }, reconnection: true });
socket.on('ready', ({ expiresAt }) => socket.emit('subscribe', { topics: ['inventory', 'sales'] }, (ack) => …));
socket.on('auth.expiring', async () => socket.emit('reauth', { accessToken: await refreshAccessToken() }));   // ~60 s before expiry
socket.on('auth.revoked', ({ reason }) => …);       // token_expired | session_revoked | account_disabled | session_invalid | reauth_failed | rate_limited
socket.on('sale.created', (e) => queryClient.invalidateQueries({ queryKey: ['sales'] }));
socket.on('dashboard.invalidate', () => queryClient.invalidateQueries({ queryKey: ['dashboard'] }));
```
Re-subscribe after every reconnect (subscriptions live on the connection). The token goes in `auth`, never in the URL.

## Security controls
| Control | How |
|---|---|
| Authenticated handshake | access token verified like an HTTP request **plus** live user/session check (disabled user, revoked family, stale `tokenVersion` all refused). One generic `unauthorized` error for every failure |
| No token in URLs / no polling | WebSocket transport only; token accepted only from `auth` |
| Authorised subscriptions | clients never name rooms; they `subscribe` to whitelisted **topics**, each mapped to a permission (`production.read`, `inventory.read`, `sales.read`, `payments.read`, `expenses.read`, `customers.read`, `dashboard.read`, `settings.manage`). Denials are reported per topic |
| Events routed by topic | an event goes only to the room of the topic that carries it; unsubscribed sockets get nothing |
| Immediate revocation | disable user, logout, logout-all, admin session revoke, password change/reset and MFA reset disconnect the affected sockets at once (event-driven, not polled) |
| Permission changes | role change or role-permission edit re-checks live sockets and drops topics no longer permitted (`subscription.revoked`), connection stays up |
| Token lifetime | connection closes at access-token expiry; `auth.expiring` warns 60 s before; `reauth` with a fresh token of the **same user** extends it |
| Backstop | every 60 s all sockets are re-validated against the database |
| Abuse limits | max 5 sockets per user, 10 kB max message, 20 control messages / 10 s per socket (persistent abuse ⇒ disconnect), ≤10 topics per request |
| CORS | allow-list from `CORS_ORIGINS` (empty by default); native apps send no Origin |
| Isolation | a failing event subscriber cannot fail a business operation |

## Dashboard (`GET /v1/dashboard`, permission `dashboard.read`)
Computed from the database on every request; sections appear only if the caller may see that data:
`production` (today by coop/shift, 14-day trend, shifts not yet recorded), `inventory`, `sales`, `expenses`, `cash` (needs `payments.read`
+ `expenses.read`; **cash received minus expenses recorded today — labelled as not profit**), `receivables` (needs `customers.financial`),
`needsReview` counts. Realtime only sends `dashboard.invalidate` (coalesced over 400 ms) telling subscribed clients to refetch.
Not included yet (their features arrive later): unread notifications (Phase 9), pending sync (device-side, Phase 8).

## Limitations (honest list)
- **Single instance.** The event bus is in-process. Running several API instances needs the Socket.IO Redis adapter *and* publishing domain
  events through Redis; until then keep one instance (or accept that clients only see events from the instance they are connected to).
- Delivery is at-most-once: a client that was offline misses events. After reconnecting it must refetch (TanStack Query does this on focus/reconnect).
- Business events are **not persisted for replay**; notifications (Phase 9) are the durable channel.
- Client-side behaviour (auto reconnect, invalidation wiring) is specified above but built in the mobile phase; only the server side is verified here.
- The 60-second re-check is a backstop; the immediate paths are the events listed above. A change made directly in the database (not via the API) is picked up within a minute.
