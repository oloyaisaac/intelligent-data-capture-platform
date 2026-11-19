# R01 process-local state — interim inventory

**Incomplete:** not a G1 sign-off, a supported scale-out design, or an exhaustive memory audit.
The observations below describe the current implementation; additional third-party library,
connection, request-buffer, timer, client and operating-system state still requires review.

| State                                                                                                                                                     | Current limit / lifetime                                                                                                                                                                                   | Consequence with more than one backend                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication and pairing `AttemptLimiter` maps (`auth/tokens.ts`, `services/container.ts`)                                                              | Two instances, each capped at 10,000 hashed keys by default; swept on requests, cleared on restart. Counts are capped per key. Capacity exhaustion rejects new keys; object overhead is not byte-measured. | Attempts can be spread across replicas; restarting one resets that replica's counters.                                                                           |
| `InMemoryRealtimeHub` subscribers and device callbacks (`realtime/hub.ts`)                                                                                | Sets/maps have no application-level global count or byte limit. Each SSE stream also owns a 25-second heartbeat timer (`http/routes/realtime-routes.ts`); cleanup on connection close.                     | Events and disconnect callbacks are local to the process; another process's subscribers do not receive them. Existing streams are not continuously reauthorised. |
| Worker running flag, poll timer and active job (`services/worker.ts`)                                                                                     | One scheduled poll timer per worker object; one job at a time per drain loop, but job payloads, OCR buffers and provider resources are not given a complete byte bound here.                               | Every enabled process starts its own loop. Age-only startup recovery can reclaim a live job; effects lack fencing/idempotence.                                   |
| Maintenance running flag and timer (`services/maintenance-service.ts`)                                                                                    | One scheduled timer per maintenance service; individual sweeps can hold result lists and storage operations with no complete byte bound here.                                                              | Each enabled process schedules maintenance independently. Some find-then-enqueue operations are not cross-process atomic.                                        |
| Test `MemoryStorage` (`storage/index.ts`)                                                                                                                 | An unbounded map of buffers, selected by default for `NODE_ENV=test`; production defaults to filesystem.                                                                                                   | Objects are visible only in the process that owns the map. This is not a shared-storage option.                                                                  |
| Connector registry/catalogue and marketplace trust data (`services/container.ts`, `packages/connectors/src/registry.ts`, `marketplace/load-catalogue.ts`) | Per-process object snapshots; no verified aggregate memory limit in this inventory.                                                                                                                        | Configuration changes, loaded catalogues and in-process connector state can differ until each process reloads or restarts.                                       |
| Request-scoped actor cache and multipart/OCR buffers (`http/guards.ts`, `http/app.ts`, `http/routes/document-routes.ts`)                                  | Per request; configured body/file size limits do not by themselves bound aggregate concurrency or OCR/provider memory.                                                                                     | Independent process memory and concurrent requests multiply aggregate resource use; consistent shared state cannot be inferred from these limits.                |
| Database pools/connections (`db/postgres.ts`, `db/sqlite.ts`)                                                                                             | PostgreSQL pool is configured per process; SQLite has a connection and transaction queue per process.                                                                                                      | Pool capacity multiplies with replicas; SQLite connection queues do not coordinate in-process state and do not establish worker safety.                          |

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

## Two-API observation

`apps/backend/test/replica-process.test.ts` launches two actual backend subprocesses with workers and
maintenance disabled, sharing a synthetic SQLite file, filesystem storage and signing key. It
registers via A, signs in via B, uses B's access token on A, uploads on both, and observes each
replica's own SSE event but not the other replica's event in a short observation window. It verifies
that B can read the file uploaded on A from the shared filesystem. It also exhausts a two-attempt
login limit on A and observes that B still accepts another attempt. This is
a focused demonstration of process-local differences, not proof of all replica behaviours, an
exhaustive inventory, a load test, or the required two-worker 20-document exercise.
