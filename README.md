# Makarifor Agriculture — Poultry Management System

Replaces the Excel workbook (`migration/source/`, archived unmodified) with a secure, auditable system:
**Expo/React Native app → HTTPS/WebSocket → NestJS API → PostgreSQL (Neon)**. The phone never touches the database.

| Area | Where |
|---|---|
| Mobile app (Android/iOS, offline-first) | `mobile/` |
| API (NestJS 11, Prisma 6, PostgreSQL 16) | `backend/` |
| Docs | `docs/` — start with `architecture/02-phase2-architecture.md` |

## What it does
Egg production by coop/shift · append-only stock ledger · sales, customers, credit and payments · expenses · dashboard · reports with PDF/CSV export · push and in-app
notifications · offline recording with safe sync · roles and permissions, MFA, sessions, tamper-evident audit log · Excel history import with reconciliation report.
The financial view is **cash flow, not profit**, and says so everywhere.

## Quick start (development)
```bash
# API
cd backend && cp .env.example .env        # fill values; needs PostgreSQL 16
npm ci && npx prisma migrate deploy && npm run db:seed && npm run start:dev
# tests
npm test && npm run test:e2e              # e2e needs DATABASE_URL pointing at a database named *_test
# Mobile (development build required — Expo Go cannot run SQLCipher/biometrics/push)
cd ../mobile && npm ci && cp .env.example .env && npx expo start
```
Or `docker compose up --build` (see `docs/deployment/production-deployment.md`).

## Documentation map
- Analysis & architecture: `docs/architecture/01…06`
- API: `docs/api/core-operations.md`, `docs/api/reports.md` · Security: `docs/security/`
- Testing: `docs/testing/test-strategy.md` (245 e2e + 86 unit + 83 mobile tests; 96 % backend line coverage)
- Deployment & operations: `docs/deployment/`, `docs/operations/` (backup/DR, monitoring, incident response, **go-live checklist**)
- Mobile release: `docs/mobile/release-eas.md`

## Honest status
Built and tested end to end in a sandbox with real PostgreSQL. **Not yet done anywhere real**: deployment to Neon/a host, EAS builds, running on physical devices, real push/e-mail delivery,
store submission, penetration test. The go-live checklist lists every such item plus the open business questions (currency, crate price, opening stock, expense classification).
