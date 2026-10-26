# Agent State

> Handover notebook. If a new agent starts tomorrow, this file plus `PRD.json` should be enough to continue without asking questions.
> **Update this file before you stop working.**

---

**Last updated:** 2026-10-26
**Updated by:** Arena agent session (full vertical slice implementation)
**Branch:** `arena/fa626bd2-intelligent-data-capture-platf`
**Phase:** M1 complete, M2 in progress

## Current task

The product now runs end to end: backend + desktop renderer + mobile modules + connector SDK.
`npm run verify` is green (typecheck, lint, PRD contract, OpenAPI + UDM schema contract, 213 tests
in 14 suites).

Nothing is half-finished in code. The remaining work is the "should/could" tail (see
`PRD.json`): batch processing, MySQL connector, projects, marketplace, workflows, voice and the
richer analytics views.

## What is built

| Area                                                              | Where                                  | Notes                                                                                                                                                 |
| ----------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared contracts, UDM, money/dates/CSV/dedupe/i18n/review rules   | `packages/shared`                      | 44 tests. Node-only helpers live in `@idcp/shared/ids` so React Native never pulls `node:crypto`.                                                     |
| Connector SDK + CSV, SQLite, PostgreSQL, Google Sheets connectors | `packages/connectors`                  | 20 tests. `applyMapping()` returns `{ values, missingRequired }`.                                                                                     |
| Backend API (Fastify 5)                                           | `apps/backend`                         | 116 tests. SQLite in dev/test, PostgreSQL in production, real listener + `fetch` in tests.                                                            |
| Desktop renderer (React 19 + Vite 6)                              | `apps/desktop`                         | 16 tests. Hash routing, SSE dashboard, review workspace, templates, connectors, exports, devices, settings. Electron main/preload written (see gaps). |
| Mobile (React Native 0.86)                                        | `apps/mobile`                          | 17 tests. Pairing scanner, capture, offline queue, review, keychain storage.                                                                          |
| CI, PRD + API contracts, generators                               | `.github/workflows/ci.yml`, `scripts/` | `validate-prd.mjs`, `validate-openapi.mjs`, `generate-udm-schema.mjs`.                                                                                |

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
2. **Mobile capture has no crop/enhance/compress step** (`MOB-002` `in_progress`). Capture itself,
   queuing and offline behaviour are done.
3. **MySQL connector is not implemented** (SQLite + PostgreSQL are): `CON-003` `in_progress`.
4. **Realtime transport is authenticated SSE**, not Socket.IO. The `RealtimeHub` interface keeps the
   transport swappable; the Socket.IO adapter is not written (see DECISIONS.md DEC-016).
5. **No batch API** (`BATCH-001` pending): documents process individually through the job queue.
6. **No projects inside an organisation, and invitations do not yet expire** (`TEAM-001` in
   `in_progress`); roles, invites and per-organisation isolation are done.
7. **Analytics is a counters view**, not charts (`DASH-001` in_progress).
8. **UI copy is English**; the i18n catalogues exist for `en/sw/fr` (`I18N-001` in_progress).
9. **`node_modules` is tracked in Git** from the first commit (22k files). It is ignored now, but
   untracking it should be a separate, deliberate commit — do not mix it with feature work.
10. **Open decisions**: AI provider/budget (Q-001), licensing (Q-002), hosting region (Q-003),
    standalone desktop mode (Q-004).

## Next actions, in order

1. `BATCH-001` — batch upload + progress, reusing the job queue and export pipeline.
2. `CON-003` — MySQL connector (mirror `postgres-connector.ts`, swap the driver).
3. `TEAM-001` — projects + expiring, single-use invitation tokens.
4. `DASH-001` — charts and exportable figures over the existing `/stats` data.
5. `MOB-002` — crop/enhance/compress before queuing.
6. Package the desktop app (electron-builder) and verify on Windows/macOS/Linux.

## Environment facts worth knowing

- No PostgreSQL, Redis or Docker in the sandbox; `DB_DRIVER=sqlite` (`node:sqlite`) is the tested
  path and `pg` is the production path (DEC-013).
- Jest cannot load Fastify's `inject()` here (ESM-only `cookie` dependency), so the backend suite
  starts a real listener on an ephemeral port. Do not reintroduce `app.inject()`.
- `@idcp/shared` must not re-export `ids.ts` (Node-only); use `@idcp/shared/ids` in the backend.
