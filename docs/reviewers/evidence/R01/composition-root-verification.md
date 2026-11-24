# R01 composition-root verification (ARC-AC-11, ARC-AC-12, ARC-AC-14; P5)

**Purpose:** decide what P5 actually demands, then measure the code against it. P5 reads "the
composition root is the only place adapters are constructed" and has been carried as
_unmet/unresolved_ since the first pass because "database, HTTP and offline CLI entry points also
construct adapters". This note resolves that framing rather than repeating it. Baseline `9ec567c`.

## The criterion, read literally

P5 has two halves and they are not the same requirement:

1. **Adapter construction is centralized** — one place decides which concrete `Database`, `Storage`,
   `RealtimeHub`, OCR provider, mailer and connector transport the process gets.
2. **Services do not build their own dependencies** — a service receives ports through its
   constructor and never news-up a repository, adapter or sibling service.

The second half is checkable and is met. The first half cannot be met by a single file in this
codebase, and demanding that would be the wrong fix — see "why a single root is the wrong target".

## What the sweep found

Full constructor list for every adapter class in `apps/backend/src`, excluding tests:

| Adapter                                     | Constructed in                                        | Count of sites |
| ------------------------------------------- | ----------------------------------------------------- | -------------- |
| `FilesystemStorage` / `MemoryStorage`       | `services/container.ts:134`                           | 1              |
| `TesseractProvider` / `CloudVisionProvider` | `services/container.ts:117-128` (`createOcrProvider`) | 1              |
| `InMemoryRealtimeHub`                       | `services/container.ts:135`                           | 1              |
| `ConnectorRegistry` / `ConnectorProcess`    | `services/container.ts:156-170`                       | 1              |
| `PostgresDatabase` / `SqliteDatabase`       | `db/index.ts:15,25,33` and 9 offline CLIs             | 12             |
| `ReadOnlySqliteDatabase`                    | 5 offline CLIs                                        | 5              |
| `ConnectorRegistry` (child process)         | `adapters/connector-runner.ts:35`                     | 1              |

So: every **runtime adapter** — storage, realtime, OCR provider, mailer, connector transport — is
constructed exactly once, in `services/container.ts` (`createOcrProvider` is exported from the same
module and called only by `buildServices`, so the pipeline never selects a provider itself). The multiplicity is entirely in the database
factory and the offline operator CLIs.

**ARC-AC-12 (services do not construct dependencies): met.** No service module constructs a
repository, adapter or sibling service outside `container.ts`. `rg 'new .*Repository\(' services/`
returns only the container, and the existing `composition-boundary.test.ts` guards it (including
aliased imports). This is the half of P5 that protects the architecture day to day.

**ARC-AC-14 (configuration injected, not read): met for the runtime.** `config.ts` is the only module
reading `process.env` (enforced by `config.test.ts`), and every service takes `Config` through its
constructor.

**ARC-AC-11 (composition root, not service locator): met at runtime, in a weaker form elsewhere.**
There is no global container, no module-level singleton registry and no service pulling from
`globalThis`. `buildServices()` returns a plain object that callers pass down. The offline CLIs are
_not_ service locators either — they wire one repository directly and never touch services.

## Why "one file" is the wrong target — and what the real cost is

`db/index.ts:11-31` already is the database factory: it picks the driver from `Config`, applies
migrations and logs. It is the correct seam. The 10 operator CLIs in `src/db/*-cli.ts` cannot use it
unmodified because they need three things the factory does not offer:

- a **pool of 1** rather than `DATABASE_POOL_SIZE` (`worker-error-remediation-cli.ts:43` et al.),
- an explicit **read-only** connection for list/check modes — `SET default_transaction_read_only = on`
  or `SET TRANSACTION READ ONLY` on PostgreSQL, `ReadOnlySqliteDatabase` on SQLite,
- **no migration application**, so an inspection tool cannot alter the database it was pointed at.

Those are real, deliberate properties of an offline operator tool, not duplication for its own sake.
Collapsing them into `createDatabase()` would either give an inspector write access or force
migrations. So the honest architectural statement is: _the database factory exists, and it is
specialised by a second, narrower path for offline tools_ — which is a legitimate second seam, but it
is currently **six copies of an unwritten contract**.

### The duplication that does cost something

The read-only decision is re-derived per CLI, and the derivations disagree:

| CLI                               | PostgreSQL read-only                     | SQLite read-only | Note                                                                                                                                      |
| --------------------------------- | ---------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `batch-error-remediation-cli`     | `SET default_transaction_read_only = on` | yes              | consistent                                                                                                                                |
| `connector-error-remediation-cli` | same                                     | yes              | consistent                                                                                                                                |
| `export-inventory-cli`            | same                                     | yes              | consistent                                                                                                                                |
| `storage-inventory-cli`           | same                                     | yes              | consistent                                                                                                                                |
| `worker-error-remediation-cli`    | same                                     | yes              | consistent                                                                                                                                |
| `worker-recovery-cli`             | **none on the connect path**             | yes              | read-only is applied per-transaction via `SET TRANSACTION READ ONLY` inside the list branch (`:70-78`); the connection itself is writable |

That last row is not a defect — the `SET TRANSACTION READ ONLY` inside a transaction is arguably
stronger than a session default. But it means the "how do I guarantee this tool cannot write" rule
lives in six places and two different mechanisms, with nothing that states which one is the contract
and no test that every inspection mode is actually read-only on both drivers. That is the P5-shaped
risk that actually exists: not that adapters are built in more than one file, but that the
**guarantee** those files are supposed to share is unstated and unverified.

`connector-config-migration-cli` and `encryption-migration-cli` correctly use
`loadEncryptionMigrationConfig()` and are deliberately read-write; `migrate-cli` and `seed-cli` do not
construct a database at all (they delegate). Those four are consistent with intent.

## Verdict

| Element                                       | Result                                                               |
| --------------------------------------------- | -------------------------------------------------------------------- |
| ARC-AC-12 services build no dependencies      | **Met** — guarded by test                                            |
| ARC-AC-14 config injected                     | **Met** — guarded by test                                            |
| ARC-AC-11 runtime composition root            | **Met**                                                              |
| P5 as "one file builds every adapter"         | **Not met, and should not be** — the offline path is a distinct seam |
| P5 as "one stated, tested read-only contract" | **Not met** — six derivations, two mechanisms, no shared test        |

R01's recommendation, recorded rather than implemented: keep `db/index.ts` as the runtime factory and
add one narrow factory for offline access (parameterised by `{ readOnly: boolean, applyMigrations:
false }`, pool size 1) so the read-only guarantee is expressed once and can be tested on both
drivers. That would let P5 be restated as _"adapter construction is centralised per entry-point class,
and the offline class enforces read-only inspection"_ — a claim the code could then satisfy. R01 does
not have authority to restate a passing condition; that is for the gate chair. No CLI, factory or test
was changed here.

## Handoff

| Item               | Owner            | Question                                                                                                        |
| ------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------- |
| P5 restatement     | G1 chair / owner | Is "per entry-point class + enforced read-only" an acceptable reading, or is the literal one-file rule binding? |
| Offline factory    | R02 with R19     | One factory, one read-only contract, tested on SQLite and PostgreSQL.                                           |
| Read-only evidence | R03 with R16     | Prove every inspection mode cannot write on both drivers before operators rely on it.                           |

Nothing in this note changes a checklist row to "met" for P5: ARC-AC-11/12/14 are recorded as met on
their own terms, and P5 remains a gate decision with a recommendation attached.
