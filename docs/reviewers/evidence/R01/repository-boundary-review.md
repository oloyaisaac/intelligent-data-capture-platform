# R01 repository-layer boundary review (ARC-AC-01, ARC-AC-04)

**Scope:** all 27 files in `apps/backend/src/repositories/` plus `storage-references.ts`, against
ARC-AC-01 ("no SQL outside `repositories/` and `db/`") and ARC-AC-04 ("no business rules in
repositories; only persistence + row mapping"). Baseline `9ec567c`. This is a static reading, not a
functional review; query correctness and schema belong to R03.

## ARC-AC-01 — literal and dynamic SQL placement

`sql-boundary-9ec567c.txt` records the sweep. The literal scan
(`SELECT |INSERT |UPDATE |DELETE FROM `) returns **no matches** outside `db/` and `repositories/`,
and no `.execute/.query/.one()` template with an interpolation exists outside those two directories.
The earlier "six non-SQL hits" recorded in the checklist were comments and error strings; they no
longer match at this baseline.

Every interpolation that does exist is inside repositories and is one of three fixed shapes:

| Site                                                                                  | Interpolated value                                                    | Source of the value                                                          |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `worker-error-remediation-repo.ts:44-47`, `connector-error-remediation-repo.ts:55-60` | `COLLATE ${collation}`, conditional `AND id … > ?`, `${placeholders}` | `'\"C\"'`/`'BINARY'` from `db.driver`; `'?'` literals from a module constant |
| `system-repo.ts:61-72,190-199,325`                                                    | ` FOR UPDATE`, `clauses.join(' AND ')`, `LIMIT ?`                     | driver discriminator and fixed clause strings; values stay bound             |
| `document-repo.ts:263-284`, `batch-error-remediation-repo.ts:72-102`                  | `clauses.join(' AND ')`, `${eligible}`                                | fixed clause strings, no user text                                           |

No interpolation carries a request value: user input is always a bound parameter. That is the
mechanism ARC-AC-01 depends on, and it holds. The residual risk is not this layer but
`toPostgresPlaceholders` (ARC-046): a `?` inside a bound _value_ is safe, a `?` inside a SQL
literal or comment is not, and that is a `db/` concern already routed to R03/R02.

**ARC-AC-01: met for the literal and dynamic claim at this baseline.** An independent reviewer still
has to confirm the final commit and that no code path builds SQL from a template outside these files
at runtime — static scans cannot prove absence.

## ARC-AC-04 — business rules found in the persistence layer

Four substantive findings, then the near-misses that should not be treated as defects.

### 1. Retry, backoff and terminal-state policy (extends ARC-048)

`system-repo.ts:184-207` decides the job's retry policy: `exhausted = attempts >= max_attempts`, the
exponential backoff `Math.min(2 ** job.attempts * 1000, 60_000)`, the next `run_after`, and whether
the job becomes `dead` or `queued`. That is execution policy, not persistence, and it is the only
place it exists — no service applies, validates or reports it. Consequences worth stating precisely:

- Changing retry behaviour means editing a repository, so a policy change and a schema change sit in
  the same file.
- The clamp and the exhaustion comparison are not configurable, tested only through job behaviour,
  and invisible to any service-level report of "dead" jobs.
- The guarded `UPDATE … WHERE status='running' AND attempts=?` must survive any refactor; it is the
  fence that keeps a stale worker from resurrecting a recovered job.

### 2. A retention rule (`retention_days <= 0`) inside a job-enqueue transaction

`system-repo.ts:63-70` reads `organisations.retention_days` under a row lock and returns
`{ job: null, created: false }` when `onlyEnabled` is set and the value is `<= 0`. That is a
retention policy decision made inside the enqueue path. It is correct where it is (the read has to be
inside the same transaction as the insert or the decision races), but it means the meaning of
"retention disabled" lives in SQL-adjacent code. R08/R03 should not change retention semantics
without noticing this branch.

### 3. Role literals in three membership queries

`privacy-repo.ts:57` (`organisationsOwnedBy`), `privacy-repo.ts:64` (`ownersForOrganisation`) and
`auth-repo.ts:452-458` (`countOwners`) hard-code `role = 'owner'` in SQL. The strings are stable and
index-friendly, but the ownership concept is now expressed in two repositories and relied upon by an
authorization rule: "a sole owner may erase, several owners may not" (`privacy-service.ts:153-161`)
and "the last owner cannot be demoted or removed" (`organisation-service.ts:122`).

That is survivable today. It becomes a correctness risk the moment a second owner-like role exists,
because a query that filters `role = 'owner'` will silently disagree with `roleAtLeast(role, 'owner')`
in the service layer. The check itself is also outside the erasure transaction it guards
(`privacy-service.ts:153-161` reads, `:164` opens the transaction), which is already recorded as a
concurrent-membership limitation in `ARCHITECTURE.md` §2.3 and belongs to R06/R08.

### 4. Query-embedded row policy in the remediation repositories

`worker-error-remediation-repo.ts:57-66` and `connector-error-remediation-repo.ts:78-92` decide
"eligible for redaction" in SQL: a row counts only if its stored error is non-null and not already one
of `SAFE_WORKER_ERRORS`, compared under a forced binary collation. The _rule_ — which stored strings
count as unsafe — is defined in `domain/worker-errors.ts` and passed in, which is good design. What
remains in SQL is the set-membership predicate and the collation choice.

The collation choice is the interesting part: `binaryCollation()` (`worker-error-remediation-repo.ts:7`)
forces `"C"`/`BINARY` because a case- or accent-insensitive default could make a redacted string
compare equal to a safe one. That is a genuine portability decision made in the persistence layer —
and, as noted for ARC-046, a **second** driver-specific behaviour living in a repository. It is
correct, and it is architectural knowledge that exists nowhere else.

### Near-misses that are _not_ violations

- Bounded pagination clamps (`Math.min(limit, 100)` at `document-repo.ts:121,282`,
  `workflow-repo.ts:218`, `system-repo.ts:325`) are transport/resource guards co-located with the
  query. Defensible; they should stay where the limit is applied.
- Input validation that throws plain `Error` (`worker-recovery-repo.ts:25`,
  `remote-ocr-budget-repo.ts:9-10`, `erasure-files-repo.ts:18-21`,
  `batch-error-remediation-repo.ts:22-33`) is an offline-tool argument check, not a domain rule.
- No repository imports `services/`, `http/`, `ai/` or `realtime/`, and no repository throws
  `AppError` (zero occurrences). One repository imports an application module downward for a check
  rather than upward — `storage-references.ts:3` imports `assertSafeKey` from `../storage` — which is
  a legitimate use of a storage primitive and not a layering violation, though it does mean the
  persistence layer depends on the storage adapter module.
- Transaction-scoped driver branches (`tx.driver === 'postgres' ? ' FOR UPDATE' : ''`) are
  portability, not policy — though they are the reason DEC-013's "repositories do not know the
  driver" claim is no longer literally true (already recorded).

**ARC-AC-04: unmet for the strict criterion**, with the causes now enumerated rather than summarised:
retry/dead policy and retention enablement in `system-repo.ts`, ownership role literals in two
repositories, and the binary-collation rule for redaction eligibility. None of them is a defect in
behaviour that this review can demonstrate. They are boundary displacements whose cost is paid at the
next change, and the guarded updates inside them must survive any move. R02 owns the seam, R03 the
cross-driver behaviour, R18 reliability semantics; no refactor is authorised here.

## Handoff

| Item                | Owner            | Question                                                                               |
| ------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| ARC-048 (extended)  | R02 with R03/R18 | Move retry/dead policy to a service without losing the guarded conditional update.     |
| Ownership literals  | R06 with R03     | One ownership predicate, or two query literals plus a service check that can disagree. |
| Retention gate      | R08 with R03     | Keep the in-transaction read; state where "retention disabled" is defined.             |
| Collation predicate | R03 with R02     | Second driver-specific behaviour; needs PostgreSQL evidence, not just SQLite.          |

No repository, service or migration was changed. `sql-boundary-9ec567c.txt` is the reproducible
transcript for the placement half of this review.
