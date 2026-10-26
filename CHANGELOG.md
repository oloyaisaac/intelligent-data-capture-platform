# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [Semantic Versioning](https://semver.org/).
Dates are ISO-8601 (`YYYY-MM-DD`). Story IDs refer to `PRD.json`.

## [Unreleased]

### Added

- **Monorepo and tooling** — npm workspaces (`apps/*`, `packages/*`), a strict TypeScript baseline
  with path aliases, Jest projects for every workspace, ESLint 9 (flat config) and Prettier
  (`FOUND-003`, `FOUND-004`).
- **CI** — typecheck, lint, formatting, PRD contract, OpenAPI contract, tests and a renderer build,
  plus a job that fails when secret material is committed (`FOUND-005`).
- **Shared package** — Universal Data Model with validation, money/date/CSV helpers, duplicate
  detection, i18n catalogues, review rules and wire contracts shared by all three apps (`UDM-001`).
- **Backend** — Fastify 5 API over SQLite or PostgreSQL: auth with refresh rotation, QR pairing with
  single-use tokens, device credentials, document upload with content sniffing and idempotency,
  background job queue with retry/backoff, review workflow, Excel/CSV export, connectors, audit
  trail, retention purge, analytics counters (`BACK-001`, `DB-001`, `AUTH-001`, `AUTH-002`,
  `PAIR-001`–`PAIR-004`, `DOC-001`, `AUDIT-001`, `SEC-001`).
- **AI pipeline** — OCR provider abstraction (Tesseract locally, cloud adapter), document
  classification, field/table extraction with per-field confidence, and template-driven expected
  fields (`AI-001`–`AI-004`).
- **Connector SDK** — CSV, SQLite, PostgreSQL and Google Sheets destinations with a stable plugin
  contract, field mapping, transforms and duplicate policy (`CON-001`–`CON-003`, `MAP-001`,
  `DUP-001`).
- **Desktop app** — React 19 + Vite renderer: live dashboard over authenticated SSE, document
  list with filters, review workspace (risky fields first, one-click editing), templates with
  versioning, connectors, exports, device pairing with a QR code, organisation/team/audit/API key
  settings; Electron main + preload with allow-listed IPC and keychain-backed tokens
  (`DESK-001`, `DESK-002`, `REV-001`, `TPL-001`, `DEVAPI-001`).
- **Mobile app** — pairing scanner, camera capture, offline-first upload queue with exponential
  backoff and idempotency keys, review screen and keychain storage (`MOB-001`, `MOB-003`,
  `PAIR-002`).
- **Contracts in CI** — `scripts/validate-prd.mjs` (PRD integrity), `scripts/validate-openapi.mjs`
  (OpenAPI 3.1, cross-checked against the registered routes) and `scripts/generate-udm-schema.mjs`
  (UDM JSON Schema generated from the zod schema, checked for staleness).
- **Batches** — upload up to 100 files in one request; every file becomes its own document, a file
  that cannot be read is reported as a failed item instead of failing the batch, progress is derived
  from the documents, and per-item results export as CSV (`BATCH-001`).
- **Projects and invitations** — projects group documents and batches inside an organisation;
  invitations are expiring and single-use (only the SHA-256 of the token is stored) and are accepted
  from a dedicated screen that sets the password and signs the person in (`TEAM-001`).
- **MySQL connector** — first-class MySQL/MariaDB destination alongside PostgreSQL and SQLite, with
  schema introspection, transactional inserts and identifier validation (`CON-003`).
- **Desktop** — Batches page (multi-file upload with live per-item results) and Projects page; the
  team settings now show the invitation link once, because this deployment sends no email.
- **Analytics dashboard** — `/stats` now returns status counts, document-type mix and a daily
  series (1–90 days, default 14) computed from the documents themselves; the desktop draws it as an
  accessible SVG bar chart plus a status mix bar, and the figures download as CSV (`DASH-001`).
- **Capture pipeline on mobile** — crop to the detected page, contrast pass, downscale to 1600 px
  and JPEG compression under a byte budget, all decided by pure functions and applied through an
  injected transformer; a step that is unavailable leaves the capture intact (`MOB-002`).
- **Runtime language switch** — navigation and settings are translated from the shared `en/sw/fr`
  catalogues, with the choice remembered per device (`I18N-001` in progress).
- 17 suites; the count of automated tests is tracked in `TESTING.md`.

### Changed

- `PRD.json` statuses and artifact paths now reflect the code (42 stories have code; see the file
  for the remaining `pending` items).

### Fixed

- Connector configuration errors returned 500 instead of 400; `validateConfig()` failures are now
  mapped to a bad request.
- Content sniffing rejected valid JPEGs shorter than 12 bytes; each format now has its own minimum.
- Table extraction coerced text cells containing digits ("Cement 50kg bags") into numbers.
- Connector `date_iso` transform failed on `DD/MM/YYYY`; it now uses the shared date parser.

### Security

- Device and API-key credentials are hashed at rest (SHA-256) and never returned by the API;
  connector credentials are encrypted with AES-256-GCM.
- Audit records are append-only, enforced by database triggers as well as by code.
- API keys are bounded by scopes _and_ by the live role of the person who created them.
- Uploads are verified by content, size-capped, served with `nosniff` and never from a public URL.

---

## [0.1.0] — 2026-10-26

Project documentation bootstrap. No application code yet.

### Added

- `PRD.json` — master plan: vision, target users, 3 milestones, 15 epics, 45 stories with dependencies, acceptance criteria and statuses, plus `definitionOfDone` and open questions (`FOUND-002`).
- `REQUIREMENTS.md` — business, user, functional, non-functional, security, payment and hosting requirements with traceability to stories.
- `README.md` — project overview, feature status, architecture diagram, technology table, repository structure, getting started, documentation index and roadmap.
- `AI.md` — behavioural rules for AI coding agents: startup ritual, hard rules, working loop, status vocabulary, definition of done, coding conventions, security non-negotiables and stop conditions.
- `AGENT_STATE.md` — handover notes covering what is complete, known gaps and the next action.
- `TASKS.md` — short-term queue split into Now / Next / Later / Blocked.
- `DECISIONS.md` — 12 recorded architecture decisions (DEC-001 … DEC-012).
- `ARCHITECTURE.md` — component map, data flows, security zones, technology choices and target repository layout.
- `DATABASE.md` — entity relationship overview, table definitions, indexes, UDM storage and retention model.
- `API.md` — conventions, error envelope, REST endpoints per area, realtime socket events and webhook outline.
- `TESTING.md` — test pyramid, tooling, commands and manual test cases for pairing, capture, extraction, review and export.
- `SECURITY.md` — threat model, secrets policy, authentication/authorisation, data handling, upload safety, audit and incident response.
- `DEPLOYMENT.md` — environments, infrastructure, environment variables, build and release process, backups and rollback.
- `ENVIRONMENT.md` — required tooling with installed versions, setup steps and troubleshooting.
- `CONTRIBUTING.md` — branch naming, commit convention, PR checklist, review process and coding standards.
- `LICENSE` — proprietary placeholder notice pending owner confirmation.
- `.env.example` — every configuration key with safe placeholder values.

### Changed

- `.gitignore` — replaced the UTF-16 encoded file that contained only `node_modules` with a UTF-8 file covering dependencies, environment/secrets, build output, native build artefacts, test coverage and local storage.

### Fixed

- `.gitignore` was encoded as UTF-16 with a BOM, which prevented Git from reliably parsing patterns; it is now plain UTF-8.

### Security

- Documented the secrets policy in `SECURITY.md` and added all `.env*` variants to `.gitignore` (except `.env.example`).
- Confirmed `.env.example` contains placeholders only — no real credentials.

---

## [0.0.1] — 2026-10-26

### Added

- Initial commit: `package.json` and `package-lock.json` with the React Native baseline (react-native 0.86.2, react 19.2.8, React Navigation 7, socket.io-client 4.8.3, `@types/jest`).
- Source product documents in `uploads/PRD.md` and `uploads/requirements-1.md`.
