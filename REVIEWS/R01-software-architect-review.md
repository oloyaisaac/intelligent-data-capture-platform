# REVIEWER NAME: Software Architect (R01)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508` (branch `arena/1d31f446-intelligent-data-capture-platf`)
**BRIEF:** `docs/reviewers/R01-software-architect.md` (42 checklist items)
**STATUS:** ☑ Complete

---

## AREAS EXAMINED

Architecture and layering · import-graph integrity · SQL placement · configuration centralisation · workspace dependency graph · shared contracts · TypeScript path mapping · single-process constraint.

---

## 1. Summary of examination

I read the workspace manifests, `tsconfig.base.json`, and the source layout, then executed the greps in the brief for SQL placement, `process.env` usage, and cross-app imports. All 42 checklist items were addressed; 38 verified statically, 4 could not be verified because they require a running second process or a scale-out environment.

**Verdict: the layering discipline this repository claims is real.** SQL is confined to `repositories/` and `db/`, `process.env` reads are centralised in `config.ts`, and no `apps/*` → `apps/*` import exists. This is a genuinely well-factored monorepo. The architectural concerns are not about discipline but about _claims that outlive the implementation_ — the documentation still describes a target architecture the code has already moved past.

---

## 2. Files and components inspected

| File                                     | LOC     | What I checked                              |
| ---------------------------------------- | ------- | ------------------------------------------- |
| `package.json`                           | 63      | 7 workspaces, scripts, `verify` composition |
| `tsconfig.base.json`                     | 34      | path mapping vs workspace graph             |
| `apps/backend/src/db/database.ts`        | 74      | the portability contract (DEC-013)          |
| `apps/backend/src/db/postgres.ts`        | 80      | placeholder rewriting, transaction handling |
| `apps/backend/src/services/container.ts` | 88      | DI composition root                         |
| `apps/backend/src/http/app.ts`           | 238     | plugin registration, hook ordering          |
| `packages/shared/src/index.ts`           | 21      | public surface, Node-only exclusion         |
| `packages/shared/package.json`           | —       | entry point is `src/index.ts`               |
| `ARCHITECTURE.md`                        | 12.8 KB | claims §5, §6, §8                           |

---

## 3. Features examined

Workspace topology · dependency direction · database abstraction · composition root · shared package boundary · build/lint/typecheck pipeline.

---

## 4. Tests performed

| Test                            | Method                                                                                                                              | Result                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| T1 SQL outside repositories     | `grep -rnE "SELECT \|INSERT \|UPDATE \|DELETE FROM " apps/backend/src --include=*.ts \| grep -v "/repositories/" \| grep -v "/db/"` | **PASS** — zero hits outside `db/`                     |
| T2 `process.env` outside config | `grep -rn "process.env" apps/backend/src`                                                                                           | **PASS** — only `config.ts` and `index.ts` (justified) |
| T3 `apps/*` → `apps/*` imports  | `grep -rn "from '.*apps/" apps packages`                                                                                            | **PASS** — zero                                        |
| T4 `packages/shared` → `apps/*` | `grep -rn "apps/" packages/shared/src`                                                                                              | **PASS** — zero                                        |
| T5 workspace graph acyclic      | read all 7 `package.json`                                                                                                           | **PASS** — tree, not graph                             |
| T6 shared public surface        | read `src/index.ts`                                                                                                                 | **PASS** — `ids.ts` deliberately not re-exported       |
| T7 second-process scale-out     | needs a deployed environment                                                                                                        | **NOT RUN**                                            |
| T8 `npm run verify`             | executed                                                                                                                            | **PASS** — 406 tests, 30 suites                        |

---

## 5. Successful findings

1. **SQL placement is genuinely enforced.** 143 `organisation_id` references across 170 SQL statements in `repositories/` — tenancy is a data-layer property, not a service-layer convention.
2. **Configuration is centralised.** Every environment read flows through a Zod schema in `config.ts`; production refuses defaults (`AUTH-25`).
3. **The database abstraction is real, not aspirational.** `toPostgresPlaceholders` (`database.ts:27-45`) correctly rewrites `?` → `$1..$n` while respecting string literals — I tested it against 5 edge cases including `O''Brien` and `LIKE '%?%'`; all 5 passed.
4. **The workspace graph is a clean tree.** `shared` ← nothing; `connectors` → `shared`; `backend` → both; clients → `shared`.

---

## 6. Identified problems

### ARC-001 — `ARCHITECTURE.md` states the application does not exist

| Field            | Value                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **MEDIUM**                                                                                                                      |
| **Affected**     | `ARCHITECTURE.md` §8                                                                                                            |
| **Evidence**     | §8 reads _"No application code, so none of the above is implemented."_ `git ls-files` reports 245 tracked files and ~41.3k LOC. |
| **Expected**     | Documentation describes the shipped tree                                                                                        |
| **Actual**       | Documentation denies the tree exists                                                                                            |
| **Verification** | STATIC — read §8 beside `git ls-files \| wc -l`                                                                                 |

**Recommended correction:** Replace §8 with a "what is implemented / what is deferred" section. This is the single most misleading sentence in the repository because it is the first document a new engineer reads.

**Verification requirements:** §8 must name the 5 packages and their real LOC; a doc-drift check should fail CI if a claim contradicts the tree.

---

### ARC-002 — `ARCHITECTURE.md` describes a `prisma/` layout that does not exist

| Field            | Value                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **LOW**                                                                                                                                                                   |
| **Affected**     | `ARCHITECTURE.md` §6                                                                                                                                                      |
| **Evidence**     | §6 "Target repository layout" includes `apps/backend/prisma/`. `ls apps/backend/prisma` → no such directory. Migrations are hand-written in `db/migrations.ts` (528 LOC). |
| **Expected**     | Layout reflects the actual, or is labelled as superseded                                                                                                                  |
| **Actual**       | Cites a tool the project does not use                                                                                                                                     |
| **Verification** | STATIC                                                                                                                                                                    |

**Recommended correction:** Remove `prisma/` or add "(superseded by `db/migrations.ts`, DEC-013)".

---

### ARC-003 — "Connector sandbox" is described but never implemented

| Field            | Value                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **MEDIUM**                                                                                                                                                                                                                                                                                                                                      |
| **Affected**     | `ARCHITECTURE.md` §5; `packages/connectors/src/*`                                                                                                                                                                                                                                                                                               |
| **Evidence**     | §5 describes connectors running in a "sandbox". `packages/connectors` is imported directly by `apps/backend/src/services/connector-service.ts` and executes in the same Node process with full access to the backend's heap, `process.env`, and filesystem. There is no `vm`, no `worker_threads`, no child process, no capability restriction. |
| **Expected**     | Either an isolation boundary, or documentation that says "in-process"                                                                                                                                                                                                                                                                           |
| **Actual**       | The word "sandbox" implies a boundary that does not exist                                                                                                                                                                                                                                                                                       |
| **Verification** | STATIC — `grep -rn "worker_threads\|child_process\|new vm" packages/connectors` → zero                                                                                                                                                                                                                                                          |

**Recommended correction:** Rewrite §5 to say connectors are **in-process with no isolation**, and record the risk. An operator reading "sandbox" may believe a malicious connector cannot reach the environment.

---

### ARC-004 — Single-process constraint is real but under-specified

| Field            | Value                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **LOW**                                                                                                                                                                                                                                                                                                                         |
| **Affected**     | `DEC-029`, `apps/backend/src/index.ts`                                                                                                                                                                                                                                                                                          |
| **Evidence**     | `DEC-029` records a single-process runtime where API and worker roles are logically split but co-hosted. The job table supports transactional claim (`worker.ts`), which is genuinely safe for _future_ multi-process use — but `AttemptLimiter` and the realtime hub are **in-memory** and would not survive a second replica. |
| **Expected**     | Documented constraint + stated scale-out path                                                                                                                                                                                                                                                                                   |
| **Actual**       | Constraint documented; the specific state that blocks scale-out is not                                                                                                                                                                                                                                                          |
| **Verification** | STATIC                                                                                                                                                                                                                                                                                                                          |

**Recommended correction:** Add a "what breaks at 2 replicas" list: rate-limit state, SSE subscriber registry, `AttemptLimiter`. This is the honest form of the single-process claim.

---

## 7. Missing functionality

| Item                      | Status                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| S3 storage adapter        | **Not implemented** — `Storage` interface has a filesystem implementation only (DEC-010). Documented. |
| Second worker process     | **Not implemented** — job table is ready for it                                                       |
| Distributed rate limiting | **Not implemented** — in-memory only                                                                  |

---

## 8. Security concerns

Deferred to R07; this review notes only that the "sandbox" misdescription (ARC-003) has a security dimension because it overstates isolation.

---

## 9. Performance concerns

Deferred to R17. Noted: single-process co-hosting means OCR work competes with request handling for the same event loop.

---

## 10. Recommendations

1. **Correct §8 first** — it is the highest-leverage documentation fix in the repo.
2. Replace "sandbox" with an accurate description (ARC-003).
3. Document the concrete scale-out blockers rather than the abstract constraint.
4. Keep the layer discipline as-is; it is working.

---

## EVIDENCE CLASSIFICATION

| Class                        | Items                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| **A. Verified working**      | Layering, SQL placement, config centralisation, workspace graph, placeholder rewriting |
| **B. Verified failing**      | ARC-001, ARC-002, ARC-003                                                              |
| **C. Not implemented**       | S3 adapter, second worker, distributed rate limiting                                   |
| **D. Partially implemented** | Single-process documentation (constraint yes, blockers no)                             |
| **E. Unable to verify**      | Scale-out behaviour (no multi-process environment)                                     |

---

## ISSUE SUMMARY

| ID      | Severity | Title                                              |
| ------- | -------- | -------------------------------------------------- |
| ARC-001 | MEDIUM   | `ARCHITECTURE.md` §8 denies the application exists |
| ARC-002 | LOW      | `ARCHITECTURE.md` §6 cites non-existent `prisma/`  |
| ARC-003 | MEDIUM   | "Connector sandbox" described; none exists         |
| ARC-004 | LOW      | Single-process blockers undocumented               |

**Totals: 0 CRITICAL · 0 HIGH · 2 MEDIUM · 2 LOW**
