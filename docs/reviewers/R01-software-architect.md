# REVIEWER 01 — SOFTWARE ARCHITECT

| Field              | Value                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------- |
| **Reviewer ID**    | R01                                                                                   |
| **Title**          | Software Architect                                                                    |
| **Board**          | A — Architecture & core domain                                                        |
| **Wave**           | 1 (weeks 1–2)                                                                         |
| **Effort**         | 6 person-days                                                                         |
| **Gate chaired**   | **G1 — Architecture approval**                                                        |
| **Co-signs**       | G8                                                                                    |
| **Evidence to**    | G2, G3, G5, G6 (contributes findings, not an approver)                                |
| **Finding prefix** | `ARC-###`                                                                             |
| **Upstream**       | none — this is the first review                                                       |
| **Downstream**     | R02, R03, R04, R09, R10, R11, R15, R19, R20 all depend on the layer map produced here |
| **Status**         | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed                    |

---

## 1. Mission

Determine whether the system has a coherent, defensible architecture that the codebase actually
implements, and produce the **canonical layer map** every other reviewer will use. You are not auditing
quality of individual features — you are auditing whether the seams are in the right places, whether
dependencies point in one direction, and whether the documentation describes the system that exists
rather than a system that was once planned.

**Specific to this repository:** `ARCHITECTURE.md` §8 currently says _"No application code, so none of
the above is implemented."_ That is false — there are ~41,300 lines of first-party code. §6 describes a
"target repository layout" containing a `prisma/` directory that does not exist. Establishing which
documentation is aspirational and which is descriptive is a primary deliverable of this review.

---

## 2. Required expertise

- Layered / hexagonal / ports-and-adapters architecture
- Modular monolith design and decomposition boundaries
- Multi-tenant SaaS architecture
- TypeScript monorepo governance (npm workspaces, project references, path boundaries)
- Dependency-injection and composition-root design
- Trade-off analysis and Architecture Decision Records

---

## 3. Repository context (self-contained)

**Product.** IDCP turns photographed business documents (receipts, invoices, delivery notes, IDs,
contracts) into structured records that a human reviews and then exports or pushes into external
business systems.

**Core loop.** phone capture → AI extraction → human review → export / connector write.

**Workspaces.**

| Workspace  | Path                  | Role                                                    |
| ---------- | --------------------- | ------------------------------------------------------- |
| Backend    | `apps/backend`        | Fastify 5 HTTP API + in-process job worker + migrations |
| Desktop    | `apps/desktop`        | Electron shell + React 19 / Vite 6 renderer (12 pages)  |
| Mobile     | `apps/mobile`         | React Native 0.86 capture/pairing/queue app             |
| Shared     | `packages/shared`     | UDM + Zod contracts, i18n, money/dates/CSV/dedupe       |
| Connectors | `packages/connectors` | Connector SDK + 8 first-party connectors                |

**Backend layering as built:**

```
apps/backend/src/
├── index.ts                 # process entry
├── config.ts                # the ONLY reader of process.env
├── logger.ts                # structured JSON logging + redaction
├── http/
│   ├── app.ts               # Fastify assembly, error envelope, headers, access log, /api/v1 prefix
│   ├── guards.ts            # authentication + authorisation (3 credential types)
│   └── routes/*.ts          # 16 files, 101 route registrations
├── services/*.ts            # 18 files — domain rules, role checks, auditing
├── repositories/*.ts        # 13 files — the ONLY SQL in the system
├── db/                      # driver abstraction, migrations, seed
├── ai/                      # provider abstraction + pipeline
├── realtime/hub.ts          # RealtimeHub interface (SSE implementation)
├── storage/                 # Storage interface (filesystem implementation)
├── workflows/engine.ts      # pure rule engine
└── marketplace/catalog.ts   # pure catalogue logic
```

**Known architectural constraints already recorded in the repository:**

| Decision | Content                                                                        | File           |
| -------- | ------------------------------------------------------------------------------ | -------------- |
| DEC-002  | npm workspaces + TypeScript monorepo                                           | `DECISIONS.md` |
| DEC-003  | SQLite dev/test, PostgreSQL production                                         | `DECISIONS.md` |
| DEC-013  | Two database drivers behind one `Database` interface, `?`→`$1` rewrite         | `DECISIONS.md` |
| DEC-016  | Authenticated SSE instead of Socket.IO, behind `RealtimeHub`                   | `DECISIONS.md` |
| DEC-029  | Single-process runtime; API role and worker role logically split but co-hosted | `DECISIONS.md` |
| DEC-010  | Filesystem storage behind a `Storage` interface; S3 adapter not written        | `DECISIONS.md` |

---

## 4. Exact files and components to examine

### 4.1 Must read in full (primary scope)

| #   | File                                     | LOC | Why                                           |
| --- | ---------------------------------------- | --- | --------------------------------------------- |
| 1   | `ARCHITECTURE.md`                        | —   | Claims to verify against reality              |
| 2   | `DECISIONS.md`                           | —   | The decision record (DEC-001…DEC-034+)        |
| 3   | `apps/backend/src/index.ts`              | 52  | Process bootstrap order                       |
| 4   | `apps/backend/src/config.ts`             | 141 | Configuration surface and validation          |
| 5   | `apps/backend/src/services/container.ts` | 146 | **The composition root**                      |
| 6   | `apps/backend/src/http/app.ts`           | 238 | Framework assembly and cross-cutting concerns |
| 7   | `apps/backend/src/db/database.ts`        | 74  | The `Database` port                           |
| 8   | `apps/backend/src/db/index.ts`           | 35  | Driver selection + migration application      |
| 9   | `apps/backend/src/repositories/types.ts` | 332 | Row types shared across the data layer        |
| 10  | `apps/backend/src/realtime/hub.ts`       | 104 | Realtime port                                 |
| 11  | `apps/backend/src/storage/index.ts`      | 152 | Storage port                                  |
| 12  | `apps/backend/src/ai/providers/types.ts` | 49  | AI provider port                              |
| 13  | `packages/connectors/src/contract.ts`    | 204 | Connector port                                |
| 14  | `packages/shared/src/index.ts`           | 18  | Public surface of the shared package          |
| 15  | `packages/shared/package.json`           | 13  | Exported subpaths (`@idcp/shared/ids`)        |
| 16  | `tsconfig.base.json`                     | —   | Path mapping and compiler contract            |
| 17  | root `package.json`                      | —   | Workspace graph and script surface            |

### 4.2 Must scan for violations

| #   | Scope                                             | What to look for                                                     |
| --- | ------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | `apps/backend/src/http/routes/*.ts` (16 files)    | SQL, business rules, or direct `db` access that belongs in a service |
| 2   | `apps/backend/src/services/*.ts` (18 files)       | Raw SQL that belongs in a repository; `process.env` reads            |
| 3   | `apps/backend/src/repositories/*.ts` (13 files)   | Business rules, HTTP concerns, or role checks                        |
| 4   | `packages/shared/src/**`                          | Any import from `apps/*` (must be none)                              |
| 5   | `packages/connectors/src/**`                      | Any import from `apps/*` or from `apps/backend` internals            |
| 6   | `apps/desktop/src/**`                             | Any import from `apps/backend` or Node built-ins in the renderer     |
| 7   | `apps/mobile/src/**`                              | Any import from `apps/desktop` or `apps/backend` internals           |
| 8   | Every `package.json` in `apps/*` and `packages/*` | Dependency directions, cycles, duplicated deps                       |

### 4.3 Explicit non-goals (do not duplicate other reviewers)

Feature correctness → R02 · schema and migration portability → R03 · API contract completeness → R04 ·
roadmap/terminology accuracy → R20.

---

## 5. Upstream artefacts required before starting

None. You **produce** the artefact others consume. Start immediately.

---

## 6. Checklist — every item must be answered

Legend: `[STATIC]` read/analyse only · `[RUNTIME]` must be executed · `[WRITE]` produces a file.

### 6.1 Layer integrity

| ID        | Item                                         | How to verify                                                                                                                            | Expected                                                                                                                    | Type   |
| --------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| ARC-AC-01 | No SQL outside `repositories/`               | `grep -rnE "SELECT                                                                                                                       | INSERT                                                                                                                      | UPDATE | DELETE FROM " apps/backend/src --include=*.ts \| grep -v "/repositories/" \| grep -v "/db/"` | Only `db/` driver + migration files; **zero** hits in `http/` or `services/` | STATIC |
| ARC-AC-02 | No `process.env` outside `config.ts`         | `grep -rn "process.env" apps/backend/src --include=*.ts`                                                                                 | Only `config.ts` (and `index.ts` if it passes `env` in — justify)                                                           | STATIC |
| ARC-AC-03 | No HTTP concerns in services                 | `grep -rn "request\.\|reply\.\|FastifyRequest\|FastifyReply" apps/backend/src/services`                                                  | Zero                                                                                                                        | STATIC |
| ARC-AC-04 | No business rules in repositories            | Read all 13 repository files; look for threshold constants, role strings, policy branching                                               | Only persistence + row mapping                                                                                              | STATIC |
| ARC-AC-05 | `packages/shared` has no `apps/*` import     | `grep -rn "apps/" packages/shared/src`                                                                                                   | Zero                                                                                                                        | STATIC |
| ARC-AC-06 | `packages/connectors` has no `apps/*` import | `grep -rn "apps/" packages/connectors/src`                                                                                               | Zero                                                                                                                        | STATIC |
| ARC-AC-07 | Renderer has no backend/Node import          | `grep -rn "from '\(node:\)\?fs'\|from 'electron'\|apps/backend" apps/desktop/src/pages apps/desktop/src/components apps/desktop/src/lib` | Zero (renderer must not touch fs/ipc directly)                                                                              | STATIC |
| ARC-AC-08 | No `apps/*` → `apps/*` import anywhere       | `grep -rn "from '\.\./\.\./\.\./\.\./apps" apps packages --include=*.ts --include=*.tsx`                                                 | Zero                                                                                                                        | STATIC |
| ARC-AC-09 | Workspace dependency graph is acyclic        | Read all 7 `package.json` files; draw the graph                                                                                          | `shared` ← nothing; `connectors` → `shared`; `backend` → `shared` + `connectors`; `desktop` → `shared`; `mobile` → `shared` | STATIC |
| ARC-AC-10 | TS path mapping matches the workspace graph  | `tsconfig.base.json` + each workspace `tsconfig.json`                                                                                    | No path points outside declared dependencies                                                                                | STATIC |

### 6.2 Composition and dependency injection

| ID        | Item                                                        | How to verify                                                                                   | Expected                                             | Type   |
| --------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------ |
| ARC-AC-11 | `container.ts` is a composition root, not a service locator | Read `container.ts`; check whether services pull dependencies from a global/singleton           | All 18 services receive dependencies via constructor | STATIC |
| ARC-AC-12 | No service constructs its own dependencies                  | `grep -rn "new .*Repository(\|new .*Service(" apps/backend/src/services \| grep -v container`   | Only inside `container.ts`                           | STATIC |
| ARC-AC-13 | Every port has one implementation and one fake              | `Database`, `Storage`, `RealtimeHub`, `OcrProvider`, `Connector`                                | Each has a test double; state which                  | STATIC |
| ARC-AC-14 | Configuration is injected, not read                         | Services receive `config`, never `process.env`                                                  | Matches ARC-AC-02                                    | STATIC |
| ARC-AC-15 | Test seams exist for clock, ids, randomness                 | `packages/shared/src/ids.ts`, any `Date.now()`/`Math.random()`/`randomUUID()` usage in services | Injectable or centralised; list exceptions           | STATIC |

### 6.3 Single-process runtime (DEC-029) and scale-out path

| ID        | Item                                       | How to verify                                                                                                                    | Expected                                                                               | Type        |
| --------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------- |
| ARC-AC-16 | Worker is idempotent                       | Read `services/worker.ts`; identify every side effect per job type                                                               | Each side effect safe to repeat                                                        | STATIC      |
| ARC-AC-17 | Two workers are safe                       | **Start two backend processes against one SQLite file** with `WORKER_ENABLED=true`; upload documents                             | No double-processing; no crash; no duplicate audit rows                                | **RUNTIME** |
| ARC-AC-18 | Two API replicas are safe                  | Start two processes; drive traffic via one; confirm no in-process state is required for correctness (sessions, rate limits, SSE) | List every piece of in-process state and its multi-replica consequence                 | **RUNTIME** |
| ARC-AC-19 | In-process state is enumerated and bounded | `AttemptLimiter` (`auth/tokens.ts`), `RealtimeHub`, maintenance scheduler                                                        | Written inventory with memory bound for each                                           | STATIC      |
| ARC-AC-20 | Scale-out path is documented and tested    | `DECISIONS.md` DEC-029; `DEPLOYMENT.md`                                                                                          | A stated, stepwise migration to multi-process (Postgres + shared limiter + shared hub) | STATIC      |

### 6.4 Ports and adapters

| ID        | Item                                                    | How to verify                                                               | Expected                                                                                           | Type   |
| --------- | ------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------ |
| ARC-AC-21 | `Database` port is driver-agnostic                      | `db/database.ts`; check for SQLite- or PG-specific leakage in the interface | No driver-specific types                                                                           | STATIC |
| ARC-AC-22 | SQL placeholder rewrite is sound                        | `db/database.ts` `toPostgresPlaceholders`                                   | A literal `?` inside a string/JSON value cannot be rewritten incorrectly — demonstrate with a test | STATIC |
| ARC-AC-23 | `Storage` port is complete                              | `storage/index.ts` vs usage in services                                     | `put/get/delete/exists` sufficient; `s3` refuses at startup by design                              | STATIC |
| ARC-AC-24 | `RealtimeHub` port can accept Socket.IO later (DEC-016) | `realtime/hub.ts` + `http/routes/realtime-routes.ts`                        | Interface has no SSE-specific leakage                                                              | STATIC |
| ARC-AC-25 | `OcrProvider` port isolates providers                   | `ai/providers/types.ts`, `ai/pipeline.ts`                                   | Local vs cloud swap requires no service change                                                     | STATIC |
| ARC-AC-26 | Connectors are isolated failures                        | `services/connector-service.ts`                                             | A throwing connector cannot crash the process — prove with a test                                  | STATIC |

### 6.5 Documentation ↔ code agreement (primary finding source)

| ID        | Item                                                    | How to verify                                                                           | Expected                                                                                       | Type   |
| --------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------ |
| ARC-AC-27 | `ARCHITECTURE.md` §1–§5 describe the shipped system     | Read against the tree                                                                   | Accurate                                                                                       | STATIC |
| ARC-AC-28 | `ARCHITECTURE.md` §6 "target repository layout"         | Compare with `git ls-files`                                                             | Currently cites a non-existent `prisma/` directory — **confirm and correct**                   | STATIC |
| ARC-AC-29 | `ARCHITECTURE.md` §8 "Known gaps"                       | Read                                                                                    | Says "No application code… none of the above is implemented" — **factually wrong; correct it** | STATIC |
| ARC-AC-30 | `ARCHITECTURE.md` §5 claims a "connector sandbox"       | `packages/connectors/src/**`                                                            | Connectors run **in-process with no sandbox** — confirm and correct the claim or raise it      | STATIC |
| ARC-AC-31 | Every `DEC-###` cited by a document exists              | `grep -ohE "DEC-[0-9]{3}" -r . --include=*.md \| sort -u` vs headings in `DECISIONS.md` | No dangling references (precedent: DEC-013 was once cited but missing)                         | STATIC |
| ARC-AC-32 | Every `PRD.json` story maps to at least one file        | Sample 10 stories; check the referenced feature exists                                  | Traceable                                                                                      | STATIC |
| ARC-AC-33 | `README.md` technology table matches installed versions | Read `README.md`; compare with `package-lock.json` / `node --version`                   | Accurate                                                                                       | STATIC |

### 6.6 Boundary and coupling quality

| ID        | Item                                                          | How to verify                                                                         | Expected                                                                                                                                                                          | Type        |
| --------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| ARC-AC-34 | `packages/shared/src/index.ts` is a deliberate public surface | Read; check for accidental re-export of Node-only modules                             | `ids.ts` is Node-only and deliberately **not** re-exported; verify                                                                                                                | STATIC      |
| ARC-AC-35 | No circular imports                                           | Run `npx madge --circular --extensions ts,tsx apps packages` (or equivalent)          | Zero cycles                                                                                                                                                                       | **RUNTIME** |
| ARC-AC-36 | Largest modules are justified or decomposed                   | `wc -l` per file; flag >400 LOC                                                       | List: `auth-service.ts` 903, `connector-service.ts` 566, `client.ts` (desktop) 960, `migrations.ts` 528, `SettingsPage.tsx` 695. Each needs a justification or decomposition note | STATIC      |
| ARC-AC-37 | Duplicated logic across workspaces                            | Compare `apps/mobile/src/api/client.ts` (388), `apps/desktop/src/api/client.ts` (960) | Document what is genuinely shared vs forked, and why                                                                                                                              | STATIC      |
| ARC-AC-38 | Error model is uniform                                        | `packages/shared/src/errors.ts` + `http/app.ts`                                       | One `AppError` + one envelope; no route invents its own shape                                                                                                                     | STATIC      |

### 6.7 Deliverables

| ID        | Item                    | Output                                                                                        | Type  |
| --------- | ----------------------- | --------------------------------------------------------------------------------------------- | ----- |
| ARC-AC-39 | Canonical layer map     | `evidence/R01/layer-map.md` — every module placed in a layer, with the dependency rule stated | WRITE |
| ARC-AC-40 | Dependency graph        | `evidence/R01/dependency-graph.md` (or `.svg`)                                                | WRITE |
| ARC-AC-41 | ADR register            | `evidence/R01/adr-register.md` — every DEC, its status, and whether the code honours it       | WRITE |
| ARC-AC-42 | Architecture drift list | `evidence/R01/doc-drift.md` — doc claim, code reality, file:line, corrected text              | WRITE |

---

## 7. Known architectural risks to confirm or refute

These were identified in the parent assessment. **Confirm each yourself; do not copy the conclusion.**

| Risk | Statement                                                                                    | Where to look                                                                                       |
| ---- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| R-04 | PostgreSQL production path is never executed; migrations are SQLite-flavoured                | `db/migrations.ts`, `db/postgres.ts` (R03 owns this; you only record the architectural consequence) |
| R-16 | `ARCHITECTURE.md` claims a connector sandbox that does not exist; connectors run in-process  | `packages/connectors/src/**`, `connector-service.ts`                                                |
| R-24 | `node:sqlite` is an **experimental** Node API — the default storage engine is not API-stable | runtime warning in test output; `db/sqlite.ts`                                                      |
| R-25 | `JWT_SECRET` is used both to sign tokens and to derive the credential-encryption key         | `auth/tokens.ts`, `services/crypto.ts`                                                              |
| R-18 | `AttemptLimiter` is in-process and its `hits` map never evicts                               | `auth/tokens.ts`                                                                                    |
| R-21 | Documentation drift (three separate documents contradict the code)                           | `ARCHITECTURE.md`, `AGENT_STATE.md`, `DEPLOYMENT.md`                                                |

---

## 8. Questions you must answer in the report

1. Can a new engineer implement a feature end-to-end without asking where code goes? Cite the file that answers it (and fix it if it does not).
2. Is the composition root the only place that knows about concrete adapters? If not, where does the knowledge leak?
3. If the product needed to run 10 API replicas tomorrow, what breaks first, in order? Be specific about in-process state.
4. Which single architectural decision is carrying the most risk, and what would reversing it cost?
5. Is the connector model safe for third-party code (Marketplace), given connectors execute in-process?
6. Does `packages/shared` create a hidden coupling between mobile, desktop and backend that makes independent release impossible?

---

## 9. Commands to run

```bash
# --- setup (once) ---
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund

# --- layer violations ---
grep -rnE "SELECT |INSERT |UPDATE |DELETE FROM " apps/backend/src --include=*.ts \
  | grep -v "/repositories/" | grep -v "/db/"
grep -rn "process.env" apps/backend/src --include=*.ts
grep -rn "request\.\|reply\.\|FastifyRequest" apps/backend/src/services
grep -rn "apps/" packages/shared/src packages/connectors/src
grep -rn "from '\.\./\.\./\.\./\.\./apps" apps packages --include=*.ts --include=*.tsx

# --- dependency cycles (install once) ---
npx --yes madge@8 --circular --extensions ts,tsx apps packages

# --- module size census ---
git ls-files 'apps/**/*.ts' 'apps/**/*.tsx' 'packages/**/*.ts' \
  | xargs wc -l | sort -rn | head -30

# --- ADR integrity ---
grep -ohE "DEC-[0-9]{3}" -r . --include=*.md | sort -u > /tmp/cited.txt
grep -ohE "^##+ DEC-[0-9]{3}" DECISIONS.md | grep -oE "DEC-[0-9]{3}" | sort -u > /tmp/defined.txt
comm -23 /tmp/cited.txt /tmp/defined.txt   # cited but not defined  → must be empty

# --- two-worker safety (ARC-AC-17) ---
npm run db:migrate
PORT=4100 WORKER_ENABLED=true SQLITE_PATH=/tmp/arc.db npm run dev:backend &
PORT=4101 WORKER_ENABLED=true SQLITE_PATH=/tmp/arc.db npm run dev:backend &
# upload two documents via the desktop or curl, then inspect:
sqlite3 /tmp/arc.db "SELECT id,status,attempts FROM jobs;"
sqlite3 /tmp/arc.db "SELECT COUNT(*) FROM audit_logs;"
kill %1 %2

# --- full gate (for context, expect green) ---
npm run verify
```

---

## 10. Tests to perform

| #    | Test                      | Procedure                                                                                                                  | Pass criterion                                                                                                                         |
| ---- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| T-01 | Layer violation sweep     | Run the greps in §9                                                                                                        | Zero violations outside `db/` and `repositories/`; every hit justified in writing                                                      |
| T-02 | Cycle detection           | `madge --circular`                                                                                                         | Zero cycles                                                                                                                            |
| T-03 | Two-worker concurrency    | Start two workers on one DB; process 20 documents                                                                          | No duplicate job execution, no crash, no duplicated audit entries                                                                      |
| T-04 | Two-replica API behaviour | Run two API processes; exercise sign-in, upload, SSE                                                                       | Document every behaviour that differs from single-process (rate limits reset per process, SSE only delivers from the emitting process) |
| T-05 | Connector throw isolation | Register a connector that throws; trigger a run                                                                            | Process survives; error surfaced to the user with an actionable message                                                                |
| T-06 | Placeholder rewrite       | Insert a document whose JSON payload contains `?`; run against Postgres — **if** Postgres is available (R03 may supply it) | `?` inside data is not rewritten to `$n`                                                                                               |
| T-07 | Documentation replay      | Take `ARCHITECTURE.md` §3 data flows and execute each against the running system                                           | Every documented flow is observable; note any that are not                                                                             |
| T-08 | ADR citation integrity    | Run the `comm` command in §9                                                                                               | Empty output                                                                                                                           |

---

## 11. Evidence required (write these files)

```
docs/reviewers/evidence/R01/
├── layer-map.md              # every module → layer; the dependency rule; exceptions
├── dependency-graph.md       # workspace graph + any import cycles found
├── adr-register.md           # DEC-### | title | status | honoured by code? | notes
├── doc-drift.md              # doc | claim | code reality | file:line | corrected text
├── state-inventory.md        # every piece of in-process state + multi-replica consequence
├── commands.log              # raw output of every command in §9
└── findings.md               # ARC-### register
```

---

## 12. Passing conditions (chairs G1; co-signs G8)

- [ ] **P1** No SQL outside `repositories/` and `db/` (ARC-AC-01).
- [ ] **P2** No `process.env` read outside `config.ts` (ARC-AC-02).
- [ ] **P3** No dependency from `packages/*` into `apps/*`; no `apps/*` → `apps/*` import (ARC-AC-05, ARC-AC-06, ARC-AC-08).
- [ ] **P4** Workspace graph acyclic **and** import graph cycle-free (ARC-AC-09, ARC-AC-35).
- [ ] **P5** Composition root is the only place adapters are constructed (ARC-AC-11, ARC-AC-12).
- [ ] **P6** Two workers against one database produce no duplicate work (ARC-AC-17, T-03).
- [ ] **P7** Every piece of in-process state is inventoried with its multi-replica consequence (ARC-AC-19, T-04).
- [ ] **P8** Connectors cannot crash the host process (ARC-AC-26, T-05).
- [ ] **P9** `ARCHITECTURE.md` describes the shipped system; §6 and §8 corrected; the "connector sandbox" claim corrected (ARC-AC-27 … ARC-AC-30).
- [ ] **P10** Every cited `DEC-###` exists (ARC-AC-31, T-08).
- [ ] **P11** The four §11 evidence files are complete and every ARC finding has severity, file:line and owner.
- [ ] **P12** No finding of severity CRITICAL or HIGH remains open without a written, dated owner exception.

**If any condition is false, G1 FAILS.** Record it in §13 and hand the blocking findings to the wave-2 reviewers, who must not treat the architecture as approved.

---

## 13. Blocked items

| Item ID | Blocker | What unblocks it | Owner |
| ------- | ------- | ---------------- | ----- |
|         |         |                  |       |

---

## 14. Findings register

| ID      | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
| ------- | -------- | --------- | ------- | -------------- | --------- | ------------- | ----- |
| ARC-001 |          |           |         |                |           |               |       |

---

## 15. Reviewer sign-off

| Field                   | Value                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewer name           |                                                                                                                                                       |
| Date started            |                                                                                                                                                       |
| Date completed          |                                                                                                                                                       |
| Gate G1 result          | ☐ Pass ☐ Fail                                                                                                                                         |
| **G8 co-sign result**   | ☐ Pass ☐ Fail ☐ Abstain                                                                                                                               |
| Conditions failed (IDs) |                                                                                                                                                       |
| Overall confidence      | ☐ High ☐ Medium ☐ Low                                                                                                                                 |
| Reviewed commit         | `43d384b`                                                                                                                                             |
| Statement               | _I inspected every file listed in §4, executed every `[RUNTIME]` item, and my findings are reproducible from the commands in §9 on a clean checkout._ |
| Signature               |                                                                                                                                                       |
