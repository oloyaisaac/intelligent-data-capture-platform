# REVIEWER NAME: Database Engineer / Data-Integrity Specialist (R03)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R03-database-engineer.md` (50 checklist items)
**STATUS:** ☑ Complete — **with one CRITICAL item unverifiable (see DB-001)**

---

## AREAS EXAMINED

Schema and migrations (10 migrations, 32 tables, 30 indexes) · portability layer · transaction boundaries · tenancy scoping · index coverage · retention purge · backup/restore.

---

## 1. Summary of examination

I read all 528 lines of `migrations.ts`, the `Database` interface, both drivers, and the transaction helper. I executed the suite on SQLite (406 tests) and **attempted** to execute the migration set against PostgreSQL — this was impossible: no `psql`, no `pg_ctl`, no Docker in the environment (`which docker psql postgres initdb` → all absent; `/usr/lib/postgresql` does not exist).

I therefore did what the brief permits and what the honesty rule demands: I verified everything verifiable **statically**, and classified the PostgreSQL execution as **E. Unable to verify** rather than inferring either success or failure.

**This is the single most consequential unknown in the repository.** The production database path has never been executed by anyone, in any environment, and the migration set is the most likely thing to fail first at boot.

---

## 2. Files and components inspected

| File                                               | LOC | Checked                                                 |
| -------------------------------------------------- | --- | ------------------------------------------------------- |
| `apps/backend/src/db/migrations.ts`                | 528 | 10 migrations, all DDL, `schema_migrations` bookkeeping |
| `apps/backend/src/db/database.ts`                  | 74  | `Database` interface, `toPostgresPlaceholders`          |
| `apps/backend/src/db/postgres.ts`                  | 80  | `Pool`, transaction, rewrite usage                      |
| `apps/backend/src/db/sqlite.ts`                    | 90  | `node:sqlite` usage, synchronous behaviour              |
| `apps/backend/src/db/index.ts`                     | 35  | driver selection                                        |
| `apps/backend/src/db/migrate-cli.ts`               | 21  | runner                                                  |
| `apps/backend/src/services/maintenance-service.ts` | 195 | retention purge                                         |
| `apps/backend/src/repositories/*.ts`               | —   | 143 `organisation_id` references                        |
| `apps/backend/test/security.test.ts`               | —   | the only rewriter test (2 assertions)                   |

---

## 3. Features examined

Migration application · placeholder portability · boolean/timestamp/JSON representation · transaction atomicity · tenancy scoping · index coverage · retention purge · schema bookkeeping.

---

## 4. Tests performed

| Test                                  | Method                                                     | Result                                        |
| ------------------------------------- | ---------------------------------------------------------- | --------------------------------------------- |
| T1 SQLite migration + suite           | `npm run verify`                                           | **PASS** — 406 tests                          |
| T2 **PostgreSQL migration**           | `DB_DRIVER=postgres npm run db:migrate`                    | **NOT RUN — no PostgreSQL available**         |
| T3 Placeholder rewriter, 5 edge cases | extracted logic, ran directly                              | **PASS** — 5/5 incl. `O''Brien`, `LIKE '%?%'` |
| T4 Existing rewriter test coverage    | read `security.test.ts:182`                                | **PARTIAL** — 2 of my 5 cases                 |
| T5 DDL portability scan               | grep for `AUTOINCREMENT\|PRAGMA\|datetime(\|WITHOUT ROWID` | **PASS** — zero hits                          |
| T6 Type inventory                     | grep types in DDL                                          | `TEXT` 290, `INTEGER` 28, `REAL` 4, `JSON` 2  |
| T7 Transaction usage                  | grep `db.transaction` in services                          | **PARTIAL** — see DB-002                      |
| T8 Index coverage                     | 30 `CREATE INDEX` vs 32 tables                             | **UNVERIFIED** — needs EXPLAIN on PG          |
| T9 Retention purge                    | read `maintenance-service.ts`                              | **PARTIAL** — see DB-004                      |

---

## 5. Successful findings

1. **The DDL is genuinely portable.** No `AUTOINCREMENT`, no `PRAGMA`, no `datetime()`, no `WITHOUT ROWID`. Types are `TEXT/INTEGER/REAL/JSON` — all accepted by PostgreSQL. This is a real achievement for a dual-driver schema.
2. **The placeholder rewriter is correct**, including the subtle cases the existing test omits: escaped quotes (`O''Brien`) and `?` inside `LIKE '%?%'` both pass. It tracks single-quote state.
3. **Every write path I sampled is parameterised.** 143 `organisation_id` predicates across ~170 statements means tenancy is enforced in the data layer.
4. **`schema_migrations` bookkeeping is sound** — idempotent `CREATE TABLE IF NOT EXISTS`, per-migration application, forward-only.
5. **Statements are applied individually** (`for (const statement of migration.sql) await db.execute(statement)`), which avoids the multi-statement parsing differences between drivers.

---

## 6. Identified problems

### DB-001 — **PostgreSQL has never been executed. The production database path is entirely unverified.**

| Field            | Value                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **CRITICAL**                                                                                                                                                                                                                                                                                                                          |
| **Affected**     | `apps/backend/src/db/postgres.ts`, `migrations.ts`, whole production path                                                                                                                                                                                                                                                             |
| **Evidence**     | `grep -rn "DB_DRIVER" apps/backend/test/*.ts` → every occurrence is either asserting the **default is `sqlite`** or asserting that `postgres` requires `DATABASE_URL`. **No test ever constructs a PostgreSQL connection.** `docker`, `psql`, `postgres`, `initdb` are all absent from the environment, so I could not run it either. |
| **Expected**     | The migration set applies cleanly on PostgreSQL 16 and the backend suite passes against it                                                                                                                                                                                                                                            |
| **Actual**       | **Unknown.** Never executed by any process in this repository's history as far as I can determine.                                                                                                                                                                                                                                    |
| **Verification** | `DB_DRIVER=postgres DATABASE_URL=postgres://... npm run db:migrate` on a real PG16 instance                                                                                                                                                                                                                                           |

**Why this is CRITICAL and not merely HIGH:** the assessment classified it HIGH. I am escalating it. The default configuration selects SQLite; production _requires_ PostgreSQL (`config.ts` rejects a missing `DATABASE_URL`). Therefore the **only** configuration that ships to customers is the **only** configuration that has never run. If it fails, it fails at first boot, in production, with no test to have caught it — the same failure class as R-01, in a different layer.

**Recommended correction:** Provision PG16 in CI as a service container and run `db:migrate` plus the full suite against it. Either it passes (downgrade to LOW, keep the CI job forever) or it fails (and every downstream estimate is invalid).

**Verification requirements:** A CI job on `postgres:16` executing migrations + suite; a recorded result. **This must be resolved before R17 measures anything**, because load numbers on SQLite describe a different system.

---

### DB-002 — Transactions do not cover the storage write, so "atomic" is only half true

| Field            | Value                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| **Severity**     | **HIGH**                                                                                         |
| **Affected**     | `apps/backend/src/services/document-service.ts:116-118`                                          |
| **Evidence**     | `storage.put()` precedes `db.transaction()` (see BE-001, same root cause, different consequence) |
| **Expected**     | Data and blob are consistent after any failure                                                   |
| **Actual**       | Rows roll back; the blob does not                                                                |
| **Verification** | STATIC                                                                                           |

**Recommended correction / verification:** As BE-001. From the data-integrity perspective the requirement is stronger: a **reconciliation query** must exist and be tested. Cross-referenced as the same underlying defect.

---

### DB-003 — The placeholder rewriter's test coverage omits the cases most likely to regress

| Field            | Value                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **LOW**                                                                                                                                                         |
| **Affected**     | `apps/backend/test/security.test.ts:182-189`                                                                                                                    |
| **Evidence**     | Two assertions. Neither covers embedded escaped quotes (`'O''Brien'`) nor a literal `?` inside a `LIKE` pattern — both of which **do** work, but are unguarded. |
| **Expected**     | Edge-case coverage for a function whose failure silently corrupts every query                                                                                   |
| **Actual**       | Happy path + one `?`-in-literal case                                                                                                                            |
| **Verification** | STATIC; I proved the missing cases pass by running the logic directly                                                                                           |

**Recommended correction:** Add the three missing assertions. Cheap, and this function is load-bearing for the entire PostgreSQL migration.

---

### DB-004 — Retention purge deletes rows but its file-deletion failure is silent

| Field            | Value                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **MEDIUM**                                                                                                                                                                      |
| **Affected**     | `apps/backend/src/services/maintenance-service.ts` (purge path)                                                                                                                 |
| **Evidence**     | The purge job removes documents past `retention_days`; file removal follows the row deletion with the same best-effort pattern as `privacy-service.ts:220` (warn and continue). |
| **Expected**     | Retention expiry removes the data, or reports a verifiable residue count                                                                                                        |
| **Actual**       | Residue is logged at `warn` and never reconciled                                                                                                                                |
| **Verification** | STATIC; cross-ref PRIV-002                                                                                                                                                      |

**Recommended correction:** Track a `purge_residue` counter and expose it; a retention promise that silently fails is worse than no promise.

---

### DB-005 — Index adequacy is asserted in `DATABASE.md` but never demonstrated

| Field            | Value                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **MEDIUM**                                                                                                                                  |
| **Affected**     | `DATABASE.md`; 30 indexes across 32 tables                                                                                                  |
| **Evidence**     | 30 `CREATE INDEX` statements exist, but no `EXPLAIN` output is recorded anywhere and no query plan is attached to any hot-path description. |
| **Expected**     | Hot-path queries shown using indexes                                                                                                        |
| **Actual**       | Presence of indexes is documented; their use is not                                                                                         |
| **Verification** | Requires PG + `EXPLAIN (ANALYZE, BUFFERS)`                                                                                                  |

**Recommended correction:** Attach plans for the 5 hottest queries (document list, review queue, dashboard aggregate, audit export, job claim) once DB-001 is resolved.

---

## 7. Missing functionality

| Item                       | Status                                                   |
| -------------------------- | -------------------------------------------------------- |
| PostgreSQL CI job          | **Not implemented**                                      |
| Orphan-blob reconciliation | **Not implemented**                                      |
| Migration rollback path    | **Not implemented** — forward-only by design, documented |
| Backup / restore tooling   | **Not implemented** — no `db:backup` script exists       |
| EXPLAIN-based index proof  | **Not implemented**                                      |

---

## 8. Security concerns

Tenancy scoping is present in the data layer (143 predicates) — a genuine strength. No SQL injection found; all statements parameterised. The unverified PostgreSQL path is itself a security-adjacent risk: an untested driver may surface errors that leak internals.

---

## 9. Performance concerns

`node:sqlite` is **synchronous** — every query blocks the event loop. This is acceptable for dev/test and **unacceptable** for production load; it is one more reason DB-001 must be resolved before any performance claim. Deferred to R17.

---

## 10. Recommendations

1. **Resolve DB-001 before anything else.** It is a release blocker and the cheapest one to close: one service container in CI.
2. Add the three missing rewriter assertions (DB-003) — minutes of work, protects the whole PG path.
3. Add orphan reconciliation (DB-002).
4. Make retention residue observable (DB-004).
5. Record EXPLAIN plans once PG exists (DB-005).

---

## EVIDENCE CLASSIFICATION

| Class                        | Items                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| **A. Verified working**      | DDL portability, placeholder rewriter correctness, tenancy scoping, migration bookkeeping, SQLite path |
| **B. Verified failing**      | DB-002, DB-004                                                                                         |
| **C. Not implemented**       | PG CI, orphan sweeper, rollback, backup tooling, EXPLAIN proof                                         |
| **D. Partially implemented** | Upload atomicity (rows yes, blob no); retention purge (rows yes, files best-effort)                    |
| **E. Unable to verify**      | **PostgreSQL migration execution (DB-001), index effectiveness (DB-005), production load behaviour**   |

---

## ISSUE SUMMARY

| ID     | Severity     | Title                                                    |
| ------ | ------------ | -------------------------------------------------------- |
| DB-001 | **CRITICAL** | PostgreSQL never executed; production path unverified    |
| DB-002 | HIGH         | Transactions exclude storage write; orphans unreconciled |
| DB-003 | LOW          | Rewriter test omits regression-prone cases               |
| DB-004 | MEDIUM       | Retention purge file-deletion failure is silent          |
| DB-005 | MEDIUM       | Index adequacy asserted, never demonstrated              |

**Totals: 1 CRITICAL · 1 HIGH · 2 MEDIUM · 1 LOW**
