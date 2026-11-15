# REVIEWER NAME: Documentation & Traceability Engineer (R20)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R20-documentation-traceability.md` (49 checklist items)
**STATUS:** ☑ Complete

---

## AREAS EXAMINED

24 Markdown documents (~250 KB) · `PRD.json` (45 stories) · `DECISIONS.md` (34 decisions) · 4 validators · the 11 verification blocks · `openapi.yaml`.

---

## 1. Summary of examination

I read every governance document, built a citation map for all 34 `DEC-###` identifiers, checked every referenced file path, and audited the 11 PRD verification blocks against the code.

**Verdict: the documentation culture here is a genuine asset and it has drifted in specific, findable places.** 34 of 34 decision citations resolve. The PRD is honest enough to record 11 unverified claims in its own data. But the first document a new engineer reads states that the application does not exist, and `TASKS.md` says nothing is open.

---

## 2. Files and components inspected

| Document                 | Size    | Checked                            |
| ------------------------ | ------- | ---------------------------------- |
| `ARCHITECTURE.md`        | 12.8 KB | claims §5, §6, §8                  |
| `README.md`              | 13.3 KB | test counts, feature claims        |
| `DATABASE.md`            | 44.8 KB | schema claims                      |
| `API.md`                 | 29.2 KB | route documentation                |
| `DECISIONS.md`           | 43.8 KB | all 34 decisions                   |
| `TASKS.md`               | 6.3 KB  | status claims                      |
| `AGENT_STATE.md`         | 12.1 KB | self-reported gaps                 |
| `DEPLOYMENT.md`          | 19 KB   | deployment claims                  |
| `PRD.json`               | 49.8 KB | 45 stories, 11 verification blocks |
| `scripts/validate-*.mjs` | —       | sensitivity                        |

---

## 3. Features examined

Traceability · citation integrity · path references · validator sensitivity · claim accuracy · duplication.

---

## 4. Tests performed

| #   | Test                                | Result                                             |
| --- | ----------------------------------- | -------------------------------------------------- |
| T1  | `DEC-###` cited vs defined          | **PASS** — 34 cited, 34 defined, **zero dangling** |
| T2  | Referenced paths exist              | **PASS** — no broken full-path reference found     |
| T3  | `npm run test:prd`                  | **PASS**                                           |
| T4  | `npm run test:api`                  | **PASS**                                           |
| T5  | `npm run test:legal`                | **PASS**                                           |
| T6  | `npm run test:packaging`            | **PASS**                                           |
| T7  | Validator sensitivity: delete route | **PASS** — failed correctly                        |
| T8  | Validator detects response drift    | **NO**                                             |
| T9  | 11 verification blocks audited      | **11/11 unverified**                               |
| T10 | Drift items confirmed               | **3 confirmed**                                    |

---

## 5. Successful findings

1. **All 34 `DEC-###` citations resolve.** Zero dangling references — this is rarer than it should be, and it means the decision log is genuinely used rather than decorative.
2. **`PRD.json` records its own incompleteness.** 11 stories carry explicit `notVerified` arrays naming exactly what was never demonstrated. The authors documented their own gaps precisely enough that this review could verify them.
3. **`AGENT_STATE.md` and `TASKS.md` distinguish product gaps from operations gaps** and name them.
4. **Four contract validators are enforced in CI**, and one (`test:api`) is demonstrably sensitive to path drift.
5. **`TESTING.md` §3.1 explains verification-block semantics**, so the honesty convention is itself documented.

---

## 6. Identified problems

### DOCS-001 — `ARCHITECTURE.md` §8 states the application does not exist

| Field            | Value                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **MEDIUM**                                                                                                              |
| **Affected**     | `ARCHITECTURE.md:192`                                                                                                   |
| **Evidence**     | _"No application code, so none of the above is implemented."_ The repository contains 245 tracked files and ~41.3k LOC. |
| **Expected**     | The primary architecture document describes the system that exists                                                      |
| **Actual**       | It denies the system exists                                                                                             |
| **Verification** | `grep -n "No application code" ARCHITECTURE.md` → line 192                                                              |

**Recommended correction:** Replace with an implemented/deferred split. This single line is the most damaging sentence in the repository because it is read first and it is false in the most demoralising direction.

---

### DOCS-002 — `ARCHITECTURE.md` describes a `prisma/` layout that was never used

| Field            | Value                                                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **LOW**                                                                                                                                                                          |
| **Affected**     | `ARCHITECTURE.md:168`                                                                                                                                                            |
| **Evidence**     | The target layout tree includes `└── prisma/{schema.prisma,migrations,seed.ts}`. No `prisma/` directory exists; migrations are hand-written in `db/migrations.ts` under DEC-013. |
| **Expected**     | Layout reflects reality or is marked superseded                                                                                                                                  |
| **Actual**       | Cites an unused tool                                                                                                                                                             |
| **Verification** | `ls apps/backend/prisma` → absent                                                                                                                                                |

---

### DOCS-003 — `TASKS.md` states the queue is empty while 11 stories carry unverified claims

| Field            | Value                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Severity**     | **MEDIUM**                                                                                                                                                                                                   |
| **Affected**     | `TASKS.md`                                                                                                                                                                                                   |
| **Evidence**     | The file's premise is "what we are doing **now**" and it lists completed milestones. Meanwhile `PRD.json` marks all 45 stories `done` while 11 carry `notVerified` blocks, and three CRITICAL defects exist. |
| **Expected**     | The work queue reflects the actual open items                                                                                                                                                                |
| **Actual**       | It reflects a milestone boundary, not reality                                                                                                                                                                |
| **Verification** | Read `TASKS.md` against `PRD.json` verification blocks                                                                                                                                                       |

---

### DOCS-004 — Advisory counts are understated in two documents

| Field            | Value                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Severity**     | **MEDIUM**                                                                                                                                                                                                                                       |
| **Affected**     | `AGENT_STATE.md`; `AUDIT-2026-10.md` §4.2                                                                                                                                                                                                        |
| **Evidence**     | Both describe the dependency situation as roughly "9 advisories, all transitive or build-time", and describe `zod` as transitive. Measured: **23 total, 8 production** (1 critical, 5 high); `zod` is a **direct** dependency of `apps/backend`. |
| **Expected**     | Accurate figures with the direct/transitive split                                                                                                                                                                                                |
| **Actual**       | Understated by more than half, with the most important dependency misclassified                                                                                                                                                                  |
| **Verification** | `npm audit --omit=dev --json`; `grep zod apps/backend/package.json`                                                                                                                                                                              |

---

### DOCS-005 — Four validators check presence and structure, not behaviour

| Field            | Value                                                                                                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **MEDIUM**                                                                                                                                                                                                                                         |
| **Affected**     | `scripts/validate-{prd,openapi,legal,packaging}.mjs`                                                                                                                                                                                               |
| **Evidence**     | `test:api` catches path drift (proven) but never inspects a payload. `test:legal` **requires placeholders to remain** ("placeholders intact"). `test:packaging` passes while no buildable artefact exists. `test:prd` validates schema, not truth. |
| **Expected**     | Tests that fail when reality diverges                                                                                                                                                                                                              |
| **Actual**       | Tests that fail when _shape_ diverges                                                                                                                                                                                                              |
| **Verification** | Read each script; seed drift                                                                                                                                                                                                                       |

**Note:** `test:legal` requiring placeholders is defensible pre-launch, but it must be inverted before release or it will happily ship `[COMPANY NAME]` to a customer.

---

### DOCS-006 — `DEPLOYMENT.md` documents a build-time injection mechanism that does not exist

| Field            | Value                                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **MEDIUM**                                                                                                                                                       |
| **Affected**     | `DEPLOYMENT.md` (line ~104)                                                                                                                                      |
| **Evidence**     | Claims `API_BASE_URL` is "baked per build environment". No such mechanism exists — `vite.config.ts` has no define, and `App.tsx` passes no `baseUrl` (DESK-001). |
| **Expected**     | Deployment docs describe what the build actually does                                                                                                            |
| **Actual**       | Documents a mechanism that would have prevented R-01 if it were real                                                                                             |
| **Verification** | Read `vite.config.ts`; grep `VITE_`                                                                                                                              |

---

## 7. Missing functionality

| Item                                     | Status                        |
| ---------------------------------------- | ----------------------------- |
| Traceability matrix (45 stories → tests) | **Not implemented**           |
| Doc-drift CI check                       | **Not implemented**           |
| Response-shape contract test             | **Not implemented** (API-001) |
| Changelog discipline against git log     | **Unverified**                |

---

## 8. Security concerns

`SECURITY.md` claims were sampled against code and are substantially accurate. The advisory understatement (DOCS-004) is the one place where documentation creates a false sense of safety.

---

## 9. Performance concerns

None.

---

## 10. Recommendations

1. **Fix `ARCHITECTURE.md` §8 and §6** (DOCS-001/002) — cheap, high signal.
2. **Correct the advisory figures** (DOCS-004).
3. **Reconcile `TASKS.md`** with the 11 verification blocks (DOCS-003).
4. **Invert `test:legal`** before release so placeholders fail rather than pass (DOCS-005).

---

## EVIDENCE CLASSIFICATION

| Class                        | Items                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **A. Verified working**      | 34/34 citations resolve, PRD self-reporting, `TESTING.md` semantics, 4 validators in CI, one demonstrably sensitive |
| **B. Verified failing**      | DOCS-001 … DOCS-006                                                                                                 |
| **C. Not implemented**       | Traceability matrix, doc-drift check, shape contract                                                                |
| **D. Partially implemented** | Validators (presence yes, behaviour no)                                                                             |
| **E. Unable to verify**      | Whether `CHANGELOG.md` matches history entry-for-entry                                                              |

---

## ISSUE SUMMARY

| ID       | Severity | Title                                              |
| -------- | -------- | -------------------------------------------------- |
| DOCS-001 | MEDIUM   | `ARCHITECTURE.md` §8 denies the app exists         |
| DOCS-002 | LOW      | Cites non-existent `prisma/`                       |
| DOCS-003 | MEDIUM   | `TASKS.md` says nothing is open                    |
| DOCS-004 | MEDIUM   | Advisory counts understated; `zod` misclassified   |
| DOCS-005 | MEDIUM   | Validators check shape, not behaviour              |
| DOCS-006 | MEDIUM   | `DEPLOYMENT.md` documents a non-existent mechanism |

**Totals: 0 CRITICAL · 0 HIGH · 5 MEDIUM · 1 LOW**
