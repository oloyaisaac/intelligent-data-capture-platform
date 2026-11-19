# Agent State

> **Historical snapshot, 2026-10-27:** the handover below predates subsequent remediation and is
> retained for context, not as current release status. It contains stale branch/test counts and
> claims about container builds, backup, audit, batch streaming, mail and localisation. See
> [`TASKS.md`](TASKS.md), [`ARCHITECTURE.md`](ARCHITECTURE.md),
> [`docs/reviewers/evidence/R01/`](docs/reviewers/evidence/R01/) and current CI for present
> evidence and blockers. The original story statuses are not proof of UAT or release readiness.

> Handover notebook. If a new agent starts tomorrow, this file plus `PRD.json` should be enough to continue without asking questions.
> **Update this file before you stop working.**

---

**Last updated:** 2026-10-27
**Updated by:** Arena agent session (hardening pass II: multi-factor authentication)
**Branch:** `arena/714e772e-intelligent-data-capture-platf`
**Phase:** M1 and M2 complete; Phase 3 in progress

## Current task

The product now runs end to end: backend + desktop renderer + mobile modules + connector SDK.
`npm run verify` is green (typecheck, lint, PRD contract, OpenAPI + UDM schema + packaging contracts,
legal pack contract, 406 tests in 30 suites).

The last two rounds were hardening passes, prompted by "would a customer actually be able to use
this?" The product was feature-complete but not deployable as a business: no privacy policy or terms,
no password recovery, no way to sign out of a lost device, no data-subject export or erasure, and
nothing that enforced the retention periods `SECURITY.md` promised. That pass added `legal/`,
`DEC-030` (password reset), `DEC-031` (maintenance scheduler), `DEC-032` (provable terms acceptance),
`DEC-033` (`TRUST_PROXY`), `GET /me/export`, `POST /me/erase`, security headers and an access log.
The second pass closed the last security-review blocker — passwords were the only factor — with TOTP
multi-factor authentication (`DEC-034`): enrolment, a five-minute login challenge, ten single-use
recovery codes stored as hashes, password-plus-code disable, and an Account-page section to manage
it. `AUDIT-2026-10.md` records what was found, what changed and the residual risk with an owner for
each item. Read that file before promising anything to a buyer.

**All 45 stories are `done`.** The product described by `PRD.json` is built; the remaining work is the
deliberate release-side gaps listed below.

"Done" does not mean "measured". Eleven stories carry a `verification` block in `PRD.json` naming the
acceptance criterion that is asserted rather than demonstrated — unmeasured performance targets, no
native build, no live Google Sheets run, no labelled classification benchmark, an operator-run
retention purge, forward-only migrations, no RTL locale. `npm run test:prd` fails if a block is empty,
and `TESTING.md` §3.1 explains what each kind means. Check that block before repeating a claim from
the PRD. **The one real functional hole it records is `CON-002`**: there is no OAuth flow and no token
refresh, so a Google Sheets destination needs a bearer token pasted in and stops working when it
expires.

The most recent code change is operational: a job left `running` by a crashed or redeployed process
used to strand its document in `processing` forever, because nothing ever moved a claimed job out of
`running`. The worker now re-queues anything claimed more than 30 s before it started
(`JobsRepository.requeueStale`, `RECOVERY_GRACE_MS`), tested in `test/worker-recovery.test.ts`.

## What is built

| Area                                                            | Where                                  | Notes                                                                                                                                                       |
| --------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared contracts, UDM, money/dates/CSV/dedupe/i18n/review rules | `packages/shared`                      | 49 tests. `mergeRecord` reports every value it refuses to overwrite. Node-only helpers live at `@idcp/shared/ids`.                                          |
| Connector SDK + CSV, SQLite, PostgreSQL, MySQL, Google Sheets   | `packages/connectors`                  | 29 tests. `update()` is implemented for SQLite/PostgreSQL/MySQL (transactional, identifier-validated).                                                      |
| Backend API (Fastify 5)                                         | `apps/backend`                         | 218 tests. Duplicate preview, policy-aware send, correction stats and opt-in export, batches, projects, invitations, marketplace, workflows.                |
| Desktop renderer (React 19 + Vite 6)                            | `apps/desktop`                         | 65 tests. Duplicate preview card, bulk approve, device filter, live list, correction settings, Marketplace, Workflows, Electron shell + packaging contract. |
| Mobile (React Native 0.86)                                      | `apps/mobile`                          | 45 tests. Pairing scanner, capture, offline queue, review, keychain storage.                                                                                |
| CI, PRD + API contracts, generators                             | `.github/workflows/ci.yml`, `scripts/` | `validate-prd.mjs`, `validate-openapi.mjs`, `generate-udm-schema.mjs`, `validate-packaging.mjs`, plus `config.test.ts` guarding `.env.example`.             |

## How to run it

```bash
npm install
npm run db:migrate
npm run db:seed                 # owner@example.com / demo-password-change-me
npm run dev:backend             # http://127.0.0.1:4000
npm run dev:desktop             # http://127.0.0.1:5173 (proxies /api to the backend)
```

No `.env` is needed: the defaults are SQLite at `./local-storage/idcp.db`, filesystem storage at
`./local-storage/documents`, local OCR and port 4000. Copy `.env.example` only to change something —
every key it lists is one the server reads, with its default in brackets.

The desktop app is the primary surface; the mobile app is paired from its "Pair a phone" dialog.
Health check: `GET /api/v1/health` (there is no bare `/health`).

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
3. **Realtime transport is authenticated SSE**, not Socket.IO. The `RealtimeHub` interface keeps the
   transport swappable; the Socket.IO adapter is not written (see DECISIONS.md DEC-016).
4. **Batch upload reads files into memory** before storing them; with the 100-file cap and the
   20 MB per-file limit that is bounded, but a streaming batch importer would be the next step.
5. **Analytics** is now a 14-day (up to 90) SVG chart plus CSV export (`DASH-001` done). There are no
   saved/custom dashboards, and the 2-second target is asserted by design (bounded window, indexed
   query), not by a load test.
6. **Localisation is complete** (I18N-001, DEC-028): 647 keys, 100% coverage in `en`, `sw` and `fr`,
   `Intl` formatting, and a direction-aware layout. No RTL language ships yet, so RTL is verified by
   the direction helper and the logical-property test rather than by a real RTL catalogue.
7. **Three destinations are not exercised against live servers**: MySQL, Postgres and Google Sheets
   have no server in this sandbox. Their SQL/HTTP is covered by validation tests and the SQLite path
   runs for real.
8. **`node_modules` is no longer tracked.** It was committed at the start (22,706 files); this round
   untracked it in one deliberate commit. Installs now come from `package-lock.json`.
9. **Workflows cannot branch.** A rule is one AND-list of conditions over the extracted fields and
   `notify` records an output rather than delivering a message (no mail transport here). See DEC-026.
10. **Storage and realtime have one driver each.** `STORAGE_DRIVER=s3` is validated by the config
    schema and then refused at startup with a clear error; there is no S3 adapter, and documents in
    the shipped runtime live on the filesystem (`STORAGE_PATH`, DEC-029). `/events` returns `501`
    for a non-SSE hub, so nothing silently pretends a transport exists.
11. **Speech needs native modules.** `@react-native-voice/voice` and `react-native-tts` are not
    installed here, so `assist/speechPlatform.ts` reports speech as unavailable and the screens stay
    button-only; the consent gate, phrase book and guidance logic are pure and tested (DEC-027).
12. **Open decisions**: AI provider/budget (Q-001), licensing (Q-002), hosting region (Q-003),
    standalone desktop mode (Q-004).

## Product gaps (unmet acceptance criteria)

One acceptance criterion describes behaviour that does not exist, as opposed to behaviour that is
simply unverified. It is recorded on the story as a `verification` block:

1. **`CON-002` — automatic OAuth token refresh for Google Sheets.** The connector is handed an
   `accessToken` from the encrypted credential blob; nothing obtains or renews one. A Sheets
   destination therefore works for about an hour after somebody pastes a token. Fixing it means an
   OAuth consent flow (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are not in the schema), encrypted
   refresh-token storage on the connector row, and a refresh call before each run.

`AI-002`'s "agreed benchmark on the labelled test set" has no test set and no benchmark anywhere in
the repository; treat that criterion as not measurable until a corpus is added.

## Operations gaps (deployment, not product)

`DEPLOYMENT.md` §11 is the authoritative table; in short, a real production run still needs:

1. A container image / deploy pipeline — there is no `Dockerfile` and CI stops after `verify`.
2. A backup and restore path for SQLite (`VACUUM INTO`; there is no `db:backup` script yet) and a
   rehearsed restore. The database and `STORAGE_PATH` must be restored together.
3. Metrics and alerting. The access log now exists (structured `onResponse` line per request);
   what is missing is `/metrics` and anything that wakes a person.
4. A dependency vulnerability gate in CI: `npm audit` shows 9 advisories (1 critical, transitive
   `shell-quote`; `zod` and `image-size` high). `zod` needs a v3 → v4 migration before the gate can
   be green.

## Next actions, in order

1. Release plumbing: `Dockerfile`, image publish, `npm run db:backup`, then the go-live checklist.
2. **MFA policy** — let an organisation require a second factor for a role and report who has it on;
   today enrolment is self-service (`DEC-034`). WebAuthn after that, so a phished code is not enough.
3. Release checklist: sign and smoke-test installers on Windows/macOS/Linux (DEC-022).
4. Exercise the MySQL, Postgres and Google Sheets connectors against live servers, and run the
   backend against PostgreSQL once (`DB_DRIVER=postgres` + `DATABASE_URL`) — the `pg` path is typechecked but never executed.
5. Implement the `s3` storage adapter (the driver is already in the schema and fails fast).
6. Add the Socket.IO adapter behind the existing `RealtimeHub` interface (DEC-016).
7. Add one end-to-end test (Playwright against the renderer, Detox or Maestro for mobile); the suite
   is unit + integration only today.

## Environment facts worth knowing

- No PostgreSQL, Redis or Docker in the sandbox; `DB_DRIVER=sqlite` (`node:sqlite`) is the tested
  path and `pg` is the production path (DEC-013).
- Jest cannot load Fastify's `inject()` here (ESM-only `cookie` dependency), so the backend suite
  starts a real listener on an ephemeral port. Do not reintroduce `app.inject()`.
- `@idcp/shared` must not re-export `ids.ts` (Node-only); use `@idcp/shared/ids` in the backend.
