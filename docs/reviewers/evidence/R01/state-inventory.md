# R01 process-local state — interim inventory

**Incomplete:** not a G1 sign-off, a supported scale-out design, or an exhaustive memory audit.
The observations below describe the current implementation; additional third-party library,
connection, request-buffer, timer, client and operating-system state still requires review.

| State                                                                                                                                                     | Current limit / lifetime                                                                                                                                                                                   | Consequence with more than one backend                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication and pairing `AttemptLimiter` maps (`auth/tokens.ts`, `services/container.ts`)                                                              | Two instances, each capped at 10,000 hashed keys by default; swept on requests, cleared on restart. Counts are capped per key. Capacity exhaustion rejects new keys; object overhead is not byte-measured. | Attempts can be spread across replicas; restarting one resets that replica's counters.                                                                                         |
| `InMemoryRealtimeHub` subscribers and device callbacks (`realtime/hub.ts`)                                                                                | Sets/maps have no application-level global count or byte limit. Each SSE stream also owns a 25-second heartbeat timer (`http/routes/realtime-routes.ts`); cleanup on connection close.                     | Events and disconnect callbacks are local to the process; another process's subscribers do not receive them. Existing streams are not continuously reauthorised.               |
| Worker running flag, poll timer and active job (`services/worker.ts`)                                                                                     | One scheduled poll timer per worker object; one job at a time per drain loop, but job payloads, OCR buffers and provider resources are not given a complete byte bound here.                               | Every enabled process starts its own loop. Startup no longer requeues claims by age; manual offline recovery and effects remain unsafe without operational controls.           |
| Maintenance running flag and timer (`services/maintenance-service.ts`)                                                                                    | One scheduled timer per maintenance service; individual sweeps can hold result lists and storage operations with no complete byte bound here.                                                              | Each enabled process schedules maintenance independently. Some find-then-enqueue operations are not cross-process atomic.                                                      |
| Test `MemoryStorage` (`storage/index.ts`)                                                                                                                 | An unbounded map of buffers, selected by default for `NODE_ENV=test`; production defaults to filesystem.                                                                                                   | Objects are visible only in the process that owns the map. This is not a shared-storage option.                                                                                |
| Connector registry/catalogue and marketplace trust data (`services/container.ts`, `packages/connectors/src/registry.ts`, `marketplace/load-catalogue.ts`) | Per-process object snapshots; no verified aggregate memory limit in this inventory.                                                                                                                        | Configuration and catalogue snapshots differ per backend; default connector calls run in fresh same-privilege children, while injected registries can retain state in-process. |
| Request-scoped actor cache and multipart/OCR buffers (`http/guards.ts`, `http/app.ts`, `http/routes/document-routes.ts`)                                  | Per request; configured body/file size limits do not by themselves bound aggregate concurrency or OCR/provider memory.                                                                                     | Independent process memory and concurrent requests multiply aggregate resource use; consistent shared state cannot be inferred from these limits.                              |
| Database pools/connections (`db/postgres.ts`, `db/sqlite.ts`)                                                                                             | PostgreSQL pool is configured per process; SQLite has a connection and transaction queue per process.                                                                                                      | Pool capacity multiplies with replicas; SQLite connection queues do not coordinate in-process state and do not establish worker safety.                                        |

## Backend syntax-tree candidate scan

`node docs/reviewers/evidence/R01/state-scan.cjs` scanned the 115 tracked backend source files at
`9ec567c`, producing 25 candidates in `state-scan-9ec567c.txt`. It is a triage aid, not a complete
inventory: it selects module-scope mutable/collection declarations and class fields whose source
mentions certain collections, timers or promises. It cannot enumerate arbitrary scalar fields,
closures, other packages, native resources, dynamically created objects or library/OS state.

- Twelve candidate fields correspond to the already inventoried limiter map, SQLite queue, hub
  subscriber/device maps, maintenance timer/promises, worker timer/promises, and memory-storage map.
- Three module-level candidates (`connector-runner.ts:70-72`) are mutable byte count, end flag and
  input chunks in each one-shot child, not persistent state in the API parent. The child limits the
  accumulated input to 2 MiB before processing; copies, parsed objects, output, native allocations
  and escaped descendants are not covered by that number.
- The remaining ten candidates are module-level data or objects: classification signals, password
  hasher/weak-password list, migrations, logger levels, first-party catalogue, batch-remediation
  parameters, scope-to-role map, batch status set and workflow destructive-action list. Their source
  is per-process; a `const` binding does not prove its contents are frozen. This classification
  does not establish deployment configuration parity, security, byte bounds or completeness.

The scanner is deliberately narrower than P7; for example the connector concurrency scalar and
per-request timers are discussed below rather than detected as class collection fields. R17/R18/R19
must validate the relevant operational limits and replica effects.

## Additional state observations on `9ec567c`

- The two limiter instances are `authLimiter` (auth, pairing completion and privacy routes) and
  `pairingLimiter` (pairing-session creation). The latter is configured using the setting named
  `RATE_LIMIT_UPLOAD_PER_MIN` but keyed by user for pairing, not document uploads. A synthetic
  two-upload probe at a configured limit of one is recorded as ARC-051. Rate-limit state and any
  available capacity remain per-process, not shared or a demonstrated deployment-wide quota.
- `adapters/connector-process.ts:9-101` tracks active child processes per transport instance. The
  default composition limits this instance to eight concurrent children, 2 MiB input/output, and a
  60-second timer (`services/container.ts:158-168`). Input serialization occurs before checking
  the byte count and slot; output buffers, V8 overhead, native memory and escaped descendants are not
  bounded by those numbers. Additional replicas or separately constructed registries have separate
  capacity and fault domains; the child is not a sandbox (ARC-014).
- `maintenance-service.ts:55-83,187-228` keeps the scheduled timer and a set of active run promises.
  Its timer waits for its own `runOnce` before rescheduling, but `runOnce` itself can be called
  concurrently and the set has no explicit count limit; stop waits for the runs visible at shutdown.
  The ordinary source path schedules one service per process; this is not proof of bounded sweep
  results or safe coordination with other replicas.
- Provider selection is a per-process injected object (`services/container.ts:116-136,363-380`),
  not shared or selected by each organisation. A cloud-configured process can send a synthetic
  local-marked organisation image to the cloud adapter stub (ARC-049). A cloud call has an abort
  timer; local Tesseract uses a temporary directory, a child timeout and a 32 MiB stdout buffer
  (`ai/providers/cloud.ts:40`, `tesseract.ts:33-45`). Timers do not establish remote cancellation,
  prevent orphaned temporary files on hard termination or bound aggregate resource use.
- PostgreSQL pool sizing defaults to 10, accepts 1–100 per process (`config.ts:36`), and scales
  aggregate potential connections with process count. SQLite serializes operations on a local
  promise queue with a five-second busy timeout (`db/sqlite.ts:24-48`); neither queue depth nor
  aggregate pending requests is bounded by this inventory. Offlining and CLI processes may add
  connections independently. These are structural observations, not load measurements.

This targeted expansion does not enumerate every library cache, socket, OS object or frontend/native
state. R17/R18/R19 should measure and validate operational limits and replica behavior.

## Odoo connector authentication state

The first-party Odoo connector previously kept an unbounded per-instance UID map keyed by URL,
database and username. It had no expiry or invalidation and omitted the API key from the key. A
synthetic JSON-RPC test reproduced a stale UID after the remote account's ID changed. The connector
now authenticates for each operation and retains the UID only for the duration of that operation;
create/update batches reuse it within the batch and empty batches make no remote call. Tests also
check changed credentials. This adds login traffic and latency, and a UID or credential change
mid-batch can still fail after earlier remote writes; there is no atomic batch or automatic retry.
These are local stub tests, not verification against a deployed Odoo instance, nor a resolution of
connector process isolation or all other process-local state.

## Current-baseline two-worker replay

On source baseline `9ec567c`, the focused `workers-process.test.ts`, `replica-process.test.ts`,
`worker-stale-process.test.ts` and `worker-recovery-audit.test.ts` run passed **4 suites / 4 tests**.
The 20-document test starts two worker-enabled backend subprocesses over one synthetic SQLite file
and shared filesystem, uploads to one API, and observes 20 successful jobs each with one attempt,
one extraction and one `document.uploaded` audit per document. A synthetic OCR executable records
20 invocations from the two worker PIDs. This does not check every audit action or model actual OCR,
provider billing, crashes or external side effects. The separate live-pause test ages a running claim,
starts another worker and checks it does not enter OCR for the running or duplicate queued job. The
recovery audit test uses an injected database failure and an offline-requeue path. These selected
cases do not establish general worker ownership, fencing, recovery safety or exactly-once effects;
P6 remains unmet (ARC-013). No production activity was performed.

## Two-API observation

`apps/backend/test/replica-process.test.ts` launches two actual backend subprocesses with workers and
maintenance disabled, sharing a synthetic SQLite file, filesystem storage and signing key. It
registers via A, signs in via B, uses B's access token on A, uploads on both, and observes each
replica's own SSE event but not the other replica's event in a short observation window. It verifies
that B can read the file uploaded on A from the shared filesystem. It also exhausts a two-attempt
login limit on A and observes that B still accepts another attempt. This is
a focused demonstration of process-local differences, not proof of all replica behaviours, an
exhaustive inventory, a load test, or the required two-worker 20-document exercise.

## Completed inventory pass (2026-11-17)

This section closes the "bounded backend syntax-tree scan and manual inventory remain incomplete" note
in `completion-status.md` for P7 by adding the categories the earlier passes named but did not cover:
client state, library/runtime state and process lifecycle. `timer-scan-9ec567c.txt` is the
reproducible sweep behind the timer and module-scope rows.

### Timers — every scheduled callback in backend `src`

| Site                                      | Kind                                    | Bound / consequence                                                                                                                                                 |
| ----------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/worker.ts:127,131`              | one `setTimeout` poll per worker        | Self-rescheduling; one claim at a time per drain loop. Two processes = two independent pollers; no shared lease (ARC-013).                                          |
| `services/maintenance-service.ts:202,206` | boot delay then interval `setTimeout`   | One per enabled process, waits for its own `runOnce` before rescheduling; `runOnce` can still be called concurrently.                                               |
| `http/routes/realtime-routes.ts:73`       | 25 s heartbeat `setInterval` per stream | Cleared on stream close (`:77`), `unref`ed. No cap on stream count, so heartbeats scale with open connections; the hub's subscriber set has no global bound either. |
| `ai/providers/cloud.ts:40`                | abort timer per cloud OCR call          | 45 s default; aborts the request, does not cancel work already billed or guarantee the provider stops.                                                              |
| `adapters/connector-process.ts:85`        | kill timer per connector child          | 60 s; signals the process group, cannot guarantee descendants exit.                                                                                                 |

No other `setInterval`/`setTimeout` exists in backend source. Every timer is `unref`ed or explicitly
cleared, so none by itself prevents process exit — but `http/app.ts` registers no `onClose`/drain hook
for in-flight requests, which is the lifecycle gap recorded as ARC-058 below.

### Client state (new categories)

| State                                                                        | Lifetime                   | Consequence                                                                                                     |
| ---------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Desktop `MemoryTokenStorage` (`api/client.ts:82-93`)                         | Renderer process           | Deliberately non-persistent fallback when the keychain bridge fails; tokens vanish on reload, by design.        |
| Desktop `BridgeTokenStorage` keychain file (`main/electron-main.ts:197-212`) | OS user profile            | Encrypted via `safeStorage`, mode `0600`; not in this repo's threat model beyond that. Not multi-user.          |
| Desktop renderer `useState` in `App.tsx`                                     | Tab lifetime               | Route, user, notices. A second window is a second independent state; the app does not coordinate windows.       |
| Mobile offline queue (`state/uploadQueue.ts`, `state/queueStorage.ts`)       | Persistent across restarts | Metadata only, file URIs in the keychain-backed store. One queue per device; no cross-device coordination.      |
| Mobile paired-device credential                                              | Platform secure store      | Per device; server-side revocation is the only control (ARC-045 family).                                        |
| Browser `EventSource` in desktop `eventsUrl()`                               | Tab lifetime               | Reconnects independently per window; each opens its own SSE stream, which is one heartbeat timer on the server. |

Client state is included because P7 says "every piece of in-process state", and the earlier inventory
stopped at the backend. None of it changes a server replica consequence; the desktop second-window and
mobile multi-device cases are recording that neither client has a coordination story, which R09/R11
own.

### Library and runtime state (explicitly out of reach)

- `node:sqlite` keeps its own statement cache and page cache per connection; `pg` keeps a pool with
  idle connections and per-client buffers. Neither is observable or bounded through the `Database`
  port, and neither is measured here.
- Fastify keeps per-connection parsers, a request queue and (with multipart) temporary buffers for
  in-flight uploads up to `MAX_BATCH_FILES + 1` files at `MAX_UPLOAD_MB` each
  (`http/app.ts:52-58`). That is a per-request bound, not an aggregate one; concurrent uploads
  multiply it by connection count, which nothing in the app caps.
- Node itself holds the V8 heap, a libuv threadpool (4 by default) shared by filesystem and DNS work,
  and per-socket kernel buffers. Connector children add one isolate each until the 8-slot cap.

**P7 status: inventory complete for application, client, timer and lifecycle state that source can
reveal; library/native/OS state is named and explicitly excluded rather than silently omitted.** That
satisfies the checklist item's own wording ("inventoried ... rather than pending") without claiming a
memory audit. R17/R18/R19 still own measurement and deployment validation; this is a reading of the
source, not a load test, and no replica topology is supported by it.

## Claim-fence observation (ARC-060)

A worker killed mid-extraction leaves a `running` job row, and `claimNext`
(`repositories/system-repo.ts:103-113`) refuses any new `extract_document` job for that document while
the row exists. That is deliberate fencing, and the product's reprocess path refuses with a clear 409
through `hasActiveExtraction`, so a reviewer cannot reach the stuck state from the UI. The residual gap
is discoverability: recovery is job-id-oriented and the document view exposes no claim, so only the
offline CLI (`worker-recovery-cli --list`) reveals which row is blocking. `claim-block-probe-9ec567c.txt`
records the sequence, including that abandoning the orphan lets a fresh job succeed on its first
attempt. Filed as ARC-060 (LOW); P6 remains unmet for the ownership/fencing reasons in ARC-013.
