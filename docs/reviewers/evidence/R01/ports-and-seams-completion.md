# R01 ports, seams and boundary completion (ARC-AC-02/03/05/06/09/13/15/21/23/24/25/34)

**Purpose:** close the remaining checklist rows that were still marked "partial"/"unmet" from the
first pass, using measurements rather than restated impressions. Baseline `9ec567c`. Scope is R01's
own: whether the seams are in the right places and whether the stated boundaries hold. Adapter
correctness inside each port belongs to the specialist reviewers named in the tables.

`layer-integrity-9ec567c.txt` is the transcript for the static sweeps cited below.

## 1. Layer-integrity sweeps that moved a row

### ARC-AC-02 — `process.env` outside `config.ts`: **met**

Every hit in `apps/backend/src` is inside `config.ts` (three loader functions plus the module comment),
and `packages/*/src` contains none. `config.test.ts` additionally asserts the absence by scanning
backend source, so this is not only observed but guarded. Indirect reads (`process['env']`,
`globalThis.process`) do not appear.

### ARC-AC-03 — HTTP concerns in services: **met**

No service imports `fastify` or `../http`. The text hits that made this "partial" are benign and are
now identified:

- `services/export-service.ts` uses a parameter literally named `request` — it is a
  `CreateExportRequest` DTO from `@idcp/shared`, not a `FastifyRequest`.
- `services/pairing-service.ts:210` is a comment containing the word "request".

A grep for `FastifyRequest|FastifyReply` in `services/` returns nothing. The earlier "partial" was a
false positive of the search pattern, not a code defect.

### ARC-AC-05/06 — `packages/*` importing `apps/*`: **met for literals and resolved imports**

No literal `apps/` path appears in `packages/shared/src` or `packages/connectors/src`, and the earlier
bounded TypeScript import scan (`import-scan-9ec567c.txt`) resolved every cross-workspace import in the
195 scoped files without finding a package→app edge. Dynamic resolution remains outside what either
check can see.

### ARC-AC-09 — workspace graph acyclic: **met**

Five workspace manifests with internal edges only in the documented direction
(`shared` ← `connectors` ← `backend`; `desktop`/`mobile` → `shared`). Confirmed against the manifests
and the Madge run that found no cycles across 355 files.

## 2. Test seams (ARC-AC-13, ARC-AC-15)

### Ports and their doubles — the full picture

| Port          | Production adapter                              | Test double(s)                                                               | Seam quality                                                                                    |
| ------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `Database`    | `SqliteDatabase`, `PostgresDatabase`            | real `SqliteDatabase` on `:memory:`; `ReadOnlySqliteDatabase` for inspection | Best seam in the codebase: tests use the real driver and real migrations rather than a fake.    |
| `Storage`     | `FilesystemStorage`                             | `MemoryStorage`; `NODE_ENV=test` selects it in the container                 | Good, with the caveat that memory storage cannot express partial writes or permission failures. |
| `RealtimeHub` | `InMemoryRealtimeHub` (the only implementation) | the same class, plus ad-hoc hubs without `subscribe`                         | Adequate; there is no second transport, so the port is exercised but not proven substitutable.  |
| `OcrProvider` | `TesseractProvider`, `CloudVisionProvider`      | `FakeOcrProvider` with recorded call count                                   | Good — the fake is injectable at the container boundary.                                        |
| `Connector`   | 8 first-party adapters + process transport      | stub registries, a fake connector process, throw/fatal child fixtures        | Good, and better than most: failure modes are simulated, not just success.                      |
| `Mailer`      | `SmtpMailer` or `null`                          | injected fake in tests                                                       | Good.                                                                                           |
| `Clock`       | **no port**                                     | `now` parameters on individual functions                                     | See ARC-AC-15 below.                                                                            |

### ARC-AC-15 — clock, ids and randomness: **unmet for the universal claim, and the reason is structural**

There is no clock port. Time is read directly in services — `Date.now()`/`new Date()` appears 27 times
across 9 service files, concentrated in `auth-service.ts` (6), `organisation-service.ts`,
`export-service.ts` (4 each), `maintenance-service.ts` and `connector-service.ts` (3 each). Where a
test needs control, the code accepts an optional `now` argument instead: `maintenance.runOnce(now)`,
`windowStart(days, now)`, `listForUser(userId, now)`, `newSortableId(now)`. That convention is
consistent but not universal, and it is not enforced by anything.

Identity/randomness is the same shape. `newId()` exists in `@idcp/shared/ids`, but two services bypass
it: `document-service.ts:146` calls `crypto.randomUUID()` and `privacy-service.ts:176` imports
`randomUUID` from `node:crypto` directly. Neither is a defect — both produce a UUID v4 — but it means
"identifiers are generated in one place" is false, and a future change to id format would miss them.

What this actually costs: expiry, retention cutoffs and retry windows cannot be advanced in a test
without injecting a `now` at each call site, so timer-dependent behaviour tends to be tested by
constructing aged rows rather than by moving the clock. That is workable, and the suite does it
(e.g. the stale-claim tests), but it is a seam by convention rather than by design. Recorded, not
recommended for change here — R02/R16 own test architecture.

## 3. Port shape quality (ARC-AC-21, ARC-AC-23, ARC-AC-24, ARC-AC-25, ARC-AC-34)

### ARC-AC-21 — `Database` port is driver-agnostic: **not literally true, deliberately**

`db/database.ts:17` exposes `readonly driver: 'sqlite' | 'postgres'` on the port, and repositories
branch on it at **25 sites** (`FOR UPDATE` vs nothing, `"C"` vs `BINARY` collation, `ON CONFLICT`
variants, `SET TRANSACTION READ ONLY`). This is the single largest divergence between the documented
design ("repositories are the only code that knows which one is live") and the code, and it is
defensible: the alternative — pretending the drivers are identical — would have meant giving up row
locks on PostgreSQL, which is the concurrency guarantee several flows depend on. The honest statement
is that the port is _operation-agnostic but not dialect-agnostic_, and DEC-013's implementation note
already says so. R03 owns whether each branch is correct on both drivers.

### ARC-AC-23 — `Storage` port completeness: **met for the operations used**

`put/get/delete/exists` cover every service call site (`put` 2, `get` 3, `delete` 4 in `services/`);
the storage _inventory_ tool deliberately walks the filesystem itself (`services/storage-inventory.ts:1,47-84` uses `lstat`/`opendir`) rather than going through the port, which is exactly why an S3 adapter would leave it blind — a port-shape consequence worth recording for DEC-010. Filesystem is the only production adapter; S3 is refused at config validation rather than silently falling back, which is the
right failure. The port cannot express conditional creation semantics beyond exclusive-create, which
is where the storage/database ambiguity findings live (ARC-018 family) — a port-shape limitation, not
a completeness gap.

### ARC-AC-24 — `RealtimeHub` can accept another transport: **met, with one asymmetry**

The interface exposes `toOrganisation`, `toUser`, `disconnectDevice`, `registerDevice` and an
_optional_ `subscribe`. Nothing in the port mentions SSE, `EventSource`, headers or sockets, so a
Socket.IO adapter could implement it. The asymmetry is that `subscribe` is optional and the SSE route
turns its absence into a 501 with an error code outside the shared union (ARC-052). A cleaner shape
would be a separate `SubscribableHub` interface, so the route's capability check is a type
distinction rather than a runtime `typeof` test.

### ARC-AC-25 — `OcrProvider` isolates providers: **met at the port, broken at selection**

`ai/pipeline.ts` receives the provider and never chooses one; construction moved to
`createOcrProvider` in the composition root. That part is now correct. The remaining defect is not the
port but the _policy_: selection is process-wide and ignores each organisation's setting (ARC-049).
A per-organisation provider would fit the port unchanged (it takes no organisation today, so the
interface would need one field), which is a good sign the seam is in the right place.

### ARC-AC-34 — shared barrel and the Node-only split: **met on the boundary, unverified in a bundle**

`packages/shared/src/index.ts` re-exports everything except `ids`, and `ids.ts` is the only module
importing `node:crypto`; the doc comment states the intent and the split is real. Desktop and mobile
import `@idcp/shared` and never `@idcp/shared/ids`. What remains unverified is the actual Metro/Hermes
bundle: no native bundle is built in this repository, so "the mobile bundle does not pull
`node:crypto`" is a source-level claim, not an observed one. R11 owns it.

## Verdict summary

| Item      | Result                                                          |
| --------- | --------------------------------------------------------------- |
| ARC-AC-02 | Met, and guarded by test                                        |
| ARC-AC-03 | Met — the earlier hits were a DTO name and a comment            |
| ARC-AC-05 | Met for literals and resolved imports                           |
| ARC-AC-06 | Met for literals and resolved imports                           |
| ARC-AC-09 | Met                                                             |
| ARC-AC-13 | Met — five ports with listed doubles and one DB seam used as-is |
| ARC-AC-15 | Unmet for the universal claim; convention not port              |
| ARC-AC-21 | Not literally; 25 dialect branches on the port                  |
| ARC-AC-23 | Met for operations used                                         |
| ARC-AC-24 | Met; `subscribe` optionality is the wrong shape                 |
| ARC-AC-25 | Met at the port; selection policy is the defect (ARC-049)       |
| ARC-AC-34 | Met at source level; bundle unverified (R11)                    |

No source, port or test was changed. The two items that stay unmet (ARC-AC-15, ARC-AC-21) are unmet
because the _code_ chose a different, defensible design — not because the assessment is incomplete —
and in both cases the honest documentation statement matters more than a refactor.

## Verification run

The two suites that guard the rows above were rerun rather than trusted:

```sh
env -u IDCP_TEST_DB_DRIVER -u DATABASE_URL npm test -- --runInBand --selectProjects backend \
  --runTestsByPath apps/backend/test/composition-boundary.test.ts apps/backend/test/sql-boundary.test.ts
```

Both passed. They cover the service-construction and SQL-placement rules; nothing in the repository
asserts the no-`process.env` rule except `config.test.ts` (run earlier in this review), and nothing
asserts the `newId()` convention or the absence of a clock port — which is precisely why those two
rows remain unmet rather than merely unverified.
