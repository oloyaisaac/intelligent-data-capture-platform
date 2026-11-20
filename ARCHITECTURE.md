# Architecture

This document describes the repository's current design and separates implemented code from
unverified or proposed deployment capabilities. It is not a production-readiness certification.
See `DECISIONS.md`, `TASKS.md` and the linked operational runbooks for decisions and open work.

## 1. System overview

The intended loop is phone capture → backend extraction → human review → export or connector write.
The repository contains a React Native mobile client, an Electron/React desktop client, a Fastify
backend, and shared and connector packages. Native mobile builds and packaged Electron execution
still need validation with their actual tooling; unit tests do not prove those journeys work.

```text
mobile ──HTTP──┐                              ┌── external connector destinations
              ├── backend API + worker ──────┤
desktop ─HTTP/SSE─┘       │                  └── optional cloud OCR endpoint
                          ├── SQLite or PostgreSQL (metadata, jobs, audit)
                          └── filesystem (originals, exports)
```

The default deployment model is a **single process** containing the API, worker and maintenance
scheduler (DEC-029). PostgreSQL and a single-instance Compose path exist; neither implies a shared
queue, shared realtime broker, shared limiter or horizontally scalable deployment. S3 is not
implemented. TLS termination, persistent storage, secrets and backups are operator responsibilities.

## 2. Components and boundaries

### 2.1 Mobile (`apps/mobile`)

The React Native source includes pairing, camera capture, a local upload queue, review screens and
secure credential storage. Queue metadata is persisted through the keychain-backed store; the queue
holds file URIs rather than the image bytes (`src/state/queueStorage.ts`). The edge-detection bridge
requires native frame-processor/worklet support and degrades without it. Android/iOS scaffolds and
real-device behavior are not yet validated. The API client requires HTTPS except for explicitly
allowed loopback/emulator development URLs (`src/api/client.ts`).

### 2.2 Desktop (`apps/desktop`)

The React renderer implements sign-in, pairing, document review and other screens. Electron's main
process registers `app://idcp`, validates the packaged API origin, enforces a CSP, and exposes token,
version and update-check IPC through a context-isolated preload. Tokens use Electron `safeStorage`
when available. The update-check handler is a stub, not a functional update service. Packaging and
real runtime behavior require separate validation; renderer/browser tests are not packaged tests.

### 2.3 Backend (`apps/backend`)

`src/index.ts` loads configuration, creates the database, composes services, starts Fastify and,
when enabled, starts the worker and maintenance scheduler. Environment access is centralized in
`src/config.ts`; seed and offline encryption-migration settings are loaded separately from API
settings, and the health endpoint receives its version through configuration. The intended dependency
direction is `http/routes` → domain `services` → persistence `repositories` → the `db` port and
drivers. Literal SQL scans now find no statements in services or HTTP modules; a static regression
test checks common literal statements but cannot prove the absence of dynamically assembled SQL.
The health route invokes a database probe. Service repositories are injected by the composition
root, including transaction-scoped repositories used for registration, invitation acceptance,
document upload, pairing completion and privacy erasure. The offline encryption-migration CLI is
its own composition entry point and creates its transaction-scoped repository. A static test guards
against direct repository construction in service modules, but does not establish that every adapter
or dynamically constructed dependency is composed centrally. HTTP guards and event-stream
authentication consult the auth service for the credential's organisation and live membership. The
privacy owner eligibility checks still happen before the erasure transaction and are not protected
from concurrent membership changes. Any further refactoring must preserve transaction boundaries
and tenant scoping.

`services/container.ts` builds the service graph and supplies storage, OCR and realtime adapters;
other entry points and factories also construct concrete implementations. SQLite and PostgreSQL are implemented behind the
`Database` interface. SQLite uses Node's experimental `node:sqlite` and queues all operations on
its shared connection around transaction-scoped callbacks; nested scoped transactions do not create
savepoints. This does not establish cross-process safety. Migrations are handwritten in
`src/db/migrations.ts`, not Prisma. The storage port has filesystem and test-memory implementations;
S3 is not implemented (DEC-010). Authenticated SSE uses `InMemoryRealtimeHub`; it is process-local.
The route uses an optional subscription capability on the realtime port, not the concrete hub
(DEC-016); hubs without that capability return 501 from the SSE endpoint. Event-stream credentials are
checked on connection; an already-open stream is not revalidated when a membership is removed or a
token expires.

The worker claims jobs via a database update that rechecks queued/runnable status when updating the
row, retries failures and marks exhausted jobs dead. Claim exclusivity alone is **not** proof of
exactly-once effects or multi-worker safety. Extraction start and publication check the running
claim attempt; page OCR, extraction and field rows, final document status and job success commit in
one database transaction. Failed extraction status is guarded in its failure transaction. The API
rejects new reprocess requests while another extraction is queued or running. These guards do not
prevent duplicate OCR calls or costs, guarantee delivery of events, or establish safe handling of
pre-existing overlapping jobs. A current-version retention worker locks and rechecks its exact claim
for each destructive document transaction; that does not undo already-started deletion or protect
against older binaries, other writers, or storage/database commit ambiguity. Startup no longer automatically requeues
running claims based on age: a crashed job remains running until an operator reviews and requeues or
abandons it with all workers offline. See `docs/worker-recovery.md`; retries can still repeat external effects,
and old binaries must not be started. Only one worker process is supported. On normal shutdown the
worker waits for its startup check and a currently claimed job to finish before the database closes;
overlapping drain calls on that worker share one loop. This wait has no global
shutdown deadline, and a forced termination can still interrupt work. Normal shutdown also waits
for active maintenance sweeps; neither behavior makes multi-replica scheduling safe.

### 2.4 Shared and connector packages

`packages/shared` contains the UDM, validation, errors, formatting and shared contracts used by the
clients and backend. `packages/connectors` defines the connector contract and first-party adapters.
The default backend registry invokes first-party connector operations, including validation, in
one-shot child processes. The host limits concurrent children to eight, input and output to 2 MiB,
and each invocation to 60 seconds; the child runs with an empty environment and a 128 MiB V8 heap
limit. A timeout or crash may leave an external write partially completed. This is not a sandbox:
children have the same OS privileges and can signal the host or access its filesystem and network;
the heap cap does not bound native memory, subprocesses or CPU. Explicitly injected registries can
still execute in-process. No untrusted third-party connector code should be run under this boundary.
Some connector-run errors are caught and recorded; validation, health, schema, duplicate-preview and
send failures return safe messages, and the supplied connector logger discards connector-provided
text and context. This trades diagnostic detail for reduced disclosure. It does not sanitize existing
records, successful outputs or logging outside the supplied logger, and it is not isolation from
malicious code, resource exhaustion or all possible failures. HTTP connector destination checks and their limits are
documented in `docs/connector-network-security.md`; SQL and filesystem destinations are not protected
by those HTTP controls. Marketplace signature verification does not turn code into a sandbox.

### 2.5 AI

`src/ai/pipeline.ts` invokes an `OcrProvider`, classifies and extracts text using local code,
validates the UDM and records provenance. The configured provider can be local Tesseract or a
cloud endpoint. Real accuracy, cost and provider connectivity depend on separate corpus and
integration validation; the presence of interfaces and synthetic tests does not establish them.

## 3. Key data flows

These are code paths to exercise, not claims of completed device or production validation.

1. **Pairing:** an authenticated desktop requests `/api/v1/pairing/sessions`; its QR payload carries
   an endpoint and short-lived token. The mobile client sends the token and device details to
   `/api/v1/pairing/complete` and receives a device credential. Completion locks the session,
   checks its status and expiry, and commits the device, token claim and audit together. It emits
   a non-durable process-local event after commit; a lost response requires a new pairing session.
2. **Capture and review:** the mobile client queues a capture and uploads with an idempotency key.
   The API stores a file, then commits document, page, upload audit and extraction-job metadata in
   one database transaction. A retry with the same organisation/key returns an existing extraction
   job rather than scheduling another; an older document without a job requires explicit reprocessing.
   Storage is outside the transaction: failures, process crashes or ambiguous commit outcomes can
   leave orphan files and require reconciliation. The worker runs OCR and extraction; the review
   API accepts human corrections and approval. Events are sent to local SSE subscribers.
3. **Export and connector write:** approved records can be exported or sent through configured
   mapping and connector operations. External systems and side effects need their own reconciliation
   and idempotency guarantees; a local job claim is not an exactly-once guarantee. Workflow action
   execution is a separate path: its connector-send and export actions currently record placeholder
   output without dispatching the operation, and its notify action does not deliver a notification.
   A completed workflow run is therefore not evidence that these effects occurred.

## 4. Technology and decisions

| Concern          | Current choice / limit                                             | Decision         |
| ---------------- | ------------------------------------------------------------------ | ---------------- |
| Monorepo         | npm workspaces and TypeScript                                      | DEC-002          |
| Database         | SQLite and PostgreSQL drivers; handwritten migrations              | DEC-003, DEC-013 |
| Realtime         | In-process hub and authenticated SSE                               | DEC-006, DEC-016 |
| Jobs             | Database jobs with one in-process worker; no distributed lease     | DEC-008, DEC-029 |
| File storage     | Filesystem; S3 adapter not implemented                             | DEC-010          |
| AI               | OCR provider port; local Tesseract or configured cloud endpoint    | DEC-007          |
| Client platforms | React Native source and Electron/React source; release builds open | DEC-001, DEC-009 |

## 5. Security boundaries

Public routes include login, registration, recovery, pairing completion and health; this is not an
exhaustive route inventory. Other routes use user, device or API-key authentication and applicable
role/tenant checks; see `apps/backend/src/http/guards.ts` and the individual routes. Do not infer
that every action has the same guard or audit behavior from this overview.

Workers execute inside the backend process; connectors are not sandboxed and do not receive a
separate short-lived internal service credential as an isolation mechanism. New and replaced connector
configuration and credentials are encrypted together and omitted from DTOs, but existing plaintext
configuration requires an offline migration; old files and backups may retain copies (ARC-023).
TLS termination and filesystem or backup encryption at rest must be supplied by deployment
operators; uploaded files are not made
encrypted merely by storing them under `STORAGE_PATH`. See `SECURITY.md` and the key-migration,
connector-network and erasure runbooks for scope and limitations.

## 6. Repository layout and placement

```text
apps/backend/src/{http,services,repositories,db,ai,realtime,storage,workflows,marketplace}
apps/desktop/src/{main,api,components,pages,lib,marketplace,workflows}
apps/mobile/src/{api,assist,auth,capture,pairing,screens,state,ui}
packages/shared/src/         shared contracts and model
packages/connectors/src/     connector contract and implementations
docs/                        runbooks and reviewer briefs
scripts/                     validation, maintenance and build tooling
```

Put a backend HTTP boundary in `http/routes`, business coordination in `services`, persistence in
`repositories`/`db`, and share client-neutral contracts through `packages/shared`. Existing SQL
and construction exceptions are described above; do not assume the ideal layering is fully enforced.
Avoid imports between applications. Platform-specific implementation remains in its own app.

## 7. Single-process constraints and scale-out

- Authentication and pairing rate-limit counters live in `AttemptLimiter` instances per process.
  Entries are capped at 10,000 per instance, expired entries are swept on demand, and new keys are
  refused when full. This bounds that map but permits capacity exhaustion to deny new attempts; an
  edge limiter and monitoring are needed. Counters reset on restart and are not shared across replicas.
- `InMemoryRealtimeHub` stores local subscribers and device callbacks, with no global subscriber
  bound or cross-process event delivery. An event emitted in one process does not reach subscribers
  connected to another. SSE connection cleanup is local; monitoring and connection limits are needed.
- Worker recovery has no lease/heartbeat; an operator who violates the offline requirement may
  requeue or abandon an active job, without stopping its side effects. Maintenance timers also run in each enabled process. Neither duplicate side effects nor shared
  scheduler behavior has been validated for a multi-process deployment.
- Moving to multiple replicas requires a supported PostgreSQL/shared-storage topology, shared rate
  limiting and realtime delivery, a leased/owned worker queue and coordinated maintenance; it also
  requires concurrency, failure-recovery and load tests before the topology is supported.

## 8. Known gaps

Application code and automated tests exist, but significant release work remains: actual mobile
native builds, packaged Electron runtime, real provider delivery/connectivity, monitoring and alerts,
signed distribution, PostgreSQL-coordinated backup/restore, and real-user/OCR-corpus evidence.
SQLite offline backup tooling exists but requires operator-managed quiescence and protected storage.
`TASKS.md` tracks review progress; the historical reviewer briefs describe an older baseline and
should not be treated as evidence that every requirement now passes.
