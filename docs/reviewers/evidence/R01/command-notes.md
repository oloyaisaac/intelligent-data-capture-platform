# R01 command transcript notes — incomplete

`baseline-9ec567c.txt` records a fresh limited static sweep, manifest edges, tracked Markdown ADR
citation comparison, source-map path comparison and Madge scan against base commit `9ec567c`. The
first SQL exclusion command was wrong and included repository/database hits; the corrected search is
separately recorded. Its six remaining hits are comments, English text or connector methods rather
than SQL statements. Search results are not proofs about dynamically generated code. `npm ci` was
run with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`; no packaged Electron runtime was installed or validated.
This is author-side working evidence, not an independent review or final-commit assessment.

On the same source baseline, `npm test -- --runInBand --selectProjects backend --runTestsByPath`
with `composition-boundary`, `sql-boundary`, `workers-process`, `replica-process`,
`connector-process-security`, and `architecture-flow` test files passed **6 suites / 9 tests**.
These focused tests do not prove production isolation, exactly-once effects, or multi-replica safety.
`npm run lint` passed after fixing lint violations in the evidence scan script. The evidence script's
output reproduced the saved scan, selected Prettier checks passed, and `git diff --check` passed.

A subsequent `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund` restored dependencies.
The focused backend `security.test.ts`, `composition.test.ts`, `storage-exclusive.test.ts`, and
`connector-boundary.test.ts` run passed **4 suites / 42 tests** under the default local test
configuration. `npm run lint`, selected evidence Prettier checks and `git diff --check` passed.
These are not a full suite or a production, independent or specialist review.

`node docs/reviewers/evidence/R01/placeholder-probe.cjs` runs the transpiled source helper in an
isolated JavaScript context with no database. Its saved output demonstrates ordinary single-quoted
handling and synthetic dollar-quoted/comment counterexamples; see ARC-046. The placeholder probe
and source-import scan reproduced their saved evidence on this baseline.

A focused run of backend `workers-process.test.ts`, `replica-process.test.ts`,
`worker-stale-process.test.ts` and `worker-recovery-audit.test.ts` passed **4 suites / 4 tests**.
The first test exercises two subprocesses and 20 synthetic documents; `state-inventory.md` records
exactly what was checked and its limitations. `npm run lint` passed. The workspace alias scan
(`node docs/reviewers/evidence/R01/workspace-alias-scan.cjs`) reproduced its saved output;
selected Prettier and diff checks passed. No PostgreSQL or production environment was exercised
in this focused run.

For ARC-049, the following command reproduced the saved synthetic output:

```sh
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/provider-selection-probe.ts
```

The initial attempt omitted `TSX_TSCONFIG_PATH` and failed resolving `@idcp/shared/ids`; the corrected
command succeeded.
The probe uses in-memory SQLite, a synthetic image and the real cloud adapter with an injected
fetch stub; no real provider request or production data was used. Focused backend tests
`provider-composition.test.ts`, `remote-ocr-org-budget.test.ts` and `templates.test.ts` passed
**3 suites / 14 tests**. They do not establish per-organisation cloud consent or template-version
provenance. `npm run lint`, selected Prettier checks and `git diff --check` passed.

`node docs/reviewers/evidence/R01/import-scan.cjs` produced `import-scan-9ec567c.txt`. Of 881 literal
specifier occurrences in 195 tracked source files, no resolved app-to-app or package-to-app edge
was found; no Node/electron import was found in desktop pages/components/lib. TypeScript resolution
reported the existing desktop CSS import unresolved. Two mobile native shims use nonliteral
`require(name)`; their visible call sites name native libraries, but runtime and Metro resolution are
not proven. The script uses the base tsconfig, excludes tests/config and cannot resolve arbitrary
runtime values; R09/R10/R11/R16 should review their respective platform boundaries.

`commands.log` contains captured command output and exit statuses from the clean-install, static
sweep, Madge, focused integration tests and full local verification on worktree `7dc278c`, plus an
isolated SQLite migration smoke test. The sandbox clock printed in that raw output differs from the
session's stated date; it is recorded as the runner's clock, not used as a reviewer sign-off date.

- In the SQL and cross-workspace greps, exit 1 means no matching line, not a command crash. These
  literal text searches are narrower than a complete TypeScript import or dynamically generated SQL
  analysis.
- The service HTTP grep's `request.format` etc. are fields of `CreateExportRequest`, a shared
  application contract (`export-service.ts`), not Fastify request/reply objects. The pairing hit is
  a comment. A grep alone does not prove there are no other HTTP dependencies.
- The module-size command printed its requested first 30 rows but exited 141: under `pipefail`,
  `head` can close its pipe early and interrupt `sort`. `module-census.md` records a separate
  source-only census and decomposition notes.
- The citation check uses tracked Markdown rather than recursively searching installed dependencies;
  no cited `DEC-###` was missing from `DECISIONS.md` in that scope.
- A focused Odoo stub regression first failed on the prior instance-lifetime UID cache when a remote
  user ID changed. After removing the cross-operation cache, the focused connector suite verifies
  fresh authentication, credential changes, batch reuse and empty batches. This does not exercise a
  real Odoo server or establish atomic remote writes.
- The two-subprocess SQLite live-claim regression failed on the prior age-based startup recovery:
  the second process entered OCR while the first was paused. After removing automatic requeue it
  passes with one attempt. The SIGKILL regression now needs explicit requeue; the offline CLI
  regression checks confirmation flags, attempt matching and limited output on synthetic SQLite data.
  Local `npm run verify` passed 61 suites and 636 tests, with four PostgreSQL tests skipped. This
  does not prove offline controls, idempotent external effects or production recovery. For commit
  `f75a772`, [CI run 44598906112](https://github.com/oloyaisaac/intelligent-data-capture-platform/actions/runs/44598906112)
  passed Verify, PostgreSQL and browser checks; the container build initially failed during `npm ci`
  with its underlying error unavailable in the accessible annotations. The failed container job
  passed on rerun. The cause of the initial failure remains unknown.
- Connector subprocess work: local `npm run verify` passed 64 suites and 643 tests with four
  PostgreSQL tests skipped. The transport tests exercise timeout, output and input limits, child
  exit, environment filtering and synthetic CSV calls. A synthetic fatal child leaves an API route
  responsive, while a different same-privilege child kills a disposable API host. A local bundled
  backend against in-memory SQLite also passed a synthetic CSV validation/health smoke test; no
  real external destination or sandbox was exercised. P8 remains unmet.
- Local PostgreSQL and Docker were unavailable. PostgreSQL, Compose and browser jobs passed at
  `7dc278c` in [CI](https://github.com/oloyaisaac/intelligent-data-capture-platform/actions/runs/44548570287).
  That is not production validation.
- The original manual two-server/sqlite3 sequence is not in this transcript. Automated real
  subprocess tests supply narrower synthetic two-worker and two-API observations; they do not
  establish safe worker recovery. Real mobile, packaged desktop, real OCR, external destinations,
  complete documentation replay and independent sign-offs remain unverified.

## Further runtime observations

A disposable `@embedded-postgres/linux-x64@16.16.0-beta.19` PostgreSQL 16.16 server was
initialized with UTF-8 under ignored `.cache` and started with a private Unix socket and no TCP
listener. `postgres-question-mark-probe.ts` passed using the real driver and a temporary schema;
`postgres-runtime-evidence.md` records the commands, scope and limitations. The server was stopped.
The first initialized cluster defaulted to SQL_ASCII; it was not used for the probe, which used a
separate UTF-8 cluster. The runner's PostgreSQL log date is not an independent review date.

`TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/upload-rate-probe.ts`
reproduced ARC-051 with local SQLite, memory storage and a real local test HTTP listener; no proxy
or production environment was involved. The probe has saved text output and deliberately does not
print credentials, tokens or synthetic document contents.

The focused local backend `security.test.ts`, `pairing.test.ts` and `replica-process.test.ts` run
passed **3 suites / 37 tests**. `npm run lint`, selected Prettier formatting and `git diff --check`
passed. These tests do not cover or resolve the single-document upload-rate mismatch or demonstrate
production edge throttling.

## Continued R01 flow, state and error review

After `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund`, the focused command below
passed **3 backend suites / 18 tests** on SQLite. The transcript is `flow-replay-9ec567c.txt`;
`flow-replay.md` maps observed and untested portions of the documented flows. This is synthetic
local HTTP/fake OCR/CSV evidence, not native-client, remote-provider or production verification.

```sh
env -u IDCP_TEST_DB_DRIVER -u DATABASE_URL npm test -- --runInBand --selectProjects backend --runTestsByPath apps/backend/test/architecture-flow.test.ts apps/backend/test/devapi.test.ts apps/backend/test/membership-scope.test.ts
```

`devapi.test.ts` covers the injected non-subscribing realtime hub response referenced in ARC-052;
it does not assert that the default hub emits that error. `npm run lint` passed. The bounded
`state-scan.cjs` generated `state-scan-9ec567c.txt`; its classifications and omissions are in
`state-inventory.md`. These observations are not independent sign-off or complete replica safety.

Post-update checks: `npm run lint`, the state-scan transcript comparison, Prettier formatting and
`git diff --check` passed. A consistency script found all 42 checklist IDs unique and all recorded
finding IDs represented in the proposed handoff, including ARC-052. These are mechanical checks,
not verification of specialist conclusions or gate criteria.

## Client boundary and refresh reuse review

`client-refresh-probe.ts` drove the real desktop and mobile `ApiClient` classes with stubbed `fetch`
implementations (no network) and recorded `client-refresh-probe-9ec567c.txt`. `refresh-race-probe.ts`
exercised the real backend refresh route, service, repositories and SQLite database with an
artificial barrier inserted only into `SessionsRepository.findByTokenHash`, and recorded
`refresh-race-probe-9ec567c.txt`. Both probes passed their internal assertions; their outputs are
saved verbatim. The desktop/mobile focused suites were not modified, and no application code or
owner-approved exception was produced by this review.

```sh
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/client-refresh-probe.ts
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/refresh-race-probe.ts
```

Existing focused suites were rerun unchanged on the baseline: backend `auth.test.ts`,
`auth-recovery.test.ts` and `membership-scope.test.ts` passed **3 suites / 28 tests** (SQLite), and the
desktop/mobile Jest projects passed **5 suites / 137 tests** (transcript
`client-tests-9ec567c.txt`). They cover sequential refresh only; none exercises two simultaneous 401s
or a reused refresh token, so they neither confirm nor refute ARC-053/ARC-054.
`npm run lint`, `prettier --check` on the R01 evidence directory and `git diff --check` passed. These
checks are mechanical and do not constitute security, client or concurrency approval.

## Architecture-document and environment-contract verification

Static verification only, on `9ec567c`. `architecture-doc-verification.md` walks `ARCHITECTURE.md`
§1–§8 and cites the code for each claim; the §6 layout block was expanded programmatically and every
path was checked with `os.path.exists`, with no missing entries. The environment comparison matched
the 50 `ConfigSchema` keys against `.env.example` (none missing, adding only the four client-build
keys), the `ENVIRONMENT.md` §4 table (twelve keys absent) and the drift-test source
(`apps/backend/test/config.test.ts` compares schema to `.env.example` only).

```sh
env -u IDCP_TEST_DB_DRIVER -u DATABASE_URL npm test -- --runInBand --selectProjects backend \
  --runTestsByPath apps/backend/test/config.test.ts
```

`config.test.ts` passed **1 suite / 11 tests**, including "does not read process.env elsewhere in
backend source" and both directions of the `.env.example` comparison. That result is not evidence that
the `ENVIRONMENT.md` §4 table is complete: the test never reads that file.

A quoting mistake in this turn's shell heredoc also caused Jest to run the **entire backend project**
once, with no explicit test paths. That unintentional run passed: **123 suites / 715 tests passed,
41 tests in 4 suites skipped, 127 suites total**, in 171.6 s, on the default SQLite driver. It is
recorded because it is real evidence about the baseline, but it is a single local SQLite pass: it is
not the PostgreSQL run, not the client projects, not end-to-end or packaging evidence, and skipped
tests are not passes. No test, source or configuration file was edited.

No application, documentation or configuration file outside `docs/reviewers/evidence/R01/` was
modified, and the reviewer brief is unchanged.

## Repository-layer sweep

`sql-boundary-9ec567c.txt` holds the placement sweep: zero literal SQL matches outside `db/` and
`repositories/`, zero interpolated query templates outside them, and a ranked list of the
interpolation counts per repository. `repository-boundary-review.md` reads all 27 repository files
against ARC-AC-04 and records four displacements plus the near-misses that should not be treated as
violations. No new probe was written for ARC-056; the read-then-act shape is cited to specific lines
and left to R06/R03 rather than synthesised into a concurrency test.

```sh
grep -rnE "SELECT |INSERT |UPDATE |DELETE FROM " apps/backend/src --include=*.ts \
  | grep -v "/repositories/" | grep -v "/db/"
rg -n '\.(execute|query|one)\(\s*`[^`]*\$\{' apps/backend/src -g '!**/repositories/**' -g '!**/db/**'
```

Both commands returned no matches. Prettier, ESLint and `git diff --check` remain clean.

The ownership-adjacent suites were rerun unchanged to confirm the current behaviour still passes:
`sql-boundary`, `privacy`, `teams` and `review-connector-role-safety` — **4 suites / 37 tests
passed** on SQLite. They cover the sequential owner and erasure rules; none drives two concurrent
owner mutations, so they neither confirm nor refute ARC-056.

## Composition-root verification (P5)

Static sweep only. Every adapter constructor in `apps/backend/src` was listed by class name
(`PostgresDatabase`, `SqliteDatabase`, `ReadOnlySqliteDatabase`, `FilesystemStorage`, `MemoryStorage`,
`InMemoryRealtimeHub`, `TesseractProvider`, `CloudVisionProvider`, `SmtpMailer`, `ConnectorProcess`,
`ConnectorRegistry`) and the read-only mechanism of each `src/db/*-cli.ts` was grepped individually
(`default_transaction_read_only`, `SET TRANSACTION READ ONLY`, `ReadOnlySqliteDatabase`). The two
existing guards were rerun rather than assumed:

```sh
env -u IDCP_TEST_DB_DRIVER -u DATABASE_URL npm test -- --runInBand --selectProjects backend \
  --runTestsByPath apps/backend/test/composition-boundary.test.ts apps/backend/test/config.test.ts
```

**2 suites / 14 tests passed.** `composition-boundary.test.ts` covers direct and aliased repository
construction in service modules; `config.test.ts` covers the single `process.env` reader and the
`.env.example` contract. Neither covers the offline CLI read-only modes — that absence is the point of
ARC-057, not something these runs close.

## Shutdown and timer review

`timer-scan-9ec567c.txt` lists every `setInterval`/`setTimeout` in backend source (seven sites) and
every module-scope `let`. `shutdown-probe.ts` starts the real `apps/backend/src/index.ts` on loopback,
registers a synthetic user, opens an authenticated SSE stream and sends `SIGTERM`, in four
configurations; `shutdown-probe-9ec567c.txt` is its verbatim output. It uses in-memory SQLite, an
ephemeral temporary directory and no external service.

```sh
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/shutdown-probe.ts
```

Result: idle `SIGTERM` → exit 0 in 10 ms; with one open SSE stream the process was still running after
8 s and had to be killed; disabling maintenance did not change that; and the process exited only after
the client disconnected. That is ARC-058.

Two dead ends worth recording so they are not repeated: a first version of the probe used
`?access_token=invalid`, received `401` and therefore tested nothing (the stream never opened), and an
earlier bash attempt to start the entry point outside the Jest project failed with
`Cannot find module '@idcp/shared/ids'` because the workspace alias resolution comes from the tsx
project setup. The probe now registers a real synthetic user through the API instead of fabricating a
token.

## Ports, seams and layer-integrity completion

`layer-integrity-9ec567c.txt` appends the sweeps behind the rows closed in
`ports-and-seams-completion.md`: every `process.env` reference in backend source and in
`packages/*/src`, every `FastifyRequest`/`reply` occurrence in `services/`, that there is no
`await new Promise`/`setImmediate` in services, the per-file count of `Date.now()`/`new Date()` in
services (27 across 9 files), and every `randomUUID`/`randomBytes` use outside `auth/` and
`repositories/` (six sites, two of which bypass `newId()`).

```sh
env -u IDCP_TEST_DB_DRIVER -u DATABASE_URL npm test -- --runInBand --selectProjects backend \
  --runTestsByPath apps/backend/test/composition-boundary.test.ts apps/backend/test/sql-boundary.test.ts
```

**2 suites / 5 tests passed.** Neither suite asserts the no-`process.env`, no-clock-port or
`newId()` conventions; those rows stay unmet on their own evidence rather than being marked verified
by an unrelated green run.

## ADR register completion (pass 3)

Static reading only; no decision text or status was modified. Thirteen rows (DEC-001, 002, 004, 005,
009, 012, 014, 018, 019, 022, 023, 025, 030) moved from "not assessed"/"partially assessed" to a
definite verdict with file references, leaving all 34 decisions assessed. The evidence for the three
newly-honoured rows is `review-service.ts`/`batch-service.ts` (DEC-018), `auth-service.ts`
(DEC-019/DEC-030) and `scripts/validate-packaging.mjs` (DEC-022).

Two things surfaced during the pass and were recorded rather than invented as incidents: the stored-UDM
version gap (ARC-059) and the `NODE_ENV`-dependent reset-URL disclosure noted under DEC-030.

Housekeeping: `node_modules` had been pruned since the previous turn, so `npx prettier` silently fetched
prettier@3.10.1 and reflowed one table. Dependencies were restored with
`ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund` and formatting rechecked with the
lockfile-pinned version; the evidence also previously cited `batch-service.summarise`, which is the
correct name.

## Claim-fence probe (P6 / ARC-060)

`claim-block-probe.ts` launches the existing `test/fixtures/worker-stale-process.ts` twice — once in
`hold` mode (killed with `SIGKILL` inside fake OCR) and once in `recover` mode — against one synthetic
SQLite file, and drives the repositories directly to seed and inspect jobs.

```sh
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/claim-block-probe.ts
```

Output is `claim-block-probe-9ec567c.txt`. The first draft of the finding inferred a silent permanent
block from step C alone and rated it HIGH; checking the service layer showed `hasActiveExtraction`
counts `queued` or `running` and `document-service.ts:344-347` returns a 409, so the probe now asserts
that guard explicitly and the finding is recorded as LOW with the correction stated in place. Both the
probe and the finding keep the wrong first reading visible rather than silently rewriting it.

Note: `node_modules` was pruned again between turns, so `npx prettier` fetched 3.10.1 and the probe
failed with `Cannot find package 'tsx'`. Dependencies were restored with
`ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund` and the local binary
(`./node_modules/.bin/prettier`) is used for formatting from here on.

## Connector containment matrix (P8)

`connector-isolation-probe.ts` drives the real `ConnectorProcess` through five adversarial children via
an evidence-only host (`fixtures/connector-isolation-host.ts`). Saved output:
`connector-isolation-probe-9ec567c.txt`. The three existing containment suites were also rerun:
`connector-process-security`, `connector-process-api` and `connector-fatal-process` — **3 suites / 3
tests passed**.

```sh
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/connector-isolation-probe.ts
env -u IDCP_TEST_DB_DRIVER -u DATABASE_URL npm test -- --runInBand --selectProjects backend \
  --runTestsByPath apps/backend/test/connector-process-security.test.ts \
  apps/backend/test/connector-process-api.test.ts apps/backend/test/connector-fatal-process.test.ts
```

Two probe versions were wrong before the results were usable — an ignored environment variable plus a
missing IPC start message, then a host that never exited after the transport had already settled. Both
are recorded in `connector-isolation-evidence.md`; the saved transcript is from the corrected run.

## P12 register audit

Severity was reconciled across all three places it is recorded — each `### ARC-nnn — SEVERITY:`
heading in `findings.md`, the header table in the same file, and the per-finding rows in
`completion-status.md` — and the three sources agree. A search for any exception wording
(`owner exception|accepted exception|exception granted|risk acceptance`) across `docs/` returns only
the requirements themselves. Result: 48 findings / 0 CRITICAL / 35 HIGH / 12 MEDIUM / 1 LOW / 0
exceptions. Written up in `p12-unexcepted-findings.md`.

Note on a self-inflicted error worth avoiding: a heredoc whose content contained a line reading only
`PY` terminated the heredoc early and produced a Python `SyntaxError`. Nothing was half-written — the
parse failed before any write — but the delimiter for a heredoc that embeds a shell transcript should
not be a token that appears in the transcript.

## Two-replica observation (T-04)

Two real backend processes on one SQLite file (`two-replica-probe.ts`, ports 4300/4301,
`WORKER_ENABLED=false`). Observed, not inferred: the auth limiter budget is per process (four failed
logins per replica against a configured 3 → 401,401,401,429 on **each**, so six accepted across the
pair), and an event published by replica B reached no stream held on replica A. Sign-in, registration
and pairing were actually exercised; upload was not, and the write-up says so. Transcript:
`two-replica-9ec567c.txt`; analysis: `two-replica-evidence.md`.

`HOST=127.0.0.1` in the probe is deliberate — it runs inside the sandbox; the browser-facing rule about
localhost does not apply to a server-to-server probe.

## ADR citation integrity (T-08)

The brief's own `comm` check, run verbatim at `9ec567c`: 34 decisions cited, 34 defined, empty in both
directions. Saved as `adr-integrity-9ec567c.txt`. This checks citations only; whether code honours each
decision is the separate register assessment.

## §7 risk re-check (PostgreSQL dialect)

`pg-dialect-check.ts` reads `db/migrations.ts` for dialect handling and probes TCP 5432:
34 `CREATE TABLE` statements, per-dialect branches present, 2 `tx.driver === 'postgres'` switches, the
advisory lock present, **no** SQLite-only keywords, and no server reachable from this sandbox
(`ECONNREFUSED`). Transcript `pg-dialect-9ec567c.txt`. This refutes the inherited R-04 claim by source
and CI configuration; it does **not** execute the PostgreSQL path and is not a substitute for R03.

Three rewrites of this small probe failed before it ran (a top-level `await` rejected by the CJS
transform, then two patch attempts that left unbalanced braces). The lesson is the same as the
connector probe: rewrite the file rather than patching a file that has already been patched twice.

## Two-worker audit rows and crash recovery (ARC-AC-17)

`two-worker-audit-probe.ts` runs real backend processes against one SQLite file with a fake OCR binary
(`TESSERACT_BIN`), so no external service or real document is involved. Two modes:

```sh
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/two-worker-audit-probe.ts
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/two-worker-audit-probe.ts crash
```

`clean`: 12/12 extracted, no duplicate audit rows, no duplicate job rows, no crash.
`crash`: the only worker is SIGKILLed after the database shows `running > 0`, then a fresh process
starts on the same file — 11/12 completed, one document stranded in `processing`, nothing requeued.
Transcript `two-worker-audit-9ec567c.txt`; analysis `two-worker-audit-evidence.md`.

Note on the earlier `two-replica-probe.ts`: I claimed its health check was wrong. It is not — `/api/v1/health`
exists at `http/app.ts:105`. The real bug was using a deliberately invalid token for the SSE stream,
which produced a 401 instead of a stream. Corrected claim.

## Baseline equivalence after the merge

The code tree is byte-identical between `9ec567c` (the baseline all evidence was gathered against) and
the merged `main`: 0 non-document paths changed. `baseline-equivalence.txt`.
