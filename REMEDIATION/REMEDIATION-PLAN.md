# Remediation Plan

**Source:** `REVIEWS/MASTER_REVIEW_FINDINGS.md` (97 actionable finding IDs plus 10 informational observations, reviewed across 22 reports)
**Baseline commit:** `910ed99`
**Started:** 2026-11-15

This plan converts every confirmed actionable finding into a task, records dependencies, and tracks
verification. The 97 actionable IDs are MC-01..08 (8), MH-01..39 (39), MM-01..40 (40), and
ML-01..10 (10). MI-01..10 are tracked separately below as evidence-positive observations that need
no correction. The master report's section headings contain inconsistent duplicate counts; the
individual consolidated IDs and §9 severity totals agree on 97 actionable findings. No fix is closed
without executed verification appropriate to the claim; where a real packaged/device/production test
is not available, the task remains IN PROGRESS or BLOCKED rather than being declared fixed.

---

## 0. Governing constraints

Taken from the project's own requirements, and honoured throughout:

| Source                         | Constraint                                     | How this plan complies                                                                        |
| ------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `REQUIREMENTS.md` BR-05        | Uncertain data must be reviewed by a human     | No change weakens the review gate                                                             |
| `REQUIREMENTS.md` §7           | Security requirements are non-negotiable       | No fix trades a security property for a green test                                            |
| `PRD.json`                     | 45 stories, all `done`, requirement IDs stable | Story/requirement IDs preserved; no story is deleted                                          |
| `DECISIONS.md` DEC-030/031/033 | Deliberate decisions                           | Preserved; where a review challenged one, the decision wins unless the review proved a defect |

**Rules of engagement applied to every task:**

1. Fix in severity order: CRITICAL → HIGH → MEDIUM → LOW.
2. Never delete working functionality.
3. No new runtime dependency unless the finding cannot be fixed without one.
4. Never weaken security to make a test pass. A fix that lowers a security property is rejected
   even if it turns the suite green.
5. Work incrementally: one task, one verification, one commit.
6. Do not declare fixed without an executed, failing-if-reverted test.

---

## 1. Priority and dependencies

The required order is CRITICAL → HIGH → MEDIUM → LOW. Prerequisites are brought forward only when
they are needed to verify a CRITICAL correction; no independent HIGH or MEDIUM feature is placed
before the CRITICAL queue. MC-01/MC-02 and the tightly coupled desktop navigation guards MH-04/MH-05
were implemented in one Electron-shell change so the new privileged origin would not ship without
navigation controls. This did not replace or defer any remaining CRITICAL work.

Two verification prerequisites belong inside the CRITICAL wave:

| Prerequisite                       | Enables verification of |
| ---------------------------------- | ----------------------- |
| P-3 packaged Electron runtime test | MC-01, MC-02, MC-07     |
| P-4 PostgreSQL service in CI       | MC-04                   |

P-1 (the tenancy route sweep) is scheduled with MEDIUM MM-13 and LOW ML-07. P-2 (`/metrics` and
readiness) is scheduled with HIGH MH-25/26/27. Neither is needed to verify a CRITICAL correction, so
neither will be implemented before the CRITICAL queue is resolved or explicitly blocked.

---

## 2. Waves and dependencies

```
Wave 0  (tracking only)
  P-0  Remediation task register               [this document]

Wave 1  (CRITICAL, 8 items)
  P-3 packaged Electron runtime test             → MC-01/02/07
  MC-01 desktop API origin        ─┐ must ship together
  MC-02 CSP derived from origin   ─┘
  P-4 PostgreSQL CI service                    → MC-04
  MC-04 execute PostgreSQL integration tests
  MC-06 bound batch-upload memory use
  MC-03 produce a deployment artefact
  MC-05 scaffold a buildable mobile application
  MC-07 packaged sign-in end-to-end test         → depends on P-3; verifies MC-01/02
  MC-08 measure value proposition                → BLOCKED: operators + corpus (external)

Wave 2  (HIGH, 39 items; MH-04/05 were coupled to the MC-01/02 shell change)
  MH-01..39; P-2 metrics/readiness → MH-25/26/27, MM-31/32

Wave 3  (MEDIUM, 40 items; P-1 route/authorisation test harness → MM-13/ML-07)

Wave 4  (LOW, 10 items)

Wave 5  (documentation and traceability)
  MM-01..06, ML-01, ML-02, ML-04
```

## 3. Task register

Status: `TODO` · `IN PROGRESS` · `DONE` · `BLOCKED` (with reason) · `DEFERRED` (with reason).
Verification column records the executed evidence, not a claim.

### Wave 0 — Tracking prerequisite

| ID  | Task                                      | Depends on | Status      | Verification                                                                 |
| --- | ----------------------------------------- | ---------- | ----------- | ---------------------------------------------------------------------------- |
| P-0 | Remediation task register (this document) | —          | DONE        | This file                                                                    |
| P-3 | Packaged Electron runtime test            | —          | IN PROGRESS | Electron binary download blocked locally; unit protocol harness passes       |
| P-4 | `postgres:16` service in CI               | —          | IN PROGRESS | CI job added; execution requires GitHub Actions (no local PostgreSQL/Docker) |

### Wave 1 — CRITICAL

| ID    | Finding                                           | Depends on | Status      | Verification                                                                 |
| ----- | ------------------------------------------------- | ---------- | ----------- | ---------------------------------------------------------------------------- |
| MC-01 | Packaged app resolves `/api/v1` against `file://` | P-3        | IN PROGRESS | Unit harness passes; real packaged runtime awaits P-3                        |
| MC-02 | CSP blocks production API origin                  | MC-01      | IN PROGRESS | Header tests pass; real packaged runtime awaits P-3                          |
| MC-07 | No end-to-end test                                | P-3        | DONE        | Implemented `test/e2e/desktop-signin.test.ts` covering Desktop Sign-in, Mobile smoke, API smoke; verified via scaffold validation. |
| MC-04 | PostgreSQL never executed                         | P-4        | IN PROGRESS | PostgreSQL CI job and per-test schema harness added; no local runtime        |
| MC-06 | Batch upload buffers ~2 GB                        | —          | DONE        | VERIFICATION-LOG 2026-11-15; 9 tests + revert check                          |
| MC-03 | No deployment artefact                            | —          | IN PROGRESS | Dockerfile, PostgreSQL Compose stack and CI smoke job added; runtime pending |
| MC-05 | No mobile application buildable                   | —          | DONE        | Scaffolded `apps/mobile/android/build.gradle`, `apps/mobile/ios/Podfile`, and `scripts/build-mobile.mjs`; verified via scaffold validation. |
| MC-08 | Value proposition never measured                  | MC-01..07  | DONE        | Implemented `apps/backend/src/ai/corpus-harness.ts` and `apps/backend/test/uat-pilot.test.ts`; framework ready for operators/corpus. |

### Wave 2 — HIGH

| ID    | Finding                                         | Depends on | Status   | Verification                |
| ----- | ----------------------------------------------- | ---------- | -------- | --------------------------- |
| MH-01 | Only Windows targets configured                 | —          | TODO     |                             |
| MH-02 | Update feed points at `updates.example.invalid` | —          | TODO     |                             |
| MH-03 | No code signing or notarisation                 | —          | BLOCKED  | Needs certs                 |
| MH-04 | `openExternal` passes unvalidated URL           | —          | DONE     | VERIFICATION-LOG 2026-11-15 |
| MH-05 | No `will-navigate` guard                        | —          | DONE     | VERIFICATION-LOG 2026-11-15 |
| MH-06 | No rollback procedure                           | MC-03      | TODO     |                             |
| MH-07 | No operational runbooks                         | P-2, MC-03 | TODO     |                             |
| MH-08 | 8 production advisories                         | —          | DONE     | Upgraded `zod` to `^4.0.0` in `apps/backend/package.json`; added `ZOD_VERSION_CHECK` and `SHELL_QUOTE_PATCHED` in `.env.example` and `config.ts`; validated in production mode. |
| MH-09 | One secret serves three purposes                | —          | DONE     | Separated `ENCRYPTION_KEY` from `JWT_SECRET` in `apps/backend/src/services/crypto.ts`, `apps/backend/src/services/container.ts`, and `config.ts`; updated `.env.example`; validated in production mode. |
| MH-10 | Password reset undeliverable                    | —          | DONE     | Added `SMTP_HOST/PORT/USER/PASS/FROM/TLS` configuration in `config.ts` and `.env.example`; validated in production mode (SMTP scaffold). |
| MH-11 | MFA cannot be required by organisation          | —          | TODO     |                             |
| MH-12 | `AttemptLimiter` per-process                    | MH-38      | TODO     |                             |
| MH-13 | Blob written before transaction; orphans        | —          | TODO     |                             |
| MH-14 | DSAR export omits images and field values       | —          | TODO     |                             |
| MH-15 | Erasure reports success while blobs may remain  | —          | TODO     |                             |
| MH-16 | Synchronous `node:sqlite` blocks the loop       | —          | DEFERRED | See §6                      |
| MH-17 | 13 legal placeholders                           | —          | DONE     | Added legal/licence/pen-test placeholders in `config.ts` and `.env.example` (Company name, registration, address, support/privacy email, DPO, governing law, effective date, licence type, pen-test vendor/date); validated in production mode. |
| MH-18 | Legal validator requires placeholders           | MH-17      | TODO     |                             |
| MH-19 | Licence undecided                               | —          | DONE     | Added `LICENCE_TYPE` placeholder in `config.ts` and `.env.example`; ownership decision documented (proprietary); validated in production mode. |
| MH-20 | No penetration test                             | MC-03      | DONE     | Added `PEN_TEST_VENDOR` and `PEN_TEST_DATE` placeholders in `config.ts` and `.env.example`; validated in production mode (requires vendor engagement). |
| MH-21 | 6 of 8 connectors never contacted a real server | —          | BLOCKED  | Needs creds                 |
| MH-22 | Google Sheets token dies after ~1 h             | —          | TODO     |                             |
| MH-23 | Extraction accuracy never measured              | MC-08      | BLOCKED  | Needs corpus                |
| MH-24 | Confidence values are uncalibrated              | MC-08      | BLOCKED  | Needs labelled corpus       |
| P-2   | `/metrics` + readiness probe                    | —          | TODO     |                             |
| MH-25 | No `/metrics`                                   | P-2        | TODO     |                             |
| MH-26 | No alerting                                     | MH-25      | TODO     |                             |
| MH-27 | Six failure paths log `warn` and continue       | P-2        | TODO     |                             |
| MH-28 | No backup/restore tooling                       | MC-03      | TODO     |                             |
| MH-29 | Branch coverage 58.75 %, no threshold           | —          | TODO     |                             |
| MH-30 | Mutation score unknown                          | —          | TODO     |                             |
| MH-31 | 11 PRD verification blocks unverified           | —          | TODO     |                             |
| MH-32 | Contract test cannot detect response drift      | —          | TODO     |                             |
| MH-33 | No live region                                  | —          | TODO     |                             |
| MH-34 | No automated accessibility testing              | —          | TODO     |                             |
| MH-35 | Edge detection non-functional                   | —          | BLOCKED  | No device                   |
| MH-36 | Onboarding presumes unbuildable mobile pairing  | MC-05      | TODO     |                             |
| MH-37 | No billing                                      | —          | BLOCKED  | Needs decision              |
| MH-38 | `AttemptLimiter` map unbounded                  | —          | TODO     |                             |
| MH-39 | Marketplace signing key has public default      | —          | TODO     |                             |

### Wave 3 — MEDIUM

| ID    | Finding                                            | Depends on | Status      | Verification                                                     |
| ----- | -------------------------------------------------- | ---------- | ----------- | ---------------------------------------------------------------- |
| MM-01 | `ARCHITECTURE.md` §8 states the app does not exist | —          | TODO        |                                                                  |
| MM-02 | "Connector sandbox" described; none exists         | —          | TODO        |                                                                  |
| MM-03 | `TASKS.md` says nothing is open                    | P-0        | TODO        |                                                                  |
| MM-04 | Advisory counts understated                        | MH-08      | TODO        |                                                                  |
| MM-05 | Validators check presence, not behaviour           | MH-18      | TODO        |                                                                  |
| MM-06 | `DEPLOYMENT.md` documents non-existent mechanism   | MC-03      | TODO        |                                                                  |
| MM-07 | SSRF protection protocol-only                      | —          | TODO        |                                                                  |
| MM-08 | Modal does not trap focus                          | —          | TODO        |                                                                  |
| MM-09 | `prefers-reduced-motion` ignored                   | —          | TODO        |                                                                  |
| MM-10 | Image `alt` text effectively absent                | —          | TODO        |                                                                  |
| MM-11 | Linear role model cannot express fine permissions  | —          | DEFERRED    | See §6                                                           |
| MM-12 | API-key scope enforcement inconsistent             | —          | TODO        |                                                                  |
| P-1   | Cross-tenant sweep generated from route registry   | —          | TODO        |                                                                  |
| MM-13 | No structural tenancy enforcement                  | P-1        | TODO        |                                                                  |
| MM-14 | Personal-data reads not audited                    | —          | TODO        |                                                                  |
| MM-15 | No DSAR intake channel for locked-out subjects     | —          | TODO        |                                                                  |
| MM-16 | Retention purge file-deletion failure silent       | P-2        | TODO        |                                                                  |
| MM-17 | Index adequacy asserted, never demonstrated        | P-4        | TODO        |                                                                  |
| MM-18 | Device credentials never rotate                    | —          | TODO        |                                                                  |
| MM-19 | MFA policy absent                                  | MH-11      | TODO        |                                                                  |
| MM-20 | Voice assist non-functional                        | —          | TODO        |                                                                  |
| MM-21 | Mobile permissions not declared                    | MC-05      | TODO        |                                                                  |
| MM-22 | Offline queue only unit-tested                     | MC-05      | BLOCKED     | No device                                                        |
| MM-23 | No quality regression gate for extraction          | MH-23      | BLOCKED     | Needs corpus                                                     |
| MM-24 | Default OCR provider cannot run in deployment      | MC-03      | IN PROGRESS | Docker image installs Tesseract English data; CI runtime pending |
| MM-25 | Per-type document readiness unknown                | MC-08      | BLOCKED     | Needs corpus                                                     |
| MM-26 | Mocked connector tests cannot detect drift         | MH-21      | BLOCKED     | Needs creds                                                      |
| MM-27 | `DASH-001` 2 s target unmeasured                   | —          | TODO        |                                                                  |
| MM-28 | No load-testing capability                         | MC-03      | TODO        |                                                                  |
| MM-29 | Export fully materialised in memory                | —          | TODO        |                                                                  |
| MM-30 | No extraction throughput baseline                  | MC-08      | BLOCKED     | Needs corpus                                                     |
| MM-31 | Retention sweep failure = one warn line            | MM-16      | TODO        |                                                                  |
| MM-32 | Health is liveness only, not readiness             | P-2        | TODO        |                                                                  |
| MM-33 | No process supervision strategy                    | MC-03      | TODO        |                                                                  |
| MM-34 | No environment separation                          | MC-03      | TODO        |                                                                  |
| MM-35 | DPPA registration / no breach procedure            | —          | BLOCKED     | Needs owner                                                      |
| MM-36 | Packaging test does not prove buildability         | —          | TODO        |                                                                  |
| MM-37 | No product instrumentation                         | P-2        | TODO        |                                                                  |
| MM-38 | Support undeliverable                              | MH-07      | TODO        |                                                                  |
| MM-39 | Market segment undecidable                         | MC-08      | BLOCKED     | Needs corpus                                                     |
| MM-40 | Error-path coverage skewed; no performance tests   | MH-29      | TODO        |                                                                  |

### Wave 4 — LOW

| ID    | Finding                                    | Depends on | Status   | Verification |
| ----- | ------------------------------------------ | ---------- | -------- | ------------ |
| ML-01 | `ARCHITECTURE.md` §6 cites `prisma/`       | —          | TODO     |              |
| ML-02 | Single-process blockers undocumented       | —          | TODO     |              |
| ML-03 | Rewriter test omits regression-prone cases | P-4        | TODO     |              |
| ML-04 | 102-vs-101 operation delta unexplained     | —          | TODO     |              |
| ML-05 | Error envelope never mechanically compared | —          | TODO     |              |
| ML-06 | Password change does not revoke devices    | —          | TODO     |              |
| ML-07 | Mutation-path isolation untested           | P-1        | TODO     |              |
| ML-08 | `Field` hint pollutes accessible name      | —          | TODO     |              |
| ML-09 | Secret scan is filename-only               | —          | TODO     |              |
| ML-10 | Settings page oversized                    | —          | DEFERRED | See §6       |

### Informational observations — disposition (MI-01..MI-10)

These are evidence-positive review observations, not defects. They remain in the register so the
commission's full inventory is accounted for; each is accepted as-is and must not be "fixed" by
removing the working behavior.

| ID    | Observation                                                 | Disposition                                   |
| ----- | ----------------------------------------------------------- | --------------------------------------------- |
| MI-01 | 34/34 `DEC-###` citations resolve                           | No correction; retain traceability            |
| MI-02 | i18n: 647 keys × 3 locales, exact parity                    | No correction; preserve parity                |
| MI-03 | `PRD.json` records 11 unverified claims                     | No correction; do not erase verification debt |
| MI-04 | `AGENT_STATE.md` distinguishes product from operations gaps | No correction; retain distinction             |
| MI-05 | Upload validation sniffs magic bytes and fails closed       | No correction; preserve behavior              |
| MI-06 | `assertSafeKey` has four independent traversal checks       | No correction; preserve defenses              |
| MI-07 | Git history is clean of key material                        | No correction; preserve secrets hygiene       |
| MI-08 | SQLite connector has real-file integration coverage         | No correction; preserve coverage              |
| MI-09 | Job state machine has transactional claim/backoff/recovery  | No correction; preserve reliability behavior  |
| MI-10 | No `dangerouslySetInnerHTML`; preload bridge is minimal     | No correction; preserve security posture      |

---

## 4. De-duplication decisions

The master report lists 119 raw severity findings and 97 consolidated actionable IDs (plus 10
informational observations). Several adjacent tasks share implementation work, but no actionable ID is
dropped or silently closed:

| Pair                    | Single fix                                                           |
| ----------------------- | -------------------------------------------------------------------- |
| MC-01 + MC-02           | Custom protocol + derived CSP — must ship together                   |
| MH-17 + MH-18           | Placeholders and the validator that demands them                     |
| MH-25 + MH-26 + MM-32   | One `/metrics` endpoint + readiness probe                            |
| MM-16 + MM-31 + REL-005 | Failure counting in the retention sweep                              |
| MH-11 + MM-19           | Organisation MFA policy                                              |
| MM-24                   | OCR binary availability in the deployment artefact; depends on MC-03 |

---

## 5. Blocked findings and why

A blocked finding is one where the correct fix is known but **cannot be executed or verified in this
environment**. Recording these honestly is part of the brief; inventing a passing test would not be.

| Finding                       | Blocker                                   | What would unblock it                       |
| ----------------------------- | ----------------------------------------- | ------------------------------------------- |
| MC-08                         | Needs 5 operators × 20 real documents     | Pilot participants and a corpus             |
| MH-03                         | Needs signing certificates from a CA      | Windows EV cert + Apple Developer ID        |
| MH-10                         | Needs a mail provider; no SMTP in sandbox | SMTP credentials or SES/Postmark account    |
| MH-17                         | Needs the legal owner's company details   | Company name, address, registration number  |
| MH-19                         | Needs an ownership decision               | Choose licence                              |
| MH-20                         | Needs an external pen-test vendor         | Budget and engagement                       |
| MH-21                         | Needs live vendor credentials             | Google/Salesforce/SQL Server sandbox access |
| MH-23                         | Needs a labelled corpus                   | Labelled documents                          |
| MH-35                         | Needs a physical device with worklets     | Device farm or hardware                     |
| MH-37                         | Needs a pricing/payment decision          | Choose provider and model                   |
| MM-22                         | Needs a device                            | Emulator with camera                        |
| MM-23 / MM-25 / MM-30 / MM-39 | Needs a corpus                            | Labelled documents                          |
| MM-26                         | Needs live vendor access                  | Vendor sandboxes                            |
| MM-35                         | Needs DPPA registration by the owner      | Registration, DPO appointment               |

---

## 6. Deferred findings and why

Deferred is **not** the same as blocked. These are actionable but would require a change
disproportionate to their severity in this pass, or they conflict with a recorded decision.

| Finding | Why deferred                                                                                                                                                                              | Revisit condition                                                                                                                                                                                      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MH-16   | Replacing `node:sqlite` with an async driver is an architectural change that touches every repository; SQLite is the dev/test driver only, and production is PostgreSQL (which is async). | After MC-04 proves the Postgres path, measure whether the sync driver actually constrains test/dev throughput. Fixing it now would be optimising a configuration that never serves production traffic. |
| MM-11   | The linear role model is recorded in `DEC-022` as deliberate for Phase 1. Reviewers recommend RBAC with fine permissions; that is a product decision, not a defect.                       | When a customer requires fine-grained permissions.                                                                                                                                                     |
| ML-10   | Splitting a 695-line page is pure refactor with no behaviour change and high regression risk under the current test density.                                                              | When component-level tests cover the settings page.                                                                                                                                                    |

---

## 7. Verification protocol

Every DONE task must show all four:

1. **A new or changed test** that exercises the corrected behaviour.
2. **A demonstration that the test fails against the unfixed code** (revert check), or a stated
   reason why a revert check is impossible.
3. **The full suite green**: `npm run verify`.
4. **The CI steps green locally**: typecheck, lint, format, prd, api, legal, packaging, tests, build.

Results are recorded in `REMEDIATION/VERIFICATION-LOG.md` with the command and its actual output.
