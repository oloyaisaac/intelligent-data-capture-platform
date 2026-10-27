# Tasks

Short-term work queue. `PRD.json` is the complete project; this file is what we are doing **now**.
Story IDs refer to `PRD.json`. Keep this list short and honest.

**Last updated:** 2026-10-26

---

## Done (this milestone)

M0 and M1 are complete, and these M2 stories are now done too:

- [x] **BACK-001 / DB-001 / AUTH-001 / AUTH-002** — API skeleton, schema + migrations, Argon2id auth
      with rotating refresh tokens, RBAC and tenant scoping.
- [x] **UDM-001 / AI-001–AI-004** — Universal Data Model, OCR abstraction, classification,
      field/table extraction with per-field confidence, templates.
- [x] **PAIR-001–PAIR-004** — QR pairing, device credentials, revocation.
- [x] **DOC-001 / REV-001 / EXPORT-001 / EXPORT-002** — upload with sniffing + idempotency, review
      workflow, Excel/CSV export.
- [x] **CON-001–CON-003 / MAP-001 / DUP-001** — connector SDK with CSV, SQLite, PostgreSQL, MySQL and
      Google Sheets destinations, mapping profiles and duplicate policy.
- [x] **DESK-001 / DEVAPI-001** — desktop renderer (dashboard over SSE, documents, review, templates,
      connectors, exports, devices, settings) and developer API keys.
- [x] **BATCH-001** — batch upload with partial-failure handling, derived progress and CSV results.
- [x] **TEAM-001** — projects and expiring, single-use hashed invitation links.

## Now

Nothing open: all 45 stories in `PRD.json` are `done`. The last round was a documentation audit, not
new features — `.env.example` was unusable, `DATABASE.md` claimed the schema was unimplemented, and
`DECISIONS.md` was missing DEC-013, which several documents cited. All three are fixed and
`apps/backend/test/config.test.ts` now fails if the environment file and the config schema drift.

## Done this round

- [x] **DUP-001** — side-effect-free duplicate preview and policy-aware send (`skip`/`update`/`merge`/`append`).
- [x] **REV-002** — document type on every correction, aggregate stats, opt-in training export.
- [x] **DESK-001** — allow-listed IPC, keychain token file, sandboxed renderer, packaging targets.
- [x] **DESK-002** — device filter, live document list, bulk approve with a skipped report.
- [x] **MOB-002** — automatic page detection, EXIF orientation, crop, enhancement and compression.
- [x] **CRM-001** — HubSpot, Odoo and QuickBooks adapters with a shared HTTP transport.
- [x] **MARKET-001** — signed connector catalogue, permission disclosure and rollback.
- [x] **AGENT-001** — workflow rules with a run log; destructive actions wait for per-run approval.
- [x] **VOICE-001** — offline capture guidance, consented spoken commands, per-run confirmations.
- [x] **I18N-001** — one complete `en/sw/fr` catalogue, locale-aware formatting, logical-property RTL.
- [x] **SEC-001** — retention now runs by itself: `MaintenanceService` sweeps documents past
      `retention_days`, expired exports, sessions, reset tokens and pairing codes on an interval
      (`DEC-031`, `test/maintenance.test.ts`).
- [x] **Password recovery and session control** — forgot/reset/change password, list and revoke
      sessions, sign out everywhere (`DEC-030`, `test/auth-recovery.test.ts`).
- [x] **Data-subject rights** — `GET /me/export` and `POST /me/erase`, wired to the desktop Account page.
- [x] **Legal pack** — privacy policy, terms, DPA, sub-processor list and security summary under
      `legal/`, published at `GET /legal/{slug}` and checked by `npm run test:legal`.
- [x] **Web hardening** — security headers on every response and a structured access log.

## Now (product)

One acceptance criterion is unmet, recorded as a `verification` block in `PRD.json`:

- [ ] **CON-002 OAuth**: consent flow + encrypted refresh token + refresh before a Sheets run. Until
      then a Sheets destination works for about an hour per pasted token.

## Now (operations)

Deployment work, not product stories. The full table with consequences is `DEPLOYMENT.md` §11.

- [x] Re-queue jobs stranded in `running` by a crash or redeploy, so a document cannot sit in
      `processing` forever (`test/worker-recovery.test.ts`).
- [ ] Container image (`Dockerfile`) + publish step, so the documented pipeline can run.
- [ ] `npm run db:backup` (`VACUUM INTO`) and a rehearsed restore for SQLite.
- [x] Scheduled retention purge, expired-export deletion and session sweep (`MaintenanceService`).
- [ ] `/metrics` (queue depth, job outcomes, latency) — the access log now exists, the metrics do not.
- [x] Security headers.
- [ ] A configurable `trustProxy`: `trustProxy` is currently always on, which is right behind the
      documented reverse proxy and wrong if the API is exposed directly.
- [ ] Dependency audit gate in CI — needs the `zod` v3 → v4 migration first (8 advisories, 1 critical).

## Later (Phase 3)

- [ ] Sign and smoke-test installers on Windows, macOS and Linux (DEC-022).
- [ ] Run the connectors and the backend against live MySQL, PostgreSQL and Google Sheets.
- [ ] Implement the `s3` storage adapter; `STORAGE_DRIVER=s3` fails fast today.
- [ ] Socket.IO transport alongside SSE (DEC-016), behind the same `RealtimeHub`.
- [ ] One end-to-end test (Playwright for the renderer; Detox or Maestro for mobile).
