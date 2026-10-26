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

- [ ] **DASH-001** — replace the counters view with charts over `/stats`, plus an exportable summary.

## Next

- [ ] **MOB-002** — crop, enhance and compress before a capture is queued.
- [ ] **DESK-001 (packaging)** — electron-builder targets and a signed installer, verified on
      Windows/macOS/Linux.
- [ ] **I18N-001** — route UI copy through the `en/sw/fr` catalogues and add a language switch.

## Later (Phase 3)

- [ ] `CRM-001` — CRM export targets
- [ ] `MARKET-001` — template marketplace
- [ ] `AGENT-001` — workflow automation
- [ ] `VOICE-001` — voice-assisted field entry
- [ ] Socket.IO transport alongside SSE (DEC-016)
