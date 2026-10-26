# Agent State

> Handover notebook. If a new agent starts tomorrow, this file plus `PRD.json` should be enough to continue without asking questions.
> **Update this file before you stop working.**

---

**Last updated:** 2026-10-26
**Updated by:** Arena agent session (batches, projects, invitations, MySQL)
**Branch:** `arena/55dc62bf-intelligent-data-capture-platf`
**Phase:** M1 complete, M2 in progress

## Current task

The product now runs end to end: backend + desktop renderer + mobile modules + connector SDK.
`npm run verify` is green (typecheck, lint, PRD contract, OpenAPI + UDM schema contract, 252 tests
in 17 suites).

The remaining work is the "should/could" tail (see `PRD.json`): CRM/marketplace/workflow/voice
stories, desktop packaging, and finishing the translation sweep of the desktop page bodies.

## What is built

| Area                                                            | Where                                  | Notes                                                                                                                                                 |
| --------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared contracts, UDM, money/dates/CSV/dedupe/i18n/review rules | `packages/shared`                      | 44 tests. Node-only helpers live at `@idcp/shared/ids` so React Native never pulls `node:crypto`.                                                     |
| Connector SDK + CSV, SQLite, PostgreSQL, MySQL, Google Sheets   | `packages/connectors`                  | 21 tests. MySQL has its own plugin (`?` placeholders, `DATABASE()` introspection, quoted identifiers).                                                |
| Backend API (Fastify 5)                                         | `apps/backend`                         | 132 tests. Batches, projects, hashed single-use invitations, SQLite in dev/test, PostgreSQL in production.                                            |
| Desktop renderer (React 19 + Vite 6)                            | `apps/desktop`                         | 20 tests. Hash routing, SSE dashboard, review workspace, templates, connectors, exports, devices, settings. Electron main/preload written (see gaps). |
| Mobile (React Native 0.86)                                      | `apps/mobile`                          | 17 tests. Pairing scanner, capture, offline queue, review, keychain storage.                                                                          |
| CI, PRD + API contracts, generators                             | `.github/workflows/ci.yml`, `scripts/` | `validate-prd.mjs`, `validate-openapi.mjs`, `generate-udm-schema.mjs`.                                                                                |

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

1. **Electron packaging is not verified.** `apps/desktop/src/main/electron-main.ts` and
   `preload.ts` are complete and typechecked, but the `electron` binary is not a dependency of this
   environment, so no installer was produced or launched (`DESK-001` stays `in_progress`).
   `IDCP_AUTO_UPDATE=off` disables update checks; the update check is a no-op stub.
2. **Mobile capture crops, enhances and compresses through pure planning functions**
   (`apps/mobile/src/capture/imagePipeline.ts`), but the _quad_ they crop to must be supplied by the
   caller: no VisionCamera frame processor is installed, so automatic edge detection is not wired.
   `MOB-002` stays `in_progress` until that overlay feeds it.
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
8. **`node_modules` is tracked in Git** from the first commit (22k files). It is ignored now, but
   untracking it should be a separate, deliberate commit — do not mix it with feature work.
9. **Open decisions**: AI provider/budget (Q-001), licensing (Q-002), hosting region (Q-003),
   standalone desktop mode (Q-004).

## Next actions, in order

1. `DASH-001` — charts and exportable figures over the existing `/stats` data.
2. `MOB-002` — crop/enhance/compress before queuing.
3. Package the desktop app (electron-builder) and verify on Windows/macOS/Linux.
4. `I18N-001` — route UI copy through the `en/sw/fr` catalogues.
5. `CRM-001`, `MARKET-001`, `AGENT-001`, `VOICE-001` — the Phase 3 tail.

## Environment facts worth knowing

- No PostgreSQL, Redis or Docker in the sandbox; `DB_DRIVER=sqlite` (`node:sqlite`) is the tested
  path and `pg` is the production path (DEC-013).
- Jest cannot load Fastify's `inject()` here (ESM-only `cookie` dependency), so the backend suite
  starts a real listener on an ephemeral port. Do not reintroduce `app.inject()`.
- `@idcp/shared` must not re-export `ids.ts` (Node-only); use `@idcp/shared/ids` in the backend.
