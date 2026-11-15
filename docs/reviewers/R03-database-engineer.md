# REVIEWER 03 — DATABASE ENGINEER / DATA-INTEGRITY SPECIALIST

| Field | Value |
|-------|-------|
| **Reviewer ID** | R03 |
| **Title** | Database Engineer / Data-Integrity Specialist |
| **Board** | A — Architecture & core domain |
| **Wave** | 1 (weeks 1–2) — **critical path** |
| **Effort** | 14 person-days |
| **Gate chaired** | **G4 — Database & data integrity** |
| **Co-signs** | G1, G6, G10 |
| **Finding prefix** | `DB-###` |
| **Upstream** | R01 (layer map) |
| **Downstream** | **R17 cannot start performance work until you settle R-04**; R18, R19, R08 depend on your purge/erase verification |
| **Status** | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Establish whether the data layer is correct, portable and durable — and specifically whether the
**PostgreSQL production path works at all**. Every write path must be atomic where correctness demands
it, every read path must exclude deleted data, retention and erasure must leave no residue, and a backup
must be restorable.

**You are on the critical path.** The repository documents SQLite for dev/test and PostgreSQL for
production (DEC-003, DEC-013), but `AGENT_STATE.md` itself admits *"the `pg` path is typechecked but never
executed"*. If PostgreSQL cannot initialise, the documented production deployment fails at first boot and
**every performance number R17 produces is measuring the wrong system**. Settle this first, then continue.

---

## 2. Required expertise

- Relational modelling and normalisation
- **SQLite and PostgreSQL semantics** (type systems, boolean handling, placeholder styles, DDL differences)
- Transaction isolation, atomicity, race conditions, upsert semantics
- Index design and query plan analysis
- Data lifecycle: soft delete, retention purge, erasure/right-to-be-forgotten
- Migration strategy: forward-only, rollback, zero-downtime
- Backup and restore (including consistency between database and object storage)

---

## 3. Repository context (self-contained)

**Product.** IDCP captures photographs of business documents, extracts structured data, has a human
review it, then exports or pushes it to external systems. Multi-tenant: every row belongs to an
`organisation_id`.

**Data layer as built:**

| Element | Path | Size |
|---------|------|------|
| Migrations (hand-written, forward-only) | `apps/backend/src/db/migrations.ts` | 528 LOC, **32 `CREATE TABLE`**, **29 `CREATE INDEX`** |
| `Database` port | `apps/backend/src/db/database.ts` | 74 LOC |
| SQLite driver | `apps/backend/src/db/sqlite.ts` | 90 LOC (`node:sqlite`) |
| PostgreSQL driver | `apps/backend/src/db/postgres.ts` | 80 LOC (`pg`) |
| Driver selection + auto-migrate | `apps/backend/src/db/index.ts` | 35 LOC |
| Migration CLI | `apps/backend/src/db/migrate-cli.ts` | 21 LOC |
| Seed CLI | `apps/backend/src/db/seed-cli.ts` | 76 LOC |
| Repositories (the only SQL) | `apps/backend/src/repositories/*.ts` | 13 files, ~2,800 LOC |
| Row types | `apps/backend/src/repositories/types.ts` | 332 LOC |

**Documented intent vs reality:**

| Claim | Source | Status |
|-------|--------|--------|
| "SQLite locally, PostgreSQL in production" | README, DEC-003, DEC-013 | `pg` driver is written and typechecked; **never executed** |
| "Hand-written forward-only migrations" | `migrations.ts` header | True — and there are **no down-migrations** |
| Booleans stored as INTEGER, timestamps as ISO TEXT "to keep the schema portable" | `db/postgres.ts` comment | Verify this actually holds |
| `DATABASE.md` | 44 KB document | Historically claimed the schema was unimplemented; verify it now matches |

**Migrations apply automatically at process start** (`createDatabase()` → `applyMigrations()`), not as a
separate deploy step. Consider the multi-replica consequence.

---

## 4. Exact files and components to examine

### 4.1 Must read in full

| # | File | What you are looking for |
|---|------|--------------------------|
| 1 | `apps/backend/src/db/migrations.ts` | **Every statement of all 32 tables and 29 indexes.** Type choices, defaults, constraints, FKs, unique keys |
| 2 | `apps/backend/src/db/database.ts` | The port; `SqlParams`; `toPostgresPlaceholders` |
| 3 | `apps/backend/src/db/sqlite.ts` | Pragmas, WAL, foreign keys, busy timeout |
| 4 | `apps/backend/src/db/postgres.ts` | Pool config, statement timeout, transaction scoping |
| 5 | `apps/backend/src/db/index.ts` | Driver selection and migration timing |
| 6 | `apps/backend/src/db/migrate-cli.ts` + `seed-cli.ts` | Operator entry points |
| 7 | `apps/backend/src/repositories/types.ts` | Row shapes (mirror of the schema) |
| 8 | `DATABASE.md` | The claim set to verify |
| 9 | `DECISIONS.md` DEC-003, DEC-013, DEC-029, DEC-031 | Stated database decisions |

### 4.2 Must read in full — all 13 repositories

`auth-repo.ts` (477) · `document-repo.ts` (380) · `connector-repo.ts` (325) · `system-repo.ts` (203) ·
`review-repo.ts` (216) · `device-repo.ts` (172) · `project-repo.ts` (164) · `template-repo.ts` (142) ·
`marketplace-repo.ts` (115) · `batch-repo.ts` (83) · `apikey-repo.ts` (82) · `workflow-repo.ts` (227)

### 4.3 Services that mutate data (verify transaction boundaries)

`document-service.ts` · `auth-service.ts` · `review-service.ts` · `batch-service.ts` · `connector-service.ts` ·
`privacy-service.ts` · `maintenance-service.ts` · `pairing-service.ts` · `organisation-service.ts` · `worker.ts`

### 4.4 Tests you must read

`worker-recovery.test.ts` (108) · `maintenance.test.ts` (143) · `privacy.test.ts` (202) ·
`documents.test.ts` (274) · `teams.test.ts` (228) · `security.test.ts` (214)

### 4.5 Explicit non-goals

Route validation and error envelopes → R02 · role/tenant authorisation semantics → R06 · performance
measurement and capacity → R17 · backup **scheduling** as an ops process → R19 (you verify restorability).

---

## 5. Upstream artefacts required

| From | Artefact | Why |
|------|----------|-----|
| R01 | `evidence/R01/layer-map.md` | Confirms `db/` and `repositories/` are the only data layer |
| R08 | PII inventory (may arrive later) | You need it for the erasure residue test; start it yourself if R08 is not done |

---

## 6. Checklist — every item must be answered

### 6.1 PORTABILITY — the highest-priority block (settles R-04)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DB-AC-01 | Enumerate every SQL statement in `migrations.ts` that is not valid PostgreSQL 16 | Read all 528 lines; classify each `CREATE TABLE` / `ALTER` / `CREATE INDEX` | Complete list with line numbers | STATIC |
| DB-AC-02 | Boolean representation | Look for `INTEGER NOT NULL DEFAULT 1/0` on flag columns (`needs_review`, `active`, `learning_opt_in`, `enabled`) | PostgreSQL has real `BOOLEAN`; an `INTEGER` works but comparisons must be consistent — prove it | STATIC |
| DB-AC-03 | PostgreSQL rejects `INSERT OR IGNORE` / `INSERT OR REPLACE` | `grep -n "INSERT OR" apps/backend/src -r` | Any hit is a portability defect | STATIC |
| DB-AC-04 | Placeholder rewrite safety | `toPostgresPlaceholders` in `database.ts` — test a payload containing a literal `?` | A `?` inside a string/JSON value must not become `$n` | **RUNTIME** |
| DB-AC-05 | Identifier quoting differences | Read each repository for backticks or unquoted identifiers | No SQLite-only quoting | STATIC |
| DB-AC-06 | `AUTOINCREMENT` / `sqlite_sequence` | `grep -n "AUTOINCREMENT\|sqlite_" apps/backend/src` | Zero (all ids are TEXT UUIDs) | STATIC |
| DB-AC-07 | SQLite-specific functions | `grep -nE "datetime\(|strftime|json_extract|PRAGMA|IFNULL" apps/backend/src` | Zero, or justified per driver | STATIC |
| DB-AC-08 | **Execute the migration set against real PostgreSQL 16** | `DB_DRIVER=postgres DATABASE_URL=… npm run db:migrate` | Either it succeeds — or the finding is **CRITICAL** and DEC-013/`DATABASE.md` must be rewritten | **RUNTIME** |
| DB-AC-09 | Full backend suite passes against PostgreSQL | `DB_DRIVER=postgres … npx jest --selectProjects backend` | Green, or record every failure | **RUNTIME** |
| DB-AC-10 | Seed works on both drivers | `npm run db:seed` on each | Idempotent, no driver-specific SQL | **RUNTIME** |

### 6.2 Schema quality

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DB-AC-11 | Producing a complete **table inventory** | Extract all 32 tables with columns, PK, FK, unique, indexes | `evidence/R03/schema.md` | **WRITE** |
| DB-AC-12 | Every table carries `organisation_id` (except genuinely global tables) | Read all 32 `CREATE TABLE` blocks | List the exceptions and justify each | STATIC |
| DB-AC-13 | Every FK has an index | Cross-reference 29 indexes against FK columns | Every FK indexed or a documented reason | STATIC |
| DB-AC-14 | Hot-path indexes exist | Check for: `documents(organisation_id, created_at)`, `jobs(status, run_after)`, `sessions(refresh_token_hash)`, `audit_logs(organisation_id, created_at)`, `documents(idempotency_key)` | All present | STATIC |
| DB-AC-15 | Unique constraints enforce invariants | Idempotency key per org; user email globally; membership (user, org); invitation token hash; API key hash | All enforced at the DB, not only in code | STATIC |
| DB-AC-16 | No nullable column that must never be null | Read the schema; check service defaults | Constraints match the domain | STATIC |
| DB-AC-17 | Foreign keys are actually enforced | SQLite requires `PRAGMA foreign_keys = ON` per connection | Verified in `sqlite.ts`; prove with a test | STATIC+RUNTIME |
| DB-AC-18 | Timestamps are consistent (ISO TEXT) | `nowIso()` usage everywhere | No mixed formats | STATIC |
| DB-AC-19 | Money/quantity precision | `packages/shared/src/money.ts`; how extracted amounts are stored | Documented precision decision; no float drift | STATIC |

### 6.3 Transactions and atomicity

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DB-AC-20 | Inventory every multi-write flow | Upload (document+job+audit), approve (status+review+audit), erase (many tables), invite, connector run | `evidence/R03/transaction-inventory.md` | **WRITE** |
| DB-AC-21 | Each flow is atomic or has a documented compensating action | Read the services; look for `db.transaction` | Every multi-write flow atomic, or an explanation | STATIC |
| DB-AC-22 | Job claim is transactional | `system-repo.ts` `claim` — `UPDATE … WHERE status='queued'` style | Cannot double-claim under concurrency | STATIC |
| DB-AC-23 | Nested transaction behaviour is defined | `postgres.ts` `transaction()` passes `scoped` with `transaction: inner => inner(scoped)` | Nested calls join the outer transaction — confirm this is understood where used | STATIC |
| DB-AC-24 | Rollback is proven | Force a failure inside a transaction (T-05) | No partial rows | **RUNTIME** |
| DB-AC-25 | No long-running transaction holds a write lock | Read service flows for awaits inside a transaction | Documented risk (e.g. OCR inside a transaction = bad) | STATIC |

### 6.4 Read-path correctness

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DB-AC-26 | Every read excludes soft-deleted rows | `grep -rn "deleted_at" apps/backend/src/repositories` | Every list/get filters `deleted_at IS NULL` (except an explicit admin view) | STATIC |
| DB-AC-27 | Every query is tenant-scoped | Every method takes `organisationId` and uses it in the predicate | Consistent; note legitimate post-fetch id-only updates | STATIC |
| DB-AC-28 | No `SELECT *` into a response without explicit mapping | `grep -rn "SELECT \*" apps/backend/src/repositories` then check mapping | Row → DTO mapping never leaks secrets (`password_hash`, `mfa_secret_enc`, `key_hash`, connector `config`) | STATIC |
| DB-AC-29 | Cursor pagination is deterministic | `ORDER BY created_at DESC, id DESC` | Tie-break present | STATIC |
| DB-AC-30 | N+1 queries are identified | Read list endpoints that assemble related data | Quantified and bounded | STATIC |

### 6.5 Job lifecycle and recovery (co-owned with R18)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DB-AC-31 | Job state machine is complete and terminal | `system-repo.ts`: `queued → running → succeeded/failed/dead`; `attempts`/`max_attempts` (5); `run_after` backoff | Every state reachable and terminal | STATIC |
| DB-AC-32 | Stale-claim requeue works | `requeueStale` + `RECOVERY_GRACE_MS` (30 s), `worker-recovery.test.ts` | Proven by test; reproduce manually (T-06) | **RUNTIME** |
| DB-AC-33 | Dead jobs are observable | `document:failed` event + `last_error` persisted | Data available for an operator | STATIC |

### 6.6 Data lifecycle — retention, erasure, audit

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DB-AC-34 | Retention purge deletes rows **and** storage objects | `document-service.ts` / `maintenance-service.ts` purge path | No orphan files after purge | **RUNTIME** |
| DB-AC-35 | Erasure reaches all 32 tables | Erase a user, then `SELECT COUNT(*) FROM <each table> WHERE <user ref>` | Zero PII residue, or a documented lawful-retention exception (audit) | **RUNTIME** |
| DB-AC-36 | Audit log is append-only | `grep -rn "UPDATE audit_logs\|DELETE FROM audit_logs"` | Zero | STATIC |
| DB-AC-37 | Audit log has an export path that is itself audited | `GET /audit-logs.csv` + `audit-export.test.ts` | Confirmed | STATIC |
| DB-AC-38 | Erased user is anonymised consistently | `auth-repo.ts` `deleted-${id}@erased.invalid` | No dangling FK, no recoverable identity | STATIC |
| DB-AC-39 | Expired exports are deleted from storage | `maintenance-service.ts` + `EXPORTS_TTL_SECONDS` | Confirmed | STATIC |

### 6.7 Migration safety

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DB-AC-40 | Migration list is ordered and immutable | Read `migrations.ts` structure | Applied-once semantics with a tracking table; no edits to shipped migrations | STATIC |
| DB-AC-41 | Migration tracking table exists | `grep -n "schema_migrations\|_migrations"` | Present | STATIC |
| DB-AC-42 | A failed migration cannot leave a half-applied schema | Read `applyMigrations` | Per-migration transaction, or documented risk | STATIC |
| DB-AC-43 | Multi-replica migration race | Start two processes simultaneously against an empty Postgres | One migrates, the other waits or fails safely — **no corruption** | **RUNTIME** |
| DB-AC-44 | **There is no rollback path** | Confirm: only forward migrations exist | Record as a finding with the required mitigation (backup-first, tested restore) | STATIC |
| DB-AC-45 | Data migration on an existing production-size table | Apply a new column to a 100k-row table | Lock duration measured and acceptable | **RUNTIME** |

### 6.8 Backup and restore (you prove restorability; R19 schedules it)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DB-AC-46 | No `db:backup` script exists | `grep -n "db:backup" package.json` | Absent — record as R-09 | STATIC |
| DB-AC-47 | **DB and storage must restore together** | Document the consistency rule | A restore of one without the other orphans documents; write the procedure | **WRITE** |
| DB-AC-48 | Perform a real restore | `VACUUM INTO` a SQLite copy + copy `STORAGE_PATH`, restore to a clean dir, start the app | Sign-in works, documents download, counts match | **RUNTIME** |
| DB-AC-49 | Measure RTO/RPO | Time the restore in §DB-AC-48 | Numbers recorded | **RUNTIME** |
| DB-AC-50 | Restore of PostgreSQL | `pg_dump` / `pg_restore` round-trip | Data intact | **RUNTIME** |

---

## 7. Known database risks to confirm or refute

| Risk | Statement |
|------|-----------|
| **R-04 (HIGH)** | PostgreSQL is the documented production DB but has never been executed; migrations are SQLite-flavoured. **This is your first deliverable.** |
| R-09 (MEDIUM) | No backup/restore path; DB and filesystem must be restored together |
| R-24 (LOW) | `node:sqlite` is flagged **experimental** at runtime — the default engine is not API-stable |
| R-12 (MEDIUM) | Batch upload buffers files in memory before the DB write |
| R-14 (MEDIUM) | Retention default figures are contract-tested against the legal pack — verify the test is meaningful |

---

## 8. Questions you must answer

1. **Can the production database be created from this repository today?** Answer yes/no with a transcript.
2. Which tables have no `organisation_id`, and why is each safe?
3. Which multi-write flows are **not** atomic, and what inconsistency can each produce?
4. After `POST /me/erase`, which tables can still reference the user, and is each reference lawful?
5. After the retention purge, are there files on disk with no owning row? Show the query and the `find`.
6. If a migration fails halfway in production, what is the recovery procedure — and has it been run?
7. What is the measured restore time, and what data loss window does the backup strategy imply?

---

## 9. Commands to run

```bash
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund

# ---------- SQLite (default) ----------
npm run db:migrate
npm run db:seed
sqlite3 ./local-storage/idcp.db ".tables"
sqlite3 ./local-storage/idcp.db "SELECT name,sql FROM sqlite_master WHERE type='table';" > /tmp/schema-sqlite.sql
sqlite3 ./local-storage/idcp.db "SELECT name,tbl_name FROM sqlite_master WHERE type='index';"
sqlite3 ./local-storage/idcp.db "PRAGMA foreign_key_check;"
sqlite3 ./local-storage/idcp.db "PRAGMA integrity_check;"

# ---------- portability greps ----------
grep -n "INSERT OR" -r apps/backend/src
grep -nE "AUTOINCREMENT|sqlite_|PRAGMA" -r apps/backend/src/db apps/backend/src/repositories
grep -nE "datetime\(|strftime|json_extract|IFNULL" -r apps/backend/src
grep -rn "deleted_at" apps/backend/src/repositories | wc -l
grep -rn "SELECT \*" apps/backend/src/repositories
grep -rn "UPDATE audit_logs\|DELETE FROM audit_logs" apps/backend/src

# ---------- PostgreSQL 16 ----------
docker run -d --name idcp-pg -e POSTGRES_PASSWORD=pg -e POSTGRES_DB=idcp -p 5432:5432 postgres:16
export DATABASE_URL=postgres://postgres:pg@127.0.0.1:5432/idcp
DB_DRIVER=postgres npm run db:migrate        # <-- THE decisive command
DB_DRIVER=postgres npm run db:seed
DB_DRIVER=postgres npx jest --config jest.config.cjs --selectProjects backend --runInBand

# ---------- job / recovery ----------
PORT=4000 WORKER_ENABLED=true npm run dev:backend &
# upload a document, then kill -9 the process mid-job and restart:
kill -9 %1 ; sleep 2 ; PORT=4000 npm run dev:backend &
sqlite3 ./local-storage/idcp.db "SELECT id,status,attempts,last_error FROM jobs ORDER BY created_at DESC LIMIT 5;"

# ---------- erase residue ----------
# (create a user + documents, then)
curl -s -X POST http://127.0.0.1:4000/api/v1/me/erase -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"password":"…","confirm":"DELETE"}'
sqlite3 ./local-storage/idcp.db "SELECT 'documents',COUNT(*) FROM documents WHERE organisation_id='$ORG'
  UNION ALL SELECT 'extractions',COUNT(*) FROM extractions
  UNION ALL SELECT 'audit_logs',COUNT(*) FROM audit_logs;"
find ./local-storage/documents -type f | wc -l

# ---------- backup / restore ----------
sqlite3 ./local-storage/idcp.db "VACUUM INTO '/tmp/idcp-backup.db'"
cp -a ./local-storage/documents /tmp/doc-backup
# restore into a clean tree and start the app; verify counts + a document download
```

---

## 10. Tests to perform

| # | Test | Procedure | Pass criterion |
|---|------|-----------|----------------|
| T-01 | **PostgreSQL migration** | `DB_DRIVER=postgres npm run db:migrate` on an empty PG16 | All 32 tables and 29 indexes created; exit 0 |
| T-02 | **Full suite on PostgreSQL** | `DB_DRIVER=postgres jest --selectProjects backend` | Green, or every failure catalogued |
| T-03 | Placeholder rewrite | Insert JSON containing `?` and `$1` as data values | Stored and read back byte-identical |
| T-04 | FK enforcement | Delete a parent row referenced by a child | Blocked by FK, or cascade as designed |
| T-05 | Transaction rollback | Inject a failure after the first write in upload/approve | Zero partial rows |
| T-06 | Crash recovery | `kill -9` mid-job; restart | Job requeued and completed; document not stranded |
| T-07 | Purge orphan check | Run the retention sweep | `rows deleted == files deleted`; no orphan file |
| T-08 | Erasure residue | Full-table scan + `find` after erase | Zero (or documented lawful exception) |
| T-09 | Migration race | Two processes, empty PG | No corruption; second waits or exits cleanly |
| T-10 | Backup/restore | `VACUUM INTO` + storage copy → restore | Counts match, document downloads, RTO recorded |
| T-11 | Concurrent claim | Two workers, 20 jobs | Each job executed exactly once |
| T-12 | Query plans | `EXPLAIN ANALYZE` the 6 hot queries on 100k rows | No sequential scan on a tenant-scoped filter |

---

## 11. Evidence required

```
docs/reviewers/evidence/R03/
├── schema.md                    # 32 tables: columns, PK, FK, unique, indexes, org-scoped?
├── portability-matrix.md        # every SQL statement × SQLite ✓/✗ × PostgreSQL ✓/✗
├── postgres-migrate.log         # THE decisive transcript
├── transaction-inventory.md     # multi-write flow → atomic? → inconsistency if not
├── index-analysis.md            # EXPLAIN ANALYZE output for hot queries
├── purge-orphan-report.md       # rows vs files after purge
├── erase-residue-report.md      # per-table residue after erasure + find output
├── restore-rehearsal.md         # procedure, timing, RTO/RPO
├── commands.log
└── findings.md                  # DB-### register
```

---

## 12. Passing conditions (chairs G4; co-signs G1, G6, G10)

- [ ] **P1** `DB_DRIVER=postgres npm run db:migrate` succeeds on PostgreSQL 16 and creates all 32 tables and 29 indexes — **or** DEC-013 and `DATABASE.md` are rewritten to SQLite-only and the production claim is withdrawn (DB-AC-08).
- [ ] **P2** The full backend suite passes against PostgreSQL, or every failure is catalogued (DB-AC-09).
- [ ] **P3** Placeholder rewrite is proven safe for literal `?` (DB-AC-04, T-03).
- [ ] **P4** Every multi-write flow is atomic or has a documented compensating action (DB-AC-20, DB-AC-21, T-05).
- [ ] **P5** Tenancy: every table's scoping is recorded; exceptions justified (DB-AC-12).
- [ ] **P6** Hot-path indexes exist and query plans confirm them (DB-AC-14, T-12).
- [ ] **P7** Purge leaves no orphan files (DB-AC-34, T-07).
- [ ] **P8** Erasure leaves no PII residue, or the residue is documented and lawful (DB-AC-35, T-08).
- [ ] **P9** Audit log is append-only (DB-AC-36).
- [ ] **P10** A restore has actually been performed and timed; RTO/RPO recorded (DB-AC-48, DB-AC-49, T-10).
- [ ] **P11** The absence of a rollback path is recorded as a finding with mitigation (DB-AC-44).

---

## 13. Blocked items

| Item ID | Blocker | What unblocks it | Owner |
|---------|---------|------------------|-------|
| DB-AC-08 | No PostgreSQL available in the assessment sandbox | Provision PG16 (docker or managed) | R19 |

---

## 14. Findings register

| ID | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
|----|----------|-----------|---------|----------------|-----------|---------------|-------|
| DB-001 | | | | | | | |

---

## 15. Reviewer sign-off

| Field | Value |
|-------|-------|
| Reviewer name | |
| Date started | |
| Date completed | |
| Gate G4 result | ☐ Pass ☐ Fail |
| **G1 co-sign result** | ☐ Pass ☐ Fail ☐ Abstain |
| **G6 co-sign result** | ☐ Pass ☐ Fail ☐ Abstain |
| **G10 co-sign result** | ☐ Pass ☐ Fail ☐ Abstain |
| PostgreSQL verdict | ☐ Works ☐ Broken — production claim withdrawn |
| Conditions failed (IDs) | |
| Reviewed commit | `43d384b` |
| Statement | *I read all 528 lines of migrations and all 13 repositories, executed the migration set on PostgreSQL 16, performed a full restore, and verified erasure residue across all 32 tables.* |
| Signature | |
