# Agent State

> Handover notebook. If a new agent starts tomorrow, this file plus `PRD.json` should be enough to continue without asking questions.
> **Update this file before you stop working.**

---

**Last updated:** 2026-10-26
**Updated by:** Arena agent session (duplicate preview + merges, correction learning, desktop shell, dashboard filters)
**Branch:** `arena/55dc62bf-intelligent-data-capture-platf`
**Phase:** M1 and M2 complete; Phase 3 in progress

## Current task

The product now runs end to end: backend + desktop renderer + mobile modules + connector SDK.
`npm run verify` is green (typecheck, lint, PRD contract, OpenAPI + UDM schema + packaging contracts,
293 tests in 18 suites).

41 of 45 stories are `done`. The remaining ones are `I18N-001` (translation sweep of the desktop page
bodies) and the Phase 3 tail: `MARKET-001`, `AGENT-001`, `VOICE-001`.

## What is built

| Area                                                            | Where                                  | Notes                                                                                                                               |
| --------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Shared contracts, UDM, money/dates/CSV/dedupe/i18n/review rules | `packages/shared`                      | 47 tests. `mergeRecord` reports every value it refuses to overwrite. Node-only helpers live at `@idcp/shared/ids`.                  |
| Connector SDK + CSV, SQLite, PostgreSQL, MySQL, Google Sheets   | `packages/connectors`                  | 23 tests. `update()` is implemented for SQLite/PostgreSQL/MySQL (transactional, identifier-validated).                              |
| Backend API (Fastify 5)                                         | `apps/backend`                         | 143 tests. Duplicate preview, policy-aware send, correction stats and opt-in export, batches, projects, invitations.                |
| Desktop renderer (React 19 + Vite 6)                            | `apps/desktop`                         | 41 tests. Duplicate preview card, bulk approve, device filter, live list, correction settings, Electron shell + packaging contract. |
| Mobile (React Native 0.86)                                      | `apps/mobile`                          | 23 tests. Pairing scanner, capture, offline queue, review, keychain storage.                                                        |
| CI, PRD + API contracts, generators                             | `.github/workflows/ci.yml`, `scripts/` | `validate-prd.mjs`, `validate-openapi.mjs`, `generate-udm-schema.mjs`.                                                              |

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
7. **Language switch works at runtime** (desktop navigation and settings, mobile screens) and both
   `sw` and `fr` cover ~49% of the catalogue with English fallback. The desktop page _bodies_ are
   still English string literals, so `I18N-001` stays `in_progress`; the remaining work is a
   mechanical sweep, not new plumbing.
8. **Three environments' worth of connectors are not exercised against live servers**: MySQL, Postgres
   and Google Sheets have no server in this sandbox. Their SQL/HTTP is covered by validation tests
   and the SQLite path runs for real.
9. **`node_modules` is no longer tracked.** It was committed at the start (22,706 files); this round
   untracked it in one deliberate commit. Installs now come from `package-lock.json`.
10. **Open decisions**: AI provider/budget (Q-001), licensing (Q-002), hosting region (Q-003),
    standalone desktop mode (Q-004).

## Next actions, in order

1. `MARKET-001` — connector marketplace with permission disclosure and rollback.
2. `AGENT-001` — workflow rules with run logs and an approval policy for destructive actions.
3. `VOICE-001` — hands-free guidance and voice commands, with consent gates.
4. `I18N-001` — sweep the remaining English literals in the desktop page bodies.

## Environment facts worth knowing

- No PostgreSQL, Redis or Docker in the sandbox; `DB_DRIVER=sqlite` (`node:sqlite`) is the tested
  path and `pg` is the production path (DEC-013).
- Jest cannot load Fastify's `inject()` here (ESM-only `cookie` dependency), so the backend suite
  starts a real listener on an ephemeral port. Do not reintroduce `app.inject()`.
- `@idcp/shared` must not re-export `ids.ts` (Node-only); use `@idcp/shared/ids` in the backend.
