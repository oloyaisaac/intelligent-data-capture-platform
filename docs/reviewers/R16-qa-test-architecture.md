# REVIEWER 16 — QA LEAD & TEST ARCHITECTURE

| Field | Value |
|-------|-------|
| **Reviewer ID** | R16 |
| **Title** | QA Lead & Test Architecture Reviewer |
| **Board** | E — Quality, performance & reliability |
| **Wave** | 4 (weeks 6–8) |
| **Effort** | 12 person-days |
| **Gate chaired** | **G2 — Functional correctness** and **G8 — Automated testing approval** |
| **Co-signs** | none |
| **Finding prefix** | `QA-###` |
| **Upstream** | ALL Wave 1–3 reviewers (you consolidate their evidence) |
| **Downstream** | G2, G8, G10 |
| **Status** | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Determine whether the test suite is **evidence** or **decoration**. This repository's 406 passing tests in 30
suites are the project's main quality claim — and that claim failed to detect a defect (R-01) that makes the
packaged desktop application unable to reach its own backend. Your job is to explain *why*, quantify how much
of the suite is protecting anything, and design the testing that would prevent the next such defect.

**Measured baseline you start from:**

| Metric | Value |
|--------|-------|
| Test suites | 30 (backend 24, desktop 2, mobile 1, shared 1, connectors 1) |
| Tests | 406, all passing, 44.8 s |
| Statements | 74.47 % (6 217 / 8 348) |
| **Branches** | **58.75 % (2 409 / 4 100)** |
| Functions | 66.2 % (1 185 / 1 790) |
| Lines | 76.88 % (5 826 / 7 578) |
| **End-to-end tests** | **0** |
| Mutation score | **unknown** |
| Accessibility tests | 0 |
| Contract validators | 4 (`validate-prd`, `validate-openapi`, `validate-packaging`, `validate-legal`) |

**The central question:** statement coverage at 74 % with branch coverage at 59 % and zero e2e means large
parts of the *shipped artefact* are untested. Prove that, then fix the test architecture.

---

## 2. Required expertise

- Test strategy: pyramid vs trophy vs honeycomb, and when each applies
- Jest project configuration, ts-jest, jsdom, fake timers, isolation
- Integration testing of HTTP servers without `inject()` (this repo starts a real listener)
- Mutation testing (Stryker) and what a mutation score means
- Coverage analysis by branch type (error paths, guards, alternatives)
- Contract testing and schema validation as gates
- Flaky-test control, determinism, test data factories
- E2E design (Playwright for Electron/renderer, Detox/Maestro for RN)

---

## 3. Repository context (self-contained)

**Product.** Backend (Fastify, 101 routes) + Electron renderer (12 pages) + React Native app (5 screens) +
shared packages. All in one npm-workspace monorepo with a single root `jest.config.cjs` defining **5
projects**.

**Test infrastructure:**

| Artefact | Path |
|----------|------|
| Jest configuration (5 projects) | `jest.config.cjs` |
| Backend test harness (starts a real listener) | `apps/backend/test/helpers.ts` (394) |
| Test doctrine | `TESTING.md` (20 KB) |
| PRD contract validator | `scripts/validate-prd.mjs` |
| OpenAPI contract validator | `scripts/validate-openapi.mjs` |
| Packaging contract validator | `scripts/validate-packaging.mjs` |
| Legal pack validator | `scripts/validate-legal.mjs` |
| UDM schema drift check | `scripts/generate-udm-schema.mjs --check` |
| CI | `.github/workflows/ci.yml` (2 jobs) |
| Root scripts | `package.json` (`test`, `test:unit`, `test:coverage`, `verify`) |

**All 30 suites:**

*Backend (24):* `ai` · `audit-export` · `auth` · `auth-recovery` · `batches` · `config` · `connector` ·
`dashboard` · `devapi` · `documents` · `export` · `maintenance` · `marketplace` · `mfa` · `pairing` ·
`privacy` · `review` · `security` · `teams` · `templates` · `terms` · `totp` · `web-surface` ·
`worker-recovery` · `workflows`

*Other (6):* `apps/desktop/test/desktop.test.tsx` (1 511) · `apps/desktop/test/shell.test.ts` (213) ·
`apps/mobile/test/mobile.test.ts` (1 054) · `packages/connectors/test/connectors.test.ts` (627) ·
`packages/shared/test/shared.test.ts` (430)

**The `verification` block mechanism.** 11 of 45 PRD stories carry a `verification` block naming an
acceptance criterion that is *asserted rather than demonstrated*: `DB-001`, `PAIR-002`, `MOB-001`, `AI-001`,
`AI-002`, `EXPORT-001`, `DESK-001`, `CON-002`, `SEC-001`, `DASH-001`, `I18N-001`. `npm run test:prd` fails if a
block is empty. `TESTING.md` §3.1 explains the kinds. **Audit each one.**

**Known environment constraint** (`AGENT_STATE.md`): *"Jest cannot load Fastify's `inject()` here (ESM-only
`cookie` dependency), so the backend suite starts a real listener on an ephemeral port. Do not reintroduce
`app.inject()`."*

---

## 4. Exact files and components to examine

### 4.1 Must read in full

`jest.config.cjs` · `TESTING.md` (all 20 KB, especially §3.1) · `apps/backend/test/helpers.ts` (394) ·
`package.json` (root scripts) · `.github/workflows/ci.yml` · all four `scripts/validate-*.mjs` ·
`scripts/generate-udm-schema.mjs`.

### 4.2 Must read — all 30 suites

Read each suite and record: what it asserts, whether the assertion would fail if the behaviour broke, and
which of the 101 routes / 38 features it covers. Do not sample.

### 4.3 Must read the `verification` blocks

`PRD.json` → the 11 stories listed above. For each, quote the criterion and judge: *is this measurable today,
and is it measured?*

### 4.4 Explicit non-goals

Feature correctness in depth → the owning reviewer · performance measurement → R17 · security testing
methodology → R07 · accessibility testing → R13.

---

## 5. Upstream artefacts required

| From | Artefact | Why |
|------|----------|-----|
| R01–R13 | All `findings.md` | You consolidate which defects the suite failed to catch |
| R02 | `evidence/R02/route-matrix.csv` | To measure route coverage |

---

## 6. Checklist

### 6.1 PYRAMID / SHAPE

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| QA-01 | Count tests by level: unit / integration / e2e | Map all 30 suites | Table with counts | **WRITE** |
| QA-02 | Confirm the e2e count is **zero** | No Playwright/Detox/Maestro/Cypress in any `package.json` | Confirmed — primary finding | **RUNTIME** |
| QA-03 | Assess the `inject()` workaround | Read `helpers.ts`; understand why a real listener is used | Documented; assess whether it limits what can be tested | STATIC |
| QA-04 | Determine whether any test exercises the **packaged renderer** | Read the desktop tests | They mount with an injected `baseUrl` — this is *why* R-01 survived | STATIC |
| QA-05 | Determine whether any test exercises the **real Electron shell** | `shell.test.ts` uses a stand-in | Confirmed stand-in; no real Electron | STATIC |
| QA-06 | Determine whether any test exercises a **real mobile build** | `mobile.test.ts` is JS-only | Confirmed | STATIC |
| QA-07 | Assess the test-to-feature ratio by area | 38 features vs 406 tests | Identify over- and under-tested areas | **WRITE** |

### 6.2 COVERAGE ANALYSIS

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| QA-08 | Produce per-file coverage | `npm run test:coverage`; export per-file table | `evidence/R16/coverage-by-file.md` | **RUNTIME** |
| QA-09 | Identify **security-relevant uncovered branches** | For `auth-service`, `guards`, `crypto`, `tokens`, `api-key-service` | A ranked list with line numbers | **RUNTIME** |
| QA-10 | Identify uncovered error paths | Branch coverage on `catch`/guard branches | Ranked list | **RUNTIME** |
| QA-11 | Identify uncovered role-denial paths | Cross-reference `requireRole` calls | Each denial has a test or is listed | STATIC |
| QA-12 | Identify files with **zero** coverage | Sort ascending | Full list | **RUNTIME** |
| QA-13 | Set a coverage policy | Proposal | Thresholds per area (not one global number) | **WRITE** |

### 6.3 MUTATION TESTING — do the tests actually protect anything?

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| QA-14 | Run mutation testing on `auth-service.ts` | Stryker (or equivalent) | Mutation score | **RUNTIME** |
| QA-15 | Run mutation testing on `guards.ts` | Same | Mutation score | **RUNTIME** |
| QA-16 | Run mutation testing on `crypto.ts` | Same | Mutation score | **RUNTIME** |
| QA-17 | Run mutation testing on `packages/shared/src/{csv,dedupe,money}.ts` | Same | Mutation score | **RUNTIME** |
| QA-18 | Interpret the scores | >70 % = the suite actually constrains behaviour; <40 % = tests execute code but assert little | Written interpretation | **WRITE** |
| QA-19 | Identify **surviving mutants** that represent real defects | Inspect survivors | Concrete defects found by mutation — list them as findings | **RUNTIME** |
| QA-20 | Recommend a mutation gate for security-critical modules only | Proposal | Scoped, runnable in CI time budget | **WRITE** |

### 6.4 ASSERTION QUALITY

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| QA-21 | Find tests that assert only a status code | Grep `expect(res.statusCode).toBe(200)` with no body assertion | List them | STATIC |
| QA-22 | Find tests that would pass if the implementation returned a wrong body | Spot-check 20 tests by mutating the expectation mentally | List weak tests | STATIC |
| QA-23 | Find `expect(true)` / `toHaveBeenCalled` without argument assertions | Grep | List | STATIC |
| QA-24 | Verify at least one test fails if a critical behaviour breaks | Delete an assertion in a golden test and confirm CI fails | Demonstrated | **RUNTIME** |
| QA-25 | Check that denial paths are asserted, not just success | Count 401/403/404 assertions per suite | Table | STATIC |
| QA-26 | Check that **negative** security tests exist (tampered token, foreign id) | Read `security.test.ts` | Present; extend if thin | STATIC |

### 6.5 CONTRACT VALIDATORS — are the gates real?

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| QA-27 | `validate-prd.mjs` fails on a stale/invalid story | Introduce an error, run | Fails | **RUNTIME** |
| QA-28 | `validate-openapi.mjs` fails on route removal | Delete a route, run | Fails | **RUNTIME** |
| QA-29 | `validate-openapi.mjs` fails on a **response-shape** change | Modify a response, run | **Record pass/fail — likely passes (finding)** | **RUNTIME** |
| QA-30 | `validate-packaging.mjs` fails on a broken packaging contract | Break a target, run | Fails | **RUNTIME** |
| QA-31 | `validate-legal.mjs` fails on a retention-figure mismatch | Change a default, run | Fails | **RUNTIME** |
| QA-32 | `generate-udm-schema.mjs --check` fails on schema drift | Edit the schema, run | Fails | **RUNTIME** |
| QA-33 | Every validator's failure message is actionable | Read each | Names the file and the fix | STATIC |

### 6.6 THE 11 `verification` BLOCKS

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| QA-34 | Audit `DB-001` | Read the block; judge measurability | Verdict: measurable-but-unmeasured / genuinely blocked | STATIC |
| QA-35 | Audit `PAIR-002` | Same | Verdict | STATIC |
| QA-36 | Audit `MOB-001` | Same (native build) | Verdict | STATIC |
| QA-37 | Audit `AI-001` and `AI-002` | Same (benchmark) | Verdict | STATIC |
| QA-38 | Audit `EXPORT-001` | Same | Verdict | STATIC |
| QA-39 | Audit `DESK-001` | Same (installers) | Verdict | STATIC |
| QA-40 | Audit `CON-002` | Same (OAuth) | Verdict — this is a real hole, not a verification gap | STATIC |
| QA-41 | Audit `SEC-001`, `DASH-001`, `I18N-001` | Same | Verdict | STATIC |
| QA-42 | Decide, for each, whether the story may remain `done` | Judgement | A table: story · keep `done` / move to `in progress` · who closes it and how | **WRITE** |
| QA-43 | Verify `test:prd` genuinely fails on an empty block | Empty a block, run | Fails | **RUNTIME** |

### 6.7 DETERMINISM AND ISOLATION

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| QA-44 | Run the suite twice and diff results | `npm test` ×2 | Identical | **RUNTIME** |
| QA-45 | Shuffle test order | `--randomize` | Identical results (no order dependence) | **RUNTIME** |
| QA-46 | Check for shared mutable state | Inspect `helpers.ts` for shared DB/clock/limiter | Isolated per suite | STATIC |
| QA-47 | Check for real time/timers | `jest.useFakeTimers` usage | Consistent | STATIC |
| QA-48 | Check for network dependence | Grep for real HTTP in tests | Zero (or mocked) | STATIC |
| QA-49 | Check for flaky patterns | `setTimeout` in tests, arbitrary waits | None | STATIC |
| QA-50 | Record the runtime budget | 44.8 s today | A CI budget stated | **RUNTIME** |

### 6.8 TEST DATA

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| QA-51 | `helpers.ts` provides factories, not copy-paste fixtures | Read 394 lines | Factories present | STATIC |
| QA-52 | No real personal data in fixtures | Inspect | Synthetic | STATIC |
| QA-53 | Fixtures for connectors match live API shapes | Cross-check with R15 | Match or flagged | STATIC |
| QA-54 | A golden-file / snapshot strategy exists where useful | Grep `toMatchSnapshot` | Deliberate or absent | STATIC |

### 6.9 GAPS FOR THE NEXT DEFECT CLASS

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| QA-55 | **Specify the e2e suite that would have caught R-01** | Design | Playwright (or Electron `spectron`-successor) test: build → load `dist/index.html` → sign in → assert data loads | **WRITE** |
| QA-56 | Specify mobile e2e (Detox or Maestro) covering capture → queue → upload | Design | Scoped to 3 critical journeys | **WRITE** |
| QA-57 | Specify a Postgres-in-CI job | Design | Service container + migrate + full backend suite | **WRITE** |
| QA-58 | Specify a dependency/audit gate for CI | Design | `npm audit --omit=dev --audit-level=high` after zod v4 | **WRITE** |
| QA-59 | Specify an accessibility gate | Design | `jest-axe` per page + CI | **WRITE** |
| QA-60 | Specify the CI pipeline order and time budget | Design | build → typecheck → lint → contracts → unit → integration → e2e → a11y → audit → package | **WRITE** |

---

## 7. Known QA risks to confirm or refute

| Risk | Statement |
|------|-----------|
| **R-06 (HIGH)** | No e2e; 406 passing tests could not detect R-01 |
| — | Branch coverage 58.75 % — security error paths may be untested |
| — | Mutation score unknown; some tests may assert almost nothing |
| — | The OpenAPI validator may only compare paths |
| **R-08 (MEDIUM)** | 11 stories are `done` with unverified criteria |

---

## 8. Questions you must answer

1. **Why did 406 passing tests not catch R-01?** Explain mechanically.
2. What is the mutation score of the three most security-critical modules?
3. Which security-relevant branches are untested?
4. Which of the 11 `verification` blocks are genuinely impossible versus merely unmeasured?
5. Do the four contract validators prevent drift, or only enforce presence?
6. What is the smallest e2e suite that would have caught the last three real defects?

---

## 9. Commands to run

```bash
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund

# ---------- baseline ----------
npm test -- --ci --reporters=default
npm run test:coverage -- --coverageReporters=text-summary --coverageReporters=json-summary
node -e "const c=require('./coverage/coverage-summary.json');const rows=Object.entries(c)
  .filter(([k])=>k!=='total')
  .map(([k,v])=>[k.replace(process.cwd()+'/',''),v.statements.pct,v.branches.pct])
  .sort((a,b)=>a[2]-b[2]); rows.slice(0,40).forEach(r=>console.log(r[1].toString().padStart(6),r[2].toString().padStart(6),r[0]))"

# ---------- determinism ----------
npm test -- --ci >/dev/null && npm test -- --ci >/dev/null && echo "two clean runs"
npx jest --config jest.config.cjs --randomize --ci 2>&1 | tail -5

# ---------- mutation testing ----------
npm i -D @stryker-mutator/core @stryker-mutator/jest-runner @stryker-mutator/typescript-checker
npx stryker run --mutate 'apps/backend/src/services/auth-service.ts' 
npx stryker run --mutate 'apps/backend/src/http/guards.ts'
npx stryker run --mutate 'apps/backend/src/services/crypto.ts'

# ---------- contract validator experiments (revert after each) ----------
npm run test:prd
npm run test:api
npm run test:legal
npm run test:packaging
#  delete a route  → npm run test:api   (expect fail)
#  add a response field → npm run test:api (record result)
#  empty a verification block → npm run test:prd (expect fail)

# ---------- assertion census ----------
grep -rn "statusCode).toBe(200)" apps/backend/test | wc -l
grep -rn "expect(true)\|toHaveBeenCalled()" apps/backend/test apps/desktop/test apps/mobile/test | wc -l
grep -rnc "UNAUTHENTICATED\|FORBIDDEN\|ROLE_REQUIRED\|NOT_FOUND" apps/backend/test/*.ts | sort -t: -k2 -rn | head

# ---------- verification blocks ----------
node -e "const p=require('./PRD.json');p.stories.filter(s=>s.verification).forEach(s=>{
  console.log('\n###',s.id,'-',s.title);console.log(JSON.stringify(s.verification,null,2).slice(0,800))})"

# ---------- e2e absence ----------
grep -rn "playwright\|detox\|maestro\|cypress\|webdriver" package.json apps/*/package.json ; echo "exit=$?"
```

---

## 10. Tests to perform

| # | Test | Procedure | Pass criterion |
|---|------|-----------|----------------|
| T-01 | Baseline green run | `npm test` | 406 pass, recorded |
| T-02 | Coverage export | Per-file table | Produced |
| T-03 | Mutation: auth | Stryker | Score recorded |
| T-04 | Mutation: guards | Stryker | Score recorded |
| T-05 | Mutation: crypto | Stryker | Score recorded |
| T-06 | Validator sensitivity ×5 | Each validator, seeded drift | Every one fails on its own drift type |
| T-07 | Determinism | Two runs + shuffle | Identical |
| T-08 | Golden-test sensitivity | Break one critical assertion path | CI fails |
| T-09 | `verification` audit | All 11 blocks | Verdict per block |
| T-10 | Negative-test census | Count denial assertions | Table |
| T-11 | e2e proposal | Design the R-01 test | Written and justified |

---

## 11. Evidence required

```
docs/reviewers/evidence/R16/
├── test-inventory.md            # 30 suites, level, what each asserts, features covered
├── coverage-by-file.md          # full per-file table, sorted ascending
├── security-branch-gaps.md      # QA-09, QA-10, QA-11
├── mutation-report.md           # scores + surviving mutants interpreted
├── assertion-quality.md         # QA-21 … QA-26
├── validator-sensitivity.md     # T-06 with raw output
├── verification-block-audit.md  # QA-34 … QA-42
├── determinism.md               # T-07
├── test-plan-proposal.md        # QA-55 … QA-60: the target architecture
├── commands.log
└── findings.md                  # QA-### register
```

---

## 12. Passing conditions (chairs G2, G8)

- [ ] **P1** The test-shape inventory is complete and the missing e2e layer is documented as the primary finding (QA-01, QA-02).
- [ ] **P2** The mechanism by which R-01 escaped detection is explained and a test that catches it is specified (QA-04, QA-55).
- [ ] **P3** Mutation scores exist for `auth-service`, `guards`, `crypto` and the shared helpers, with survivors interpreted (QA-14 … QA-19, T-03 … T-05).
- [ ] **P4** Security-relevant uncovered branches are listed with a remediation plan (QA-09 … QA-12).
- [ ] **P5** Every contract validator is proven to fail on its own drift class — including response-shape drift, or its limitation is recorded (QA-27 … QA-33, T-06).
- [ ] **P6** All 11 `verification` blocks are audited and each story's `done` status is re-justified (QA-34 … QA-43, T-09).
- [ ] **P7** The suite is deterministic under repeat and shuffle (QA-44 … QA-50, T-07).
- [ ] **P8** An e2e suite exists in CI for the renderer **and** a mobile equivalent is planned (QA-55, QA-56, T-11).
- [ ] **P9** A CI pipeline design covers build → contracts → unit → integration → e2e → a11y → audit → package (QA-60).
- [ ] **P10** Coverage policy is per-area and written, not a single global number (QA-13).

---

## 13. Blocked items

| Item ID | Blocker | What unblocks it | Owner |
|---------|---------|------------------|-------|
| QA-56 | No mobile build | R11 | R11 |
| QA-04/T-11 | Needs a packaged renderer | R10 | R10 |

---

## 14. Findings register

| ID | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
|----|----------|-----------|---------|----------------|-----------|---------------|-------|
| QA-001 | | | | | | | |

---

## 15. Reviewer sign-off

| Field | Value |
|-------|-------|
| Reviewer name | |
| Date started | |
| Date completed | |
| **Gate G2 result** | ☐ Pass ☐ Fail |
| **Gate G8 result** | ☐ Pass ☐ Fail |
| Mutation scores (auth/guards/crypto) | / / |
| Conditions failed (IDs) | |
| Reviewed commit | `43d384b` |
| Statement | *I read all 30 suites, ran mutation testing on the security-critical modules, proved each contract validator's sensitivity by seeded drift, and audited every `verification` block.* |
| Signature | |
