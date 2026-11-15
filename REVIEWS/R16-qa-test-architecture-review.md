# REVIEWER NAME: QA Lead & Test Architecture Reviewer (R16)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R16-qa-test-architecture.md` (60 checklist items)
**STATUS:** ☑ Complete — **mutation testing not run** (no tool installed)

---

## AREAS EXAMINED

30 suites · 406 tests · coverage · mutation sensitivity · validator sensitivity · the 11 `verification` blocks · e2e absence · test architecture.

---

## 1. Summary of examination

I executed the full suite, generated coverage, read the jest configuration and helper harness, and **measured validator sensitivity by seeding drift**. I then audited each of the 11 PRD `verification` blocks against reality.

**Verdict: this is a genuinely good test suite that is blind in one specific, costly direction.** 406 tests and 30 suites with 74.47% statement coverage is well above typical for a project at this stage. But coverage is 58.75% on branches, there is **zero** end-to-end testing, no mutation testing, and every one of the 11 self-declared unverified claims remains unverified. The suite tests components; it does not test the product.

---

## 2. Files and components inspected

| File                                                 | Checked                    |
| ---------------------------------------------------- | -------------------------- |
| `jest.config.cjs`                                    | 5 projects, thresholds     |
| `apps/backend/test/helpers.ts`                       | 394 LOC — the harness      |
| 30 test suites                                       | inventory, assertion style |
| `scripts/validate-{prd,openapi,legal,packaging}.mjs` | sensitivity                |
| `PRD.json`                                           | the 11 verification blocks |
| `.github/workflows/ci.yml`                           | what CI actually runs      |

---

## 3. Features examined

Test pyramid · coverage thresholds · harness design · contract validators · verification-block honesty · e2e absence · regression protection.

---

## 4. Tests performed

| #   | Test                                      | Result                                                                   |
| --- | ----------------------------------------- | ------------------------------------------------------------------------ |
| T1  | Full suite                                | **PASS** — 406/406, 30 suites                                            |
| T2  | Coverage                                  | stmts **74.47%**, branches **58.75%**, funcs **66.2%**, lines **76.88%** |
| T3  | Branch threshold enforced?                | **NO** — no `coverageThreshold` blocking 58.75%                          |
| T4  | e2e framework installed                   | **NONE** — no Playwright/Cypress/Detox/Maestro                           |
| T5  | Mutation tool installed                   | **NONE** — no Stryker                                                    |
| T6  | **Validator sensitivity: delete a route** | **PASS** — validator failed correctly                                    |
| T7  | Validator sensitivity: corrupt property   | Inconclusive (malformed YAML failed at parse)                            |
| T8  | Validator detects response-shape drift    | **NO** — never inspects payloads                                         |
| T9  | 11 verification blocks audited            | **11/11 still unverified**                                               |
| T10 | Harness quality                           | **PASS** — ephemeral port, seeded DB                                     |
| T11 | Flaky tests                               | None observed in 3 runs                                                  |

---

## 5. Successful findings

1. **406 tests across 30 suites, all green, stable across repeated runs.** No flakiness observed.
2. **The harness is real** (`helpers.ts`, 394 LOC): ephemeral ports, seeded databases, fixture factories — not a pile of one-off mocks.
3. **Test names are behavioural.** "does not let one organisation revoke another organisation's device" states the guarantee; it is not `test('revoke', ...)`.
4. **Contract validators are wired into CI** and at least one is demonstrably sensitive (T6).
5. **Coverage is computed and visible**, so degradation would be noticed in review even without a hard gate.
6. **The suite is genuinely fast** — 45 seconds for 406 tests, which is why developers will actually run it.

---

## 6. Identified problems

### QA-001 — There is no end-to-end test, which is _why_ R-01 and MOB-001 survived

| Field            | Value                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **CRITICAL**                                                                                                                                                                                                  |
| **Affected**     | Test architecture                                                                                                                                                                                             |
| **Evidence**     | No Playwright, Cypress, Detox, or Maestro in any `package.json`. `ls node_modules/.bin \| grep -iE "playwright\|cypress\|detox\|maestro"` → empty. No test launches a packaged build, a browser, or a device. |
| **Expected**     | At least one test that exercises the shipping configuration                                                                                                                                                   |
| **Actual**       | Every test runs components in isolation with injected dependencies                                                                                                                                            |
| **Verification** | Dependency inventory; absence of any e2e config                                                                                                                                                               |

**Why CRITICAL:** the two most severe defects in this review — R-01 (desktop cannot reach its backend) and MOB-001 (no mobile app exists) — are both invisible to 406 passing tests. That is not coincidence; it is the direct consequence of testing only units. A single packaged-app sign-in test would have caught R-01 on day one. **The absence of e2e is the root cause of the entire class of defects this review found.**

**Recommended correction:** Add, in priority order:

1. **Desktop packaged sign-in** (Electron + `loadFile` + real backend) — catches R-01 and SEC-003.
2. **Mobile device smoke** (build + launch + capture) — catches MOB-001.
3. **API smoke through the real HTTP stack** — catches contract drift.

Even one would transform the safety of changes to the shipping path.

**Verification requirements:** A CI job that fails when the packaged app cannot authenticate.

---

### QA-002 — Branch coverage is 58.75% with no threshold

| Field            | Value                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **HIGH**                                                                                                              |
| **Affected**     | `jest.config.cjs`                                                                                                     |
| **Evidence**     | Branches 58.75%, functions 66.2%. No `coverageThreshold` in the Jest config, so coverage can fall without failing CI. |
| **Expected**     | A floor that ratchets                                                                                                 |
| **Actual**       | Reported, not enforced                                                                                                |
| **Verification** | Read `jest.config.cjs`; run `--coverage`                                                                              |

**Why HIGH:** branch coverage is the metric that matters for the defect class found here — unhandled error paths, missing guards, untaken fallbacks. 41% of branches untested in a security-sensitive application is a material gap, and nothing stops it worsening.

**Recommended correction:** Set `coverageThreshold` at current levels and raise deliberately. Prioritise branches in `guards.ts`, `auth-service.ts`, `crypto.ts`, `privacy-service.ts`.

---

### QA-003 — Mutation score is unknown

| Field            | Value                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **HIGH**                                                                                                        |
| **Affected**     | Test architecture                                                                                               |
| **Evidence**     | No mutation testing tool. 74% statement coverage says lines executed, not that assertions would catch a change. |
| **Expected**     | Mutation score on security-critical modules                                                                     |
| **Actual**       | Unknown                                                                                                         |
| **Verification** | No tool installed                                                                                               |

**Why HIGH:** a test that executes a line without asserting its effect provides no protection. In an auth system, a surviving mutant can be a live vulnerability. This is the single best measure of whether the 406 tests would catch a regression.

**Recommended correction:** Run Stryker on `auth/`, `guards.ts`, `crypto.ts`, `privacy-service.ts`, `csv.ts`. Target ≥70% mutation score on those files. Do not attempt whole-repo mutation — it is slow and the signal is diffuse.

---

### QA-004 — All 11 `verification` blocks remain unverified

| Field            | Value                                                                                                                                                                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **HIGH**                                                                                                                                                                                                                                                                                                          |
| **Affected**     | `PRD.json`                                                                                                                                                                                                                                                                                                        |
| **Evidence**     | 11 stories carry a `verification.notVerified` array — the authors' own statement of what was never demonstrated. I checked each; **none has since been verified.** Examples: "no OAuth flow and no token refresh" (CON-002), "There is no packaged-build sign-in test" (DESK-001), "no native project" (MOB-001). |
| **Expected**     | Each block either verified with evidence, or the story moved off `done`                                                                                                                                                                                                                                           |
| **Actual**       | All 45 stories are marked `done` while 11 carry written admissions of incompleteness                                                                                                                                                                                                                              |
| **Verification** | `node -e "require('./PRD.json').stories.filter(s=>s.verification).length"` → 11                                                                                                                                                                                                                                   |

**Correction to a common misreading:** the `verification` blocks are **not** evidence of dishonesty — they are unusually honest self-reporting. The defect is that the story status (`done`) contradicts the verification block, and `TASKS.md` states "Nothing open".

**Recommended correction:** Move the 11 stories to `in-progress` or `partial`, or add a `verified: true` field with evidence links. `done` should mean verified.

---

### QA-005 — Test distribution is skewed toward happy paths

| Field            | Value                                                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **MEDIUM**                                                                                                                                                                        |
| **Affected**     | 30 suites                                                                                                                                                                         |
| **Evidence**     | Coverage by area is uneven. Error-path tests are concentrated in security/privacy; the desktop suite (1,511 LOC) tests components in isolation and never the shell configuration. |
| **Expected**     | Adversarial cases in every domain                                                                                                                                                 |
| **Actual**       | Strong in backend security, weak in client integration                                                                                                                            |
| **Verification** | Coverage report by directory                                                                                                                                                      |

---

### QA-006 — No performance or load test exists

| Field            | Value                                                      |
| ---------------- | ---------------------------------------------------------- |
| **Severity**     | **MEDIUM**                                                 |
| **Affected**     | Test architecture                                          |
| **Evidence**     | No k6/autocannon/artillery. No latency assertion anywhere. |
| **Expected**     | At least a throughput baseline                             |
| **Actual**       | None                                                       |
| **Verification** | Dependency inventory                                       |

---

## 7. Missing functionality

| Item                   | Status                         |
| ---------------------- | ------------------------------ |
| E2E tests              | **Not implemented**            |
| Mutation testing       | **Not implemented**            |
| Coverage thresholds    | **Not implemented**            |
| Load/performance tests | **Not implemented**            |
| Visual regression      | **Not implemented**            |
| Accessibility tests    | **Not implemented** (A11Y-002) |
| Contract shape tests   | **Not implemented** (API-001)  |

---

## 8. Security concerns

Security-critical modules have the best direct coverage (`security.test.ts`, `auth.test.ts`), but without mutation testing there is no assurance the assertions are strong. The `AttemptLimiter` and placeholder-rewriter both have coverage; the rewriter's is incomplete (DB-003).

---

## 9. Performance concerns

Suite runtime is good (45 s). No product performance testing exists — that is R17's domain and it is entirely unstarted.

---

## 10. Recommendations

1. **Add one e2e test (QA-001).** It is the highest-leverage change available and it addresses the root cause of the two CRITICAL findings.
2. **Set coverage thresholds (QA-002)** at current levels and ratchet.
3. **Run mutation testing on the four security files (QA-003).**
4. **Reconcile the 11 verification blocks with story status (QA-004)** — `done` should mean verified.

---

## EVIDENCE CLASSIFICATION

| Class                        | Items                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| **A. Verified working**      | 406 stable tests, real harness, behavioural naming, one sensitive validator, fast runtime |
| **B. Verified failing**      | QA-002, QA-004                                                                            |
| **C. Not implemented**       | E2E, mutation, thresholds, load, visual, a11y, contract-shape                             |
| **D. Partially implemented** | Validators (path yes, payload no)                                                         |
| **E. Unable to verify**      | Mutation score, real-world regression sensitivity, product behaviour under load           |

---

## ISSUE SUMMARY

| ID     | Severity     | Title                                                      |
| ------ | ------------ | ---------------------------------------------------------- |
| QA-001 | **CRITICAL** | No e2e — root cause of R-01 and MOB-001                    |
| QA-002 | **HIGH**     | 58.75% branch coverage, unenforced                         |
| QA-003 | **HIGH**     | Mutation score unknown                                     |
| QA-004 | **HIGH**     | 11 verification blocks unverified while stories are `done` |
| QA-005 | MEDIUM       | Error-path coverage skewed                                 |
| QA-006 | MEDIUM       | No performance testing                                     |

**Totals: 1 CRITICAL · 3 HIGH · 2 MEDIUM · 0 LOW**
