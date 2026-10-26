# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [Semantic Versioning](https://semver.org/).
Dates are ISO-8601 (`YYYY-MM-DD`). Story IDs refer to `PRD.json`.

## [Unreleased]

### Added
- Nothing yet. Next expected entries: monorepo scaffolding (`FOUND-003`), lint/test harness (`FOUND-004`), backend skeleton (`BACK-001`).

### Changed

### Fixed

### Security

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
