# Go-live checklist

Tick every box in **staging** first, then production. Items marked ⚠ have never been executed by the builders (they need accounts or hardware).

## Business decisions still open (defaults are in the code; confirm or change)
- [ ] Currency label and the crate price (not in the workbook; an administrator sets prices in Admin → Prices; `sales.creditEnabled` is off by default).
- [ ] Opening egg stock (the workbook’s stock ledger is short by 17,123 eggs — see Phase 1/5 docs); enter a counted opening stock as an OPENING ledger entry.
- [ ] Classification of the workbook’s “Misc” and “Loan” expenses (imported flagged “needs review”).
- [ ] Which staff get which roles; who is the Super Admin; backup owner for `DATA_ENCRYPTION_KEY`.
- [ ] Notification thresholds and reminder times (Admin → Notification rules).
- [ ] Expense approval workflow and receipt photos are **not built**; decide if they are required for launch.

## Infrastructure
- [ ] ⚠ Neon staging + production projects, roles, pooled/direct URLs, `app_role.sql` applied
- [ ] ⚠ Host chosen; API deployed from the release tag and running; TLS certificate valid; `/health/ready` green
- [ ] ⚠ Secrets set (unique per environment) and stored in a password manager; `APP_ENV=production` boots (it refuses weak/insecure config)
- [ ] ⚠ Brevo verified (sender verified in Brevo, domain authenticated with SPF/DKIM; send an invitation to yourself and check it arrives, not in spam)
- [ ] ⚠ Daily `backup.sh` scheduled, copied off-provider, **restore drill passed on a real dump**
- [ ] ⚠ Uptime monitor + alert rules from `monitoring-and-incident-response.md`
- [ ] Excel import: dry run reviewed, reconciliation report signed off by the owner, then imported once

## Application
- [ ] Super Admin bootstrapped, MFA enrolled, recovery codes stored offline
- [ ] Staff invited with least-privilege roles; owners/admins have MFA
- [ ] Prices set; coops and shifts correct; low-stock threshold set
- [ ] Reports reconcile with the last month of the Excel workbook (compare totals with the owner)
- [ ] `GET /v1/audit/verify` → intact; `GET /v1/inventory/reconciliation` → consistent

## Mobile (`docs/mobile/release-eas.md`)
- [ ] ⚠ EAS project created; `extra.eas.projectId`, API URLs, bundle ids set; FCM + APNs credentials uploaded
- [ ] ⚠ Preview build installed on real Android **and** iOS devices; test: sign-in + MFA, record production offline in airplane mode then reconnect, sale + payment, report PDF share, push test (Settings → Notifications), biometric lock, sign-out with unsent records
- [ ] ⚠ Store listings, privacy policy URL, data-safety/privacy answers (`release-eas.md`), screenshots
- [ ] ⚠ Accessibility pass (TalkBack/VoiceOver, large fonts, dark mode) on a device

## Security (`docs/security/security-review.md`)
- [ ] Residual-risk list reviewed and accepted by the owner
- [ ] Consider an external penetration test before storing real financial data at scale
