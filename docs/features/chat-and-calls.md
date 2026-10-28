# Messaging, voice and video calls

Status and honesty notes are at the bottom ("What is verified"). This document is the design record and the setup guide.

## 1. Findings about the existing system (Stage A)
- **Backend:** NestJS 11 + Prisma + PostgreSQL (Neon). JWT auth with live session revalidation, deny-by-default permission guard, append-only audit log, Brevo e-mail, Expo push (`PUSH_PROVIDER`), Cloudflare R2 (backups).
- **Realtime:** one authenticated Socket.IO gateway (`/realtime`, token in the handshake, per-user room `u:<id>`, rate limits, kicks on revoked session). In-process only ⇒ one API instance (already documented).
- **Mobile:** Expo SDK 57 / RN 0.86 / expo-router, TanStack Query (persisted in encrypted SQLite), zustand, design system in `src/ui`, dark mode, iOS liquid glass, header actions (bell + profile).
- **No existing** chat tables, attachment storage for users, WebRTC, TURN, or call handling. Avatars are stored as small data-URLs in `Profile.avatar`.
- **Must keep working:** every poultry module, offline outbox sync, backups, notifications.

## 2. Architecture chosen (Stage B) and why
| Concern | Choice | Why |
|---|---|---|
| Messages, groups, receipts, presence | **Existing NestJS + PostgreSQL + existing Socket.IO gateway** | Reuses auth, permissions, push and the database; no second backend or paid chat vendor. Postgres is the source of truth; the socket only delivers events and typing/ack signals. REST is used for sending (idempotent, authoritative), never polling for live delivery. |
| Attachments | **Cloudflare R2** via short-lived pre-signed URLs | R2 is already your storage. Files never pass through the API; access is checked by the API each time a URL is issued. |
| Voice / video media | **WebRTC** (`react-native-webrtc`) peer-to-peer for **1-to-1 calls** | Real two-way media with no media server to run or pay for. |
| Signaling | The same Socket.IO connection (server authorises every relayed message) | Reuses the authenticated channel. |
| NAT traversal | **Cloudflare Realtime TURN** (credentials generated server-side, short-lived) with STUN fallback | STUN alone fails on restrictive networks; TURN relay makes calls reliable. Fits the Cloudflare account you already use. |
| Group voice/video | **Not implemented** | Mesh WebRTC does not scale beyond ~3–4 people and would be a 1-to-1 design pretending to be a group design. A real group call needs an SFU (LiveKit or Cloudflare Realtime SFU), a new paid service and server component that you have not chosen. Group *chat* is fully implemented. |
| Native incoming-call UI (CallKit / ConnectionService) | **Not implemented** | Needs native modules (e.g. react-native-callkeep + PushKit/VoIP certificates) that I could not build or test here. Incoming calls ring in-app (foreground) and arrive as a high-priority push (background); tapping opens the call screen. |
| End-to-end encryption | **Not implemented — and the app does not claim it** | Messages are protected by TLS in transit and access control on the server; they are stored readable by the server (needed for history, search, multi-device, group management). Calls are encrypted by WebRTC (DTLS-SRTP) between devices; TURN only relays encrypted packets. |

## 3. Data model
`Conversation` (DIRECT | GROUP, per-conversation `lastSeq` counter, unique `directKey` so a pair has exactly one DM) · `ConversationMember` (role, `lastReadSeq`, `lastDeliveredSeq`, `visibleFromSeq` = people added later do not see older history, mute) · `Message` (per-conversation `seq` for ordering, `(senderId, clientId)` unique for idempotent retries, reply, soft delete, edit) · `ChatAttachment` · `UserBlock` · `MessageReport` · `ChatSetting` (lock-screen previews, push on/off) · `CallSession` (RINGING → ACCEPTED → ENDED with reason) · `Profile.lastSeenAt`.
Permissions: `chat.use` (every role), `chat.groups.create` (Super Admin, Owner, Farm Manager).

## 4. API (all under `/v1`, JWT + `chat.use`)
Conversations: `GET /chat/conversations`, `POST /chat/conversations/direct`, `POST /chat/conversations/group`, `GET|PATCH /chat/conversations/:id`, `POST /chat/conversations/:id/members`, `DELETE /chat/conversations/:id/members/:userId` (remove or leave), `PUT /chat/conversations/:id/members/:userId/role`, `PUT /chat/conversations/:id/mute`, `POST /chat/conversations/:id/read`.
Messages: `GET|POST /chat/conversations/:id/messages`, `PATCH|DELETE /chat/messages/:id`, `POST /chat/messages/:id/report`.
Files: `POST /chat/attachments` → upload URL, `POST /chat/attachments/:id/complete`, `GET /chat/attachments/:id/url`.
People: `GET /chat/users`, `GET /chat/users/:id/avatar`, blocks `POST|DELETE /chat/blocks`, settings `GET|PUT /chat/settings`, config `GET /chat/config`.
Calls: `POST /calls`, `POST /calls/:id/accept|reject|cancel|end`, `GET /calls`, `GET /calls/ice`.
Socket events — client→server: `chat.typing`, `chat.delivered`, `call.signal`; server→client: `chat.message`, `chat.message.updated`, `chat.receipt`, `chat.typing`, `chat.conversation`, `presence`, `call.incoming`, `call.updated`, `call.signal`.

## 5. Security controls
Membership checked on every read/write; group-admin checks on every privileged operation; blocked users cannot DM; attachments are random keys, size/type validated server-side (HEAD after upload), download URLs issued per request (5 min) after a membership check; call signaling relayed only between the two participants of a live call; TURN credentials short-lived and server-generated (secrets never in the app); rate limits on sends/uploads/calls and on socket events; message bodies never written to logs; lock-screen push shows "New message" unless the user enables previews.

## 6. Limits
Message 4 000 chars · attachment 50 MB (jpeg/png/webp/gif, mp4/mov/3gp/webm video, pdf/txt/csv/doc(x)/xls(x)); several files can be picked at once, each is its own message · group 100 members · 5 sockets per user · call ring 45 s · one live call per user · edit window 15 min.


## 7. Mobile screens (Stage G)
Header: a **Messages** button with a live unread badge (next to the bell) · More → Messages, Calls · `/messages` (conversation list: search, unread counts, previews, typing, mute icon, pagination, empty/error/offline states) · `/messages/new` (sheet: pick a person, or New group) · `/messages/group-new` (full-screen: name, description, picture, members) · `/messages/[id]` (chat: bubbles, ticks, replies, edit/delete/copy/report, photos and files, typing, "New messages" marker, failed-send Retry/Discard, offline banner, load earlier) · `/messages/info/[id]` (sheet: mute, call, people, rename/picture/add/remove/make admin, leave, block) · `/messages/settings` (previews, push toggles, blocked list) · `/calls` (history, tap to call back) · `/call` (full-screen incoming / outgoing / voice / video).

## 8. How reliability is handled
- **Ordering and duplicates:** every message has a per-conversation `seq` taken atomically in the same transaction as the insert; the sender's `clientId` makes retries idempotent (tested with 5 parallel retries → 1 row; 25 simultaneous senders → gapless seq). The phone merges by id/clientId and ignores duplicate deliveries.
- **Delivered / read are never guessed:** *delivered* is set only when the recipient's phone acknowledges over its socket; *read* only when the app marks the conversation read. In groups the tick advances only when every other member has reported it.
- **Offline:** unsent messages are saved in the phone's encrypted database, shown as "sending", retried with back-off (1 s … 30 s, 5 automatic attempts), then "failed" with Retry / Discard. After an app restart they come back as failed with Retry. Attachments upload once even if the send needs a retry.
- **Reconnects:** on every socket reconnect the app refetches chat data and any ringing call; push covers the time the socket is down.
- **Calls:** single live call per person (enforced in the database); simultaneous accept/cancel resolved by compare-and-set; a dropped connection gets a 30 s grace period before the call is failed; ICE restart after 3 s of interruption; every exit path closes media tracks, stops the ringtone and releases the audio route.
- **Push:** only sent if the phone did not acknowledge the message within 4 s (no banners for people already looking at the app); default text is "New message"; calls are sent immediately at high priority.

## 9. Setup you must do
1. **Migration:** `cd backend && npx prisma migrate deploy` (adds 8 tables, 6 enums, `Profile.lastSeenAt`, DB constraints and the permissions `chat.use` / `chat.groups.create`). Existing roles are granted them by the migration. Sign out and in once so tokens carry the new permission.
2. **Chat files (optional but expected):** create a **separate** private R2 bucket (e.g. `makarifor-chat`) and an R2 API token with *Object Read & Write* for that bucket only; set `MEDIA_R2_*`. Phones upload directly to R2 with pre-signed URLs; no CORS rule is needed for the native app.
3. **Calls (strongly recommended):** Cloudflare dashboard → **Realtime → TURN** → create a TURN key; set `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN` on the **API only**. Without them the API returns a STUN-only list and calls fail on restrictive networks (the app still works on open Wi-Fi). Cloudflare bills TURN by traffic relayed; check current pricing, it is small for voice and moderate for video.
4. **Push:** unchanged (Expo push; FCM/APNs credentials in EAS). Chat uses Android channels `chat` and `calls`, created on first launch of the new build.
5. **New app build (required):** calls use native code (`react-native-webrtc`, `react-native-incall-manager`), so a **new development/preview/production build** is needed (`eas build`). **Expo Go cannot place or receive calls** (the call buttons are hidden there); text chat, groups and files work in Expo Go except push.
6. `app.json` already has the config plugin and permissions: iOS `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, `UIBackgroundModes: audio`; Android `CAMERA`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `BLUETOOTH(_CONNECT)`, `WAKE_LOCK`, `VIBRATE`, `FOREGROUND_SERVICE(_PHONE_CALL)`, `ACCESS_NETWORK_STATE`.
7. **Webhooks:** none are used (no third-party chat/call provider), so there is nothing to sign or replay-protect. Cloudflare TURN is a plain server-to-server request.

## 10. Costs and limits
No per-user chat fee. Costs are: R2 storage and operations for files, Cloudflare TURN relay traffic for calls, Expo push (free), and your API/database. Message 4 000 chars, file 15 MB, group 100, 60 sends/min/user, 20 uploads/min, 12 call starts/min, signaling 24 KB/message. Presence/typing/calls are in-process on one API instance (as the rest of realtime is).

## 11. What is verified (Stage H) and what is not
**Verified here (real PostgreSQL 16, real Socket.IO sockets, automated):** 41 backend end-to-end tests (access control; DM uniqueness under races; real-time delivery only to members; idempotent sends; gapless ordering under load; validation; pagination; typing; delivery/read receipts and anti-spoofing; replies/edit window/soft delete/report; blocking; group create/rename/add/remove/roles/last-admin rules/history hiding/size cap; attachments incl. type/size/ownership/URL checks and deletion; push privacy, mute, previews and acknowledgement logic; call life-cycle, busy, simultaneous accept/cancel, timeouts, missed-call push, signaling authorisation and size limit, grace-period failure, history, TURN fetch without leaking the token; presence; retention) + 8 unit tests; mobile: 22 unit tests for the call manager and chat logic (including the reconnect timers), sender/outbox and cache-update logic; type-check, lint, and iOS + Android production bundles.
**NOT verified (needs devices / accounts):** actual two-way audio and video between two phones; `react-native-webrtc` and `react-native-incall-manager` against **React Native 0.86's new architecture** (neither package declares new-architecture support; they should work through React Native's compatibility layer, but this must be tested on a development build before release — if it fails, the fallback is a maintained fork or LiveKit's RN SDK); speaker/Bluetooth routing; the ringtone and vibration; camera flip; background and killed-app behaviour; push delivery; real R2 uploads/downloads and real Cloudflare TURN credentials; screen layouts, keyboard behaviour and accessibility on real devices; battery impact.
**Known limitations:** no native incall UI (CallKit / Android ConnectionService), so a call to a phone whose app is killed arrives as a high-priority notification, not a full-screen ring, and may be delayed or dropped by the OS; no group calls; no end-to-end encryption; presence is per connection (a phone that lost signal without closing the socket looks online until the server's ping timeout ~45 s); search covers conversation titles and people's names, not message text; one active call per person; calls and messages need the same single API instance.
