# Agent State

> Handover notebook. If a new agent starts tomorrow, this file plus `PRD.json` should be enough to continue without asking questions.
> **Update this file before you stop working.**

---

**Last updated:** 2026-10-26
**Updated by:** Arena agent session (duplicate preview + merges, correction learning, desktop shell, dashboard filters)
**Branch:** `arena/134db4ca-intelligent-data-capture-platf`
**Phase:** M1 and M2 complete; Phase 3 in progress

## Current task

The product now runs end to end: backend + desktop renderer + mobile modules + connector SDK.
`npm run verify` is green (typecheck, lint, PRD contract, OpenAPI + UDM schema + packaging contracts,
337 tests in 20 suites).

**All 45 stories are `done`.** The product described by `PRD.json` is built; the remaining work is the
deliberate release-side gaps listed below.

## What is built

| Area                                                            | Where                                  | Notes                                                                                                                                                       |
| --------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared contracts, UDM, money/dates/CSV/dedupe/i18n/review rules | `packages/shared`                      | 47 tests. `mergeRecord` reports every value it refuses to overwrite. Node-only helpers live at `@idcp/shared/ids`.                                          |
| Connector SDK + CSV, SQLite, PostgreSQL, MySQL, Google Sheets   | `packages/connectors`                  | 23 tests. `update()` is implemented for SQLite/PostgreSQL/MySQL (transactional, identifier-validated).                                                      |
| Backend API (Fastify 5)                                         | `apps/backend`                         | 161 tests. Duplicate preview, policy-aware send, correction stats and opt-in export, batches, projects, invitations, marketplace, workflows.                |
| Desktop renderer (React 19 + Vite 6)                            | `apps/desktop`                         | 55 tests. Duplicate preview card, bulk approve, device filter, live list, correction settings, Marketplace, Workflows, Electron shell + packaging contract. |
| Mobile (React Native 0.86)                                      | `apps/mobile`                          | 23 tests. Pairing scanner, capture, offline queue, review, keychain storage.                                                                                |
| CI, PRD + API contracts, generators                             | `.github/workflows/ci.yml`, `scripts/` | `validate-prd.mjs`, `validate-openapi.mjs`, `generate-udm-schema.mjs`.                                                                                      |

## How to run it

```bash
npm install
cp .env.example .env            # set JWT_SECRET (32+ chars) and STORAGE_PATH
npm run db:migrate
npm run db:seed                 # owner@example.com / demo-password-change-me
npm run dev:backend             # http://127.0.0.1:4000
npm run dev:desktop             # http://127.0.0.1:5173 (proxies /api to the backend)
```

The desktop app is the primary surface; the mobile app is paired from its "Pair a phone" dialog.

## Known gaps (deliberate, tracked in PRD.json)

1. **Installers are not built here.** The shell, IPC allow-list and keychain storage are tested
   against a stand-in Electron (`apps/desktop/test/shell.test.ts`), and the packaging contract is
   validated statically (`scripts/validate-packaging.mjs`, DEC-022). Producing and smoke-testing
   signed installers on Windows/macOS/Linux is a release-checklist item, not a code gap.
2. **The frame processor needs the worklet runtime.** The detector, its smoothing and the crop plan
   are pure and tested (`apps/mobile/src/capture/edgeDetection.ts`), and
   `frameProcessor.tsx` builds the VisionCamera processor when `react-native-worklets-core` is
   installed. That dependency is not installed here, so the overlay is inert in this sandbox — the
   capture path itself works either way.
3. **The MySQL connector is typechecked but not exercised against a live server** (no MySQL in this
   sandbox). Its SQL is covered by validation tests only; the Postgres and SQLite paths run for real.
4. **Realtime transport is authenticated SSE**, not Socket.IO. The `RealtimeHub` interface keeps the
   transport swappable; the Socket.IO adapter is not written (see DECISIONS.md DEC-016).
5. **Batch upload reads files into memory** before storing them; with the 100-file cap and the
   20 MB per-file limit that is bounded, but a streaming batch importer would be the next step.
6. **Analytics** is now a 14-day (up to 90) SVG chart plus CSV export (`DASH-001` done). There are no
   saved/custom dashboards, and the 2-second target is asserted by design (bounded window, indexed
   query), not by a load test.
7. **Localisation is complete** (I18N-001, DEC-028): 577 keys, 100% coverage in `en`, `sw` and `fr`,
   `Intl` formatting, and a direction-aware layout. No RTL language ships yet, so RTL is verified by
   the direction helper and the logical-property test rather than by a real RTL catalogue.
8. **Three environments' worth of connectors are not exercised against live servers**: MySQL, Postgres
   and Google Sheets have no server in this sandbox. Their SQL/HTTP is covered by validation tests
   and the SQLite path runs for real.
9. **`node_modules` is no longer tracked.** It was committed at the start (22,706 files); this round
   untracked it in one deliberate commit. Installs now come from `package-lock.json`.
10. **Workflows cannot branch.** A rule is one AND-list of conditions over the extracted fields and
    `notify` records an output rather than delivering a message (no mail transport here). See DEC-026.
11. **Speech needs native modules.** `@react-native-voice/voice` and `react-native-tts` are not
    installed here, so `assist/speechPlatform.ts` reports speech as unavailable and the screens stay
    button-only; the consent gate, phrase book and guidance logic are pure and tested (DEC-027).
12. **Open decisions**: AI provider/budget (Q-001), licensing (Q-002), hosting region (Q-003),
    standalone desktop mode (Q-004).

## Next actions, in order

1. Release checklist: sign and smoke-test installers on Windows/macOS/Linux (DEC-022).
2. Exercise the MySQL, Postgres and Google Sheets connectors against live servers.
3. Add the Socket.IO adapter behind the existing `RealtimeHub` interface (DEC-016).

## Environment facts worth knowing

- No PostgreSQL, Redis or Docker in the sandbox; `DB_DRIVER=sqlite` (`node:sqlite`) is the tested
  path and `pg` is the production path (DEC-013).
- Jest cannot load Fastify's `inject()` here (ESM-only `cookie` dependency), so the backend suite
  starts a real listener on an ephemeral port. Do not reintroduce `app.inject()`.
- `@idcp/shared` must not re-export `ids.ts` (Node-only); use `@idcp/shared/ids` in the backend.
