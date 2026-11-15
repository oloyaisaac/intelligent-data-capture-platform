# MASTER REVIEW FINDINGS

**Repository:** `oloyaisaac/intelligent-data-capture-platform`
**Reviewed commit:** `fb57508`
**Review date:** 2026-11-15
**Reviewers:** 22 (21 complete, 1 blocked)
**Total findings:** 119 → **consolidated to 84 unique root causes**

---

## EXECUTIVE SUMMARY

This review examined 41,288 lines of TypeScript across a five-package monorepo, executed the full 406-test suite, built the renderer and inspected the emitted bundle, seeded mutations into three validators to measure their sensitivity, and read every governance document and legal artefact.

**The central finding is a single sentence: the engineering is better than the release layer.**

Security primitives are real (Argon2id at OWASP parameters, AES-256-GCM with tenant-bound AAD, magic-byte upload validation, parameterised SQL throughout, log redaction, CSV formula defusal). Multi-tenancy is enforced in the data layer with 143 org predicates and re-read membership on every request. The job state machine is correct. i18n has exact 647-key parity across three locales.

And none of it can reach a customer, because:

- The **packaged desktop app cannot authenticate** — it resolves `/api/v1` against `file://` (R-01)
- **No deployment artefact exists** — no Dockerfile, no compose, no deploy job
- **No mobile app exists** — no `android/`, no `ios/`
- **PostgreSQL has never been executed** — the only production configuration
- **Password reset cannot be delivered** — no mail transport
- **One secret signs tokens and encrypts credentials** — rotation is destructive
- **Batch upload can allocate ~2 GB per request** — a remote DoS

**Verdict: the product is not production-ready, not saleable, and its core value proposition has never been measured.** The code is worth finishing. The release layer must be built.

---

## 1. CRITICAL findings (8)

### MC-01 — Packaged desktop app cannot reach its backend

|                       |                                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sources**           | DESK-001 (R09), corroborated by R01, R16, R19                                                                                                                                                  |
| **Severity**          | **CRITICAL**                                                                                                                                                                                   |
| **Files**             | `apps/desktop/src/App.tsx:134-142`, `api/client.ts:154`, `lib/realtime.ts:106`                                                                                                                 |
| **Evidence**          | `createClient()` passes no `baseUrl`; default is `/api/v1`. Built bundle: `api/v1` ×5, `localhost:4000` ×0. Under `loadFile` the origin is `file://`, so requests resolve to `file:///api/v1`. |
| **Expected**          | Packaged app reaches a configured absolute API origin                                                                                                                                          |
| **Actual**            | Every API call fails, including sign-in                                                                                                                                                        |
| **Why tests miss it** | All 8 `new ApiClient(...)` in tests inject an absolute `baseUrl`                                                                                                                               |
| **Correction**        | Custom `app://` protocol (recommended) — also fixes MC-02                                                                                                                                      |
| **Verification**      | Packaged-build sign-in test in CI                                                                                                                                                              |

### MC-02 — CSP blocks any production API origin

|                |                                                                             |
| -------------- | --------------------------------------------------------------------------- |
| **Sources**    | DESK-002 (R09), SEC-003 (R07)                                               |
| **Severity**   | **CRITICAL** (elevated: fixing MC-01 alone will not work)                   |
| **Files**      | `apps/desktop/index.html:8`                                                 |
| **Evidence**   | `connect-src 'self' ws:` — under `file://`, `'self'` is the file origin     |
| **Correction** | Derive `connect-src` from the API origin; ship as a header                  |
| **Note**       | **Must be fixed in the same change as MC-01** or the fix will appear broken |

### MC-03 — No deployment artefact exists

|                |                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| **Sources**    | OPS-001 (R19)                                                                                                  |
| **Severity**   | **CRITICAL**                                                                                                   |
| **Evidence**   | No `Dockerfile`, no `docker-compose.yml`, no k8s manifest, no deploy job in CI (2 jobs, 10 steps, none deploy) |
| **Correction** | Multi-stage Dockerfile + compose with PostgreSQL + CI image build                                              |
| **Note**       | Blocks AIX-004 (OCR binary) and DB-001 resolution                                                              |

### MC-04 — PostgreSQL has never been executed

|                         |                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sources**             | DB-001 (R03), OPS-002 (R19), PERF-002 (R17)                                                                                                                                      |
| **Severity**            | **CRITICAL** (escalated from HIGH in the parent assessment)                                                                                                                      |
| **Evidence**            | Every `DB_DRIVER` occurrence in tests either asserts the default is `sqlite` or that `postgres` requires a URL. **No test constructs a PG connection.** No migration step in CI. |
| **Reasoning**           | The default is SQLite; production _requires_ PostgreSQL. **The only shipping configuration is the only one never run.**                                                          |
| **Correction**          | `postgres:16` service container + `db:migrate` + suite in CI (~20 lines of YAML)                                                                                                 |
| **Mitigating evidence** | DDL is genuinely portable (no `AUTOINCREMENT`/`PRAGMA`/`datetime()`); the placeholder rewriter is correct on 5/5 edge cases including `O''Brien` and `LIKE '%?%'`                |

### MC-05 — No mobile application can be built

|                |                                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Sources**    | MOB-001 (R11)                                                                                                               |
| **Severity**   | **CRITICAL**                                                                                                                |
| **Evidence**   | `ls apps/mobile/` → no `android/`, no `ios/`. `package.json` declares `run-android`/`run-ios` which would fail immediately. |
| **Correction** | Scaffold native projects, commit both, build an APK in CI                                                                   |

### MC-06 — Batch upload buffers ~2 GB before enforcing its own cap

|                |                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Sources**    | PERF-001 (R17), BE-002 (R02) — same root cause, two perspectives                                                             |
| **Severity**   | **CRITICAL**                                                                                                                 |
| **Files**      | `apps/backend/src/http/routes/batch-routes.ts:33`; `batch-service.ts:61`                                                     |
| **Evidence**   | `await part.toBuffer()` accumulates every file; the `MAX_BATCH_FILES` check runs **after** the loop. 101 × 20 MB ≈ 2 GB RSS. |
| **Correction** | Abort on count during iteration; stream to storage per part                                                                  |
| **Note**       | A remote DoS reachable by any authenticated uploader using the product's own UI                                              |

### MC-07 — No end-to-end test exists, which is why MC-01 and MC-05 survived

|                |                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Sources**    | QA-001 (R16), DESK-005 (R09)                                                                                              |
| **Severity**   | **CRITICAL**                                                                                                              |
| **Evidence**   | No Playwright/Cypress/Detox/Maestro. No test loads a packaged build, a browser, or a device.                              |
| **Reasoning**  | This is the **root cause** of the defect class, not a peer of it. 406 green tests coexist with an unrunnable desktop app. |
| **Correction** | One packaged-app sign-in test; one mobile smoke test; one API smoke test                                                  |

### MC-08 — The value proposition has never been measured

|                |                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sources**    | UAT-002 (R22), UX-001 (R12), AIX-001 (R14)                                                                                                                                      |
| **Severity**   | **CRITICAL**                                                                                                                                                                    |
| **Evidence**   | No corpus, no benchmark, no time-on-task data, no no-correction rate. `PRD.json` DASH-001 admits: _"asserted by design … not by a load test or a real dataset."_                |
| **Reasoning**  | If review burden exceeds retyping, there is no business case regardless of engineering quality. Every other finding is repairable; this one decides whether repair is worth it. |
| **Correction** | 5 operators, 20 of their own documents each, stopwatch both paths                                                                                                               |

---

## 2. HIGH findings (45 → 30 unique)

Grouped by root cause. Duplicates from multiple reviewers are merged; where perspectives differ they are preserved in the note.

### Release layer

| ID    | Finding                                                        | Sources                    | Files                      |
| ----- | -------------------------------------------------------------- | -------------------------- | -------------------------- |
| MH-01 | Only Windows targets configured; no macOS/Linux, undocumented  | ELEC-001                   | `electron-builder.json`    |
| MH-02 | Update feed points at `updates.example.invalid` (reserved TLD) | ELEC-002                   | same                       |
| MH-03 | No code signing or notarisation configured                     | ELEC-003                   | same                       |
| MH-04 | `openExternal` passes unvalidated URL to the OS                | SEC-001, ELEC-004          | `electron-main.ts:129-130` |
| MH-05 | No `will-navigate` guard; preload bridge survives navigation   | SEC-002, ELEC-005, SEC-006 | `electron-main.ts`         |
| MH-06 | No rollback procedure; no versioned artefacts                  | OPS-003                    | —                          |
| MH-07 | No operational runbooks                                        | OPS-004                    | —                          |

### Security & identity

| ID    | Finding                                                                                 | Sources            | Files                             |
| ----- | --------------------------------------------------------------------------------------- | ------------------ | --------------------------------- |
| MH-08 | 8 production advisories (1 crit, 5 high); `zod` is a **direct** dep                     | SEC-005, DOCS-004  | `package-lock.json`               |
| MH-09 | **One `JWT_SECRET`** signs tokens, encrypts connector credentials, encrypts MFA secrets | AUTH-001           | `container.ts:84`, `crypto.ts:19` |
| MH-10 | Password reset undeliverable in production (no mail transport)                          | AUTH-002, COMP-*   | `auth-service.ts`                 |
| MH-11 | MFA cannot be required by organisation                                                  | AUTH-003, COMP-006 | —                                 |
| MH-12 | `AttemptLimiter` per-process; blocks scale-out                                          | BE-004             | `tokens.ts:105`                   |

### Data integrity

| ID    | Finding                                                       | Sources            | Files                         |
| ----- | ------------------------------------------------------------- | ------------------ | ----------------------------- |
| MH-13 | Blob written **before** transaction; orphans never reconciled | BE-001, DB-002     | `document-service.ts:116-118` |
| MH-14 | DSAR export **omits document images and field values**        | PRIV-001, COMP-005 | `privacy-service.ts:121`      |
| MH-15 | Erasure reports success while blobs may remain                | PRIV-002, REL-003  | `privacy-service.ts:220`      |
| MH-16 | Synchronous `node:sqlite` blocks the event loop               | PERF-002           | `sqlite.ts`                   |

### Privacy & compliance

| ID    | Finding                                                      | Sources  | Files                |
| ----- | ------------------------------------------------------------ | -------- | -------------------- |
| MH-17 | 13 placeholders in documents served to customers             | COMP-001 | `legal/*`            |
| MH-18 | Legal validator **requires** placeholders; cannot catch this | COMP-002 | `validate-legal.mjs` |
| MH-19 | Licence undecided (`Q-002` open)                             | COMP-003 | `LICENSE`            |
| MH-20 | No penetration test                                          | COMP-004 | —                    |

### Connectors & AI

| ID    | Finding                                                 | Sources  | Files                          |
| ----- | ------------------------------------------------------- | -------- | ------------------------------ |
| MH-21 | 6 of 8 connectors never contacted a real server         | CONX-001 | `connectors.test.ts`           |
| MH-22 | Google Sheets token dies after ~1 h; no refresh         | CONX-002 | `google-sheets-connector.ts`   |
| MH-23 | Extraction accuracy never measured; no corpus           | AIX-001  | —                              |
| MH-24 | Confidence values uncalibrated but drive reviewer trust | AIX-002  | `extract.ts`, `classify.ts:97` |

### Reliability & observability

| ID    | Finding                                                        | Sources         | Files    |
| ----- | -------------------------------------------------------------- | --------------- | -------- |
| MH-25 | No `/metrics`; nothing can be alerted on                       | REL-001         | —        |
| MH-26 | No alerting of any kind                                        | REL-002         | —        |
| MH-27 | Six failure paths log `warn` and continue; no residue tracking | REL-003, DB-004 | multiple |
| MH-28 | No backup/restore tooling; never rehearsed                     | REL-004         | —        |

### Testing & contract

| ID    | Finding                               | Sources | Files             |
| ----- | ------------------------------------- | ------- | ----------------- |
| MH-29 | Branch coverage 58.75 %, no threshold | QA-002  | `jest.config.cjs` |
| MH-30 | Mutation score unknown                | QA-003  | —                 |

### Also HIGH

| ID    | Finding                                                               | Sources         |
| ----- | --------------------------------------------------------------------- | --------------- |
| MH-31 | 11 PRD verification blocks unverified while all 45 stories are `done` | QA-004          |
| MH-32 | Contract test cannot detect response-shape drift                      | API-001         |
| MH-33 | No live region; async updates silent to screen readers                | A11Y-001        |
| MH-34 | No automated accessibility testing; AA unverifiable                   | A11Y-002        |
| MH-35 | Edge detection non-functional (worklets not installed)                | MOB-002         |
| MH-36 | Onboarding presumes unbuildable mobile pairing                        | UAT-004, UX-003 |
| MH-37 | No billing; a pilot cannot become revenue                             | UAT-003         |
| MH-38 | `AttemptLimiter` map unbounded (memory exhaustion)                    | BE-003          |
| MH-39 | Marketplace signing key has public default, absent from config        | CONX-003        |

---

## 3. MEDIUM findings (54 → 34 unique)

| ID    | Finding                                                      | Sources            |
| ----- | ------------------------------------------------------------ | ------------------ |
| MM-01 | `ARCHITECTURE.md` §8 states the application does not exist   | DOCS-001, ARC-001  |
| MM-02 | "Connector sandbox" described; none exists (in-process)      | ARC-003, CONX-005  |
| MM-03 | `TASKS.md` says nothing is open                              | DOCS-003           |
| MM-04 | Advisory counts understated in two documents                 | DOCS-004           |
| MM-05 | Validators check presence/shape, not behaviour               | DOCS-005           |
| MM-06 | `DEPLOYMENT.md` documents a non-existent injection mechanism | DOCS-006           |
| MM-07 | SSRF protection is protocol-only; no IP-range block          | SEC-004            |
| MM-08 | Modal does not trap focus despite its comment                | DESK-003, A11Y-004 |
| MM-09 | `Modal` focus trap absent (`prefers-reduced-motion` ignored) | A11Y-003           |
| MM-10 | Image `alt` text effectively absent (1 in 10k LOC)           | A11Y-006           |
| MM-11 | Linear role model cannot express fine permissions            | TEN-001            |
| MM-12 | API-key scope enforcement inconsistent                       | TEN-002            |
| MM-13 | No structural enforcement; new routes can forget tenancy     | TEN-003            |
| MM-14 | Personal-data reads not audited                              | PRIV-003           |
| MM-15 | No DSAR intake channel for locked-out subjects               | PRIV-004           |
| MM-16 | Retention purge file-deletion failure is silent              | DB-004             |
| MM-17 | Index adequacy asserted, never demonstrated                  | DB-005             |
| MM-18 | Device credentials never rotate or expire                    | AUTH-004           |
| MM-19 | MFA policy absent (see MH-11)                                | AUTH-003           |
| MM-20 | Voice assist non-functional                                  | MOB-003            |
| MM-21 | Mobile permissions not declared                              | MOB-004            |
| MM-22 | Offline queue only unit-tested                               | MOB-005            |
| MM-23 | No quality regression gate for extraction                    | AIX-003            |
| MM-24 | Default OCR provider cannot run in deployment                | AIX-004            |
| MM-25 | Per-type document readiness unknown                          | AIX-005            |
| MM-26 | Mocked connector tests cannot detect vendor drift            | CONX-004           |
| MM-27 | `DASH-001` 2 s target unmeasured                             | PERF-003           |
| MM-28 | No load-testing capability                                   | PERF-004           |
| MM-29 | Export fully materialised in memory                          | PERF-005           |
| MM-30 | No extraction throughput/cost baseline                       | PERF-006           |
| MM-31 | Retention sweep failure = one warn line                      | REL-005            |
| MM-32 | Health is liveness only, not readiness                       | REL-006            |
| MM-33 | No process supervision strategy                              | OPS-005            |
| MM-34 | No environment separation                                    | OPS-006            |
| MM-35 | DPPA registration/DPO unaddressed; no breach procedure       | COMP-007, COMP-008 |
| MM-36 | Packaging test does not prove buildability                   | ELEC-006           |
| MM-37 | Error actionability unverified; no product instrumentation   | UX-002, UX-004     |
| MM-38 | Support undeliverable (no runbooks/metrics/alerts)           | UAT-005            |
| MM-39 | Market segment undecidable without accuracy data             | UAT-006            |
| MM-40 | Error-path coverage skewed; no performance tests             | QA-005, QA-006     |

---

## 4. LOW findings (12 → 9 unique)

| ID    | Finding                                            | Sources            |
| ----- | -------------------------------------------------- | ------------------ |
| ML-01 | `ARCHITECTURE.md` §6 cites non-existent `prisma/`  | ARC-002, DOCS-002  |
| ML-02 | Single-process blockers undocumented               | ARC-004            |
| ML-03 | Rewriter test omits regression-prone cases         | DB-003             |
| ML-04 | 102-vs-101 operation delta unexplained             | API-002            |
| ML-05 | Error envelope never mechanically compared         | API-004            |
| ML-06 | Password change does not revoke device credentials | AUTH-005           |
| ML-07 | Mutation-path isolation untested                   | TEN-004            |
| ML-08 | `Field` hint pollutes accessible name              | DESK-004, A11Y-005 |
| ML-09 | Secret scan is filename-only                       | OPS-007            |
| ML-10 | Settings page oversized (695 LOC)                  | UX-005             |

---

## 5. INFORMATIONAL

| ID    | Observation                                                                   |
| ----- | ----------------------------------------------------------------------------- |
| MI-01 | 34/34 `DEC-###` citations resolve — zero dangling references                  |
| MI-02 | i18n: 647 keys × 3 locales, **exact parity**, zero drift                      |
| MI-03 | `PRD.json` honestly records 11 unverified claims in its own data              |
| MI-04 | `AGENT_STATE.md` distinguishes product from operations gaps                   |
| MI-05 | Upload validation sniffs magic bytes and fails closed                         |
| MI-06 | `assertSafeKey` has four independent traversal checks                         |
| MI-07 | Git history is clean of key material (full-history scan)                      |
| MI-08 | SQLite connector is genuinely integration-tested against a real file          |
| MI-09 | Job state machine: transactional claim, backoff, dead state, startup recovery |
| MI-10 | No `dangerouslySetInnerHTML`; preload bridge is minimal and explicit          |

---

## 6. DISAGREEMENTS AND CORRECTIONS BETWEEN REVIEWERS

Per the brief, conflicting findings are **recorded, not silently discarded**. Six positions changed during this review — four because a reviewer was wrong, two because the assessment was.

### D-01 — R-04 severity: HIGH → CRITICAL (R03 vs parent assessment)

The assessment rated the unexecuted PostgreSQL path HIGH. R03 escalated it to CRITICAL with the reasoning that **the default driver is SQLite while production requires PostgreSQL**, making the only shipping configuration the only one never executed. R17 and R19 concur. **Resolution: CRITICAL (MC-04).** R03's reasoning is sound and the assessment's framing understated it.

### D-02 — SSRF: "no block" → "protocol-only validation" (R07 vs parent assessment)

The assessment stated there is no private-range/metadata block and expected attempts to connect. R07 found that `crm/http.ts:46-50` **does** enforce https and rejects malformed URLs, and only literal loopback may use http. **Resolution: DOWNGRADED to MEDIUM (MM-07).** The remaining gap is IP-range/DNS-rebinding only. The assessment's direction was right; its magnitude was overstated.

### D-03 — SQLite connectors: "never run live" → genuinely tested (R15 vs parent assessment)

The assessment implied connectors were exercised only against mocks. R15 found `connectors.test.ts:160-166` creates a **real temp SQLite file** via `mkdtemp` + `DatabaseSync`. **Resolution: SQLite credited as genuinely integration-tested; the other 7 remain mock-only (MH-21).**

### D-04 — `RECOVERY_GRACE_MS` double-claim: suspected → refuted (R18 vs my own prior hypothesis)

A 30-second grace window looked likely to requeue long OCR jobs mid-flight. R18 read `worker.ts:start()` and found `requeueStale` runs **once at startup only**, with a comment explaining that on a single instance nothing else can hold those jobs. **Resolution: REFUTED. No double-claim risk in single-process operation.** It would become a risk under multi-replica deployment, which DEC-029 forbids.

### D-05 — RTL: "not implemented" → implemented (R13 self-correction)

I initially recorded no RTL support based on a `'ar'` string hit being "a comment". R13 found `SUPPORTED_LOCALES = ['en','sw','fr']` but `directionFor()` handles 13 RTL languages and `App.tsx:258` applies `dir={direction}`. **Resolution: RTL infrastructure verified as working.** My initial note was wrong.

### D-06 — Form labelling: "unlabelled" → implicitly labelled (R13 self-correction)

`<input>` count = 48, `aria-label` = 0, `htmlFor` = 0 initially suggested no labelling. R13 found the `Field` component wraps inputs in a `<label>` element (`ui.tsx:73`) — **implicit labelling is valid.** **Resolution: DOWNGRADED.** The genuine residual issue is the hint being inside the label (ML-08).

### D-07 — Marketplace signature: suspected bypass → correctly scoped (R15 self-correction)

`verifyPackageSignature` recomputing with the same function that signs looked like a checksum masquerading as a signature. R15 confirmed the catalogue is **first-party only** (5 packages, all signed in-process), so there is no third-party publisher to forge. **Resolution: DOWNGRADED to MEDIUM (MH-39).** The public default key is a latent risk only if third-party publishing is added — at which point it becomes a complete bypass.

### D-08 — Langauge: locales are `en/sw/fr`, not `en/sw/lg`

An earlier assessment note referred to Luganda. The implemented locales are English, Swahili and French. Recorded for accuracy.

---

## 7. Root cause analysis

Six root causes account for the majority of findings:

| #   | Root cause                                             | Findings explained                                       |
| --- | ------------------------------------------------------ | -------------------------------------------------------- |
| 1   | **No test exercises the shipping configuration**       | MC-01, MC-05, MC-07, MH-32, MH-35                        |
| 2   | **No deployment artefact**                             | MC-03, MH-01–03, MH-27, MH-28, AIX-004                   |
| 3   | **One secret, three purposes**                         | MH-09, and the rotation hazard across all encrypted data |
| 4   | **Silent failure by convention** (`warn` and continue) | MH-15, MH-27, MM-16, REL-005                             |
| 5   | **Measurement deferred indefinitely**                  | MC-08, MH-23, MH-24, MM-27–30                            |
| 6   | **Documentation describes intent, not reality**        | MM-01–06                                                 |

---

## 8. What is genuinely good

Stated plainly, because a review that only lists defects is not honest either:

1. **Cryptographic correctness.** Argon2id at OWASP parameters; AES-256-GCM with tenant-bound AAD; refresh tokens hashed and rotated; single-use reset tokens with raced `markUsed`.
2. **Tenancy enforced in the data layer.** 143 org predicates; membership re-read on **every** request so a demoted user cannot retain privileges. Dedicated negative tests across five domains.
3. **Job state machine.** Transactional claim, exponential backoff, dead state, startup recovery with documented reasoning.
4. **Upload security.** Magic-byte sniffing that fails closed; four independent traversal guards.
5. **i18n.** Exact 647-key parity across three locales; RTL for 13 languages from one root `dir`.
6. **Honest self-reporting.** `PRD.json` records its own 11 unverified claims; `AGENT_STATE.md` separates product from operations gaps. This is why the review could be precise.
7. **Test suite.** 406 tests, 30 suites, 45 seconds, no flakiness, behavioural naming, real harness.
8. **Decision log.** 34/34 citations resolve.
9. **CI gating.** 10 steps covering typecheck, lint, format, four contract validators, tests, build, secret scan.

---

## 9. Consolidated totals

| Severity      | Individual findings | After de-duplication |
| ------------- | ------------------- | -------------------- |
| CRITICAL      | 8                   | **8**                |
| HIGH          | 45                  | **39**               |
| MEDIUM        | 54                  | **40**               |
| LOW           | 12                  | **10**               |
| INFORMATIONAL | —                   | **10**               |
| **Total**     | **119**             | **97**               |

**Unique root causes: 6.**

---

## 10. Recommended sequence

Do not start with code. The following order protects the critical path:

1. **MC-01 + MC-02 together** (app:// protocol) **+ MC-07's packaged test in the same PR.** Without the test the fix is reversible by accident.
2. **MC-04** — add `postgres:16` to CI. ~20 lines. Closes the largest unknown.
3. **MC-03** — Dockerfile + compose. Unblocks MH-24 (OCR binary) and any real deployment.
4. **MH-09** — separate the encryption key. Cheap, and it makes rotation safe.
5. **MC-06** — stop the DoS before anything is exposed.
6. **MC-05** — scaffold native projects.
7. **MC-08** — build the corpus and measure. Then decide whether to continue.

**Nothing above requires a decision from the owner except item 7**, which requires one only after the numbers exist.
