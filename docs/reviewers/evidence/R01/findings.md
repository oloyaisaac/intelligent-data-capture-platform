# R01 findings — interim register

**Incomplete:** this is not the full R01 review, a G1 decision or reviewer sign-off. Findings
span multiple revisions; later updates identify the relevant revision or current worktree. No named
owner has accepted these findings or provided a dated exception.

| ID      | Severity | Evidence                                                                                                                                              | Finding and impact                                                                                                                                                                                                                                                                                                                                                                                          | Reproduce / next action                                                                                                                                                                                                                                                                                                                                  | Owner                                             |
| ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| ARC-013 | HIGH     | `apps/backend/src/services/worker.ts`, `apps/backend/src/repositories/worker-recovery-repo.ts`                                                        | **Partially remediated:** age-only startup recovery previously reclaimed live jobs. It is removed; interrupted jobs require reviewed offline requeue or abandonment, neither of which proves the old process is dead or prevents external effects.                                                                                                                                                          | The two-backend, 20-document happy path passes locally with synthetic OCR (`workers-process.test.ts`), but `worker-stale-process.test.ts` now verifies startup does not reclaim an artificially aged live claim; offline recovery still requires operator controls. Design owned leases, fencing and idempotent effects; test recovery and side effects. | Unassigned; backend architecture                  |
| ARC-014 | HIGH     | `packages/connectors/src/contract.ts:8`, `apps/backend/src/services/connector-service.ts` (`sendDocument`)                                            | **Partially remediated:** default first-party operations run in one-shot children with bounded IPC and timeouts; same-privilege children can still terminate the host or access its resources. Injected registries may run in-process. P8 remains unmet.                                                                                                                                                    | `connector-process-api.test.ts` verifies survival of an exiting child; `connector-process-security.test.ts` demonstrates a child can signal and kill the host. Design and verify an enforced security boundary before claiming P8.                                                                                                                       | Unassigned; backend architecture                  |
| ARC-015 | MEDIUM   | `apps/backend/src/services/container.ts`, `apps/backend/src/db/encryption-migration-cli.ts`, `apps/backend/src/ai/pipeline.ts`                        | **Partially remediated:** direct service-level repository construction was moved to the service container or offline CLI composition entry; the broader claim that all concrete adapters have a single composition root still needs examination.                                                                                                                                                            | `composition-boundary.test.ts` covers direct and named/namespace-aliased repository constructors in top-level service modules, not dynamic construction or all adapters. Review separate CLI and provider factories; verify transaction behavior.                                                                                                        | Unassigned; backend architecture                  |
| ARC-016 | HIGH     | `apps/backend/src/services/connector-service.ts` (`sendDocument` catch)                                                                               | **Partially remediated:** new send failures no longer store, log or return the connector exception. Existing connector-run records may still contain older raw messages and have not been remediated.                                                                                                                                                                                                       | `connector-throw.test.ts` fails against the old handler and passes with the new handler for secret-bearing Error, AppError and non-Error failures, including create/read/update. Assess existing data and safe remediation before closing.                                                                                                               | Unassigned; backend security                      |
| ARC-017 | HIGH     | `apps/backend/src/services/connector-service.ts` (`create`, `update`, `test`, `describeSchema`, `previewDuplicates`, `context`)                       | **Partially remediated:** validation, health, schema and preview failures use safe messages and the supplied connector logger discards untrusted text/context. Existing records, successful outputs and direct process logging are not sanitized; in-process isolation is absent.                                                                                                                           | `connector-boundary.test.ts` and `connector-throw.test.ts` reproduce and verify secret-bearing failures. Assess existing data, other outputs and direct logging before closing.                                                                                                                                                                          | Unassigned; backend security                      |
| ARC-018 | HIGH     | `apps/backend/src/services/document-service.ts` (`upload`), `apps/backend/test/architecture-flow.test.ts`                                             | **Partially remediated:** an idempotent upload retry previously queued an additional extraction for the existing document. Document metadata and its initial job were not committed together. The new transaction and retry path avoid this for covered sequential and concurrent requests, but file storage is outside the transaction and worker recovery is still unfenced.                              | Replay failed with two OCR calls before the change and passes locally afterward; `documents.test.ts` covers forced contention, enqueue failure, legacy missing job and lost commit acknowledgement. PostgreSQL CI and orphan reconciliation need verification.                                                                                           | Unassigned; backend architecture                  |
| ARC-019 | HIGH     | `apps/backend/src/services/workflow-service.ts` (`evaluate`, `approveRun`, `execute`), `apps/backend/test/workflows.test.ts`                          | **Partially remediated:** connector-send, export and notification formerly reported success without dispatch. New plans fail closed before any action; existing false-success history remains and actual delivery is still unimplemented.                                                                                                                                                                   | `workflows.test.ts` covers each unsupported action in automatic and approval-required mixed plans. Assess historical runs, implement real dispatch and independently verify effects and retry semantics with the R02/product owner.                                                                                                                      | Unassigned; R02 workflow/product owner            |
| ARC-020 | MEDIUM   | `AGENT_STATE.md` (historical snapshot), `DECISIONS.md` DEC-028, `apps/mobile/src/screens/PairingScreen.tsx`, `apps/desktop/src/pages/ExportsPage.tsx` | Handover and localization claims drifted: the old snapshot predates container, backup, SMTP and batch changes, while literal English strings contradict the claim that every visible string uses the catalogue.                                                                                                                                                                                             | Compare source examples and current CI with the historical document. A dated warning and DEC-028 note were added; full cross-document and localization review remains open.                                                                                                                                                                              | Unassigned; documentation and localization owners |
| ARC-021 | HIGH     | `apps/backend/src/services/worker.ts` (`stop`, `drain`), `apps/backend/src/index.ts` (shutdown)                                                       | **Partially remediated:** a normal SIGTERM previously exited and closed the database while an extraction was running; concurrent calls to one worker's drain could also overlap. Shutdown now waits for startup and active work and coalesces drains. Active maintenance sweeps are also awaited. No shutdown deadline or forced-kill safety is established.                                                | `worker-lifecycle.test.ts` and `worker-shutdown-process.test.ts` fail on the prior worker and pass locally with this change; test uses synthetic OCR and SQLite. Design and test bounded shutdown, crashes, ownership and fencing; validate maintenance across replicas.                                                                                 | Unassigned; backend reliability                   |
| ARC-022 | HIGH     | `apps/backend/src/ai/providers/cloud.ts` (`ocr`), `apps/backend/src/config.ts`, `DEPLOYMENT.md` §10                                                   | **Partially remediated:** current-version remote calls are counted and limited per document, but the cloud cost setting is not a hard spend cap. The request is made before a rough token estimate is compared; it only logs a warning, absent usage becomes zero, and there is no cumulative budget or reservation. The prior implementation comment and deployment guide incorrectly claimed enforcement. | `ai.test.ts` demonstrates that an over-threshold response is returned and only warned after the request. Comments and operator guidance now describe the limitation; implement provider-aware pricing and pre-request budget controls, and verify billed usage before claiming enforcement.                                                              | Unassigned; AI/product and operations             |

### ARC-027 — HIGH: workflow execution and recovery require further review

Approval formerly read `awaiting_approval`, deleted a document and only later updated the run and
its audit, without a lock. A deterministic test reproduced two concurrent approvals entering that
path, leaving a deleted document and approval audit but a failed run. Automatically executed plans
were also stored as completed before their actions ran.

Current-version execution now locks the run inside a database transaction, verifies its expected
state and atomically commits the database-local document soft-delete, document audit, outputs,
completion and workflow audit. Business failures roll back before a conditional failure update;
unsupported actions still fail closed. Automatic runs begin in `matched`, not completed. Tests cover
competing approvals, audit failures, multi-action rollback and ambiguous commit acknowledgement;
`workflow-crash-process.test.ts` SIGKILLs a separate SQLite process inside the deletion transaction
and verifies rollback and approval retry. A PostgreSQL lock barrier is included in the driver
integration suite. These tests are synthetic, not evidence of production incidents or successful
deployment.

This is a partial mitigation: a crash can leave an automatic run matched with no recovery protocol;
old binaries can bypass the new lock; historical runs and audit gaps remain; repeated evaluation can
create distinct runs; and soft-delete does not erase files. Future connector, export or notification
actions require an independently designed external-effect and retry protocol and must not be added
inside the database transaction. Keep ARC-027 open for deployment, recovery and independent review.
Owner: unassigned; R02 workflow/product and backend reliability owners.

### ARC-019 update — unavailable workflow actions fail closed

New evaluations and approvals preflight the entire action list. If it contains `notify`,
`send_to_connector`, `create_export` or an unknown action, no action in that run is executed. A
self-approved or non-approval plan is recorded as failed at creation; an approval-required run is
marked failed and its approval endpoint returns 409. This intentionally disables the former fake
outputs, not a real delivery implementation. The tests exercise all three unavailable actions with
both approval policies and a preceding delete, checking no deletion occurs. Existing historically
completed rows and old running binaries remain unchanged. The actual connectors, export and
notification work and their safe retry semantics are not implemented. ARC-019 remains open.

### ARC-026 — HIGH: export creation can strand files or disclose exception details

Before this change, export creation wrote its file before recording the storage key. A partial write
or a failure before `markReady` left a failed export with no key or expiry and no normal cleanup
path; the raw exception was also logged by the export service and HTTP error handler.
`export-cleanup-safety.test.ts` reproduced both defects with synthetic failures. New exports now
reserve their generated key on a queued row before writing. After confirmed exclusive creation,
a caught publication failure can schedule cleanup, preserving an existing expiry if `markReady`
may have committed. An uncertain reservation or unsuccessful write is now left queued for offline
ownership investigation instead of automatically scheduling deletion. The service returns a generic
error without logging exception text. Cleanup still uses the existing reference and retry checks.

This is partial mitigation, not atomic or automatic crash recovery. A killed writer or failed
`markFailed` can leave a queued row with a reserved key and no expiry; maintenance intentionally
cannot infer the writer is dead from age. `export-crash-process.test.ts` kills one SQLite/filesystem
writer after its file write and confirms that state persists and no age-based sweep deletes it. It
is not a PostgreSQL crash or filesystem durability proof. A lost database acknowledgement, storage
operations still in flight after failure, export publication/audit/event races, mixed old binaries,
key reuse, untracked old exports and other application logging remain unresolved. Existing orphaned
files are not identified or removed, and queue monitoring and authorized offline reconciliation
need an owner-approved procedure. A read-only offline inventory can now page through export rows
and inspect stored and canonical candidate key metadata, known references and pending erasure work;
`export-inventory.test.ts` tests SQLite and configured-driver queries, with a PostgreSQL CLI case in
CI. It does not delete or repair files, prove ownership, enumerate objects without rows, stop writers,
or establish production evidence. See `docs/export-inventory.md`. Production-scale cleanup, backup
copies and independent security review remain unverified. Owner: unassigned; backend reliability
and privacy/security.

### ARC-025 — HIGH: worker exception details exposed through persistence, logs and events

Previously `Worker.processJob` copied arbitrary exception messages from OCR, storage, SQL and
other work into `jobs.last_error`, logs and the `document:failed` organisation event. A synthetic
secret-bearing OCR error reproduced this for both ordinary errors and `ProviderUnavailableError` in
`worker-error-boundary.test.ts`. The worker now substitutes fixed per-job-type guidance and suppresses
exception details in tick and shutdown logs. Retry and terminal status behavior is unchanged, but
diagnostics are less specific. The tests cover injected OCR failures and mocked retention, unknown-job,
tick and shutdown failures; they do not prove all logging or other application paths safe.
An operator-directed offline tool can inventory eligible jobs for one organisation and replace one
selected `jobs.last_error` with a fixed marker in an audited transaction; see
`docs/worker-error-remediation.md`. It has not been run in production and cannot clean logs, delivered
events, backups, payloads or other fields. Other services and custom providers may still log sensitive
data directly. Operators and security owners must assess prior exposure, retention and credential
rotation, and independently review the broader boundary before closing this finding. Owner: unassigned;
backend security and operations.

### ARC-024 — HIGH: incomplete retention deletion and unsafe file failure handling

`apps/backend/src/services/document-service.ts` (`purgeExpired`) formerly swallowed primary-file
deletion failures, soft-deleted the row, counted it as purged and let the job succeed. The row then
fell outside `findExpiredForPurge`, so the file had no normal retention retry path. A regression in
`retention-purge-safety.test.ts` failed before the change. The job now fails with a generic message
and leaves that document eligible for retry; known references from other document/page rows also
fail closed. Successful documents are counted separately. This is a **partial mitigation**, not
complete deletion: existing soft-deleted documents are excluded from the scan, distinct page files,
metadata and derived records remain, and file/DB changes are not atomic. A file can disappear while
its row remains active if deletion succeeds but a later DB write fails, and the reference check can
race new or out-of-band writers. Failed retries eventually become dead jobs; operator monitoring,
reconciliation and a durable deletion protocol are needed. Backup, log and external copies remain
out of scope. Owner: unassigned; retention/privacy and backend reliability owners.

Manual and scheduled purge requests formerly could enqueue distinct jobs simultaneously. The
supported enqueue paths now coalesce under an organisation lock; claiming separate existing purge
jobs also rechecks for a running purge under the same lock. The focused tests demonstrate neither
exactly-once effects nor multi-replica maintenance safety. Old binaries, out-of-band jobs, already
running overlaps and operator-directed recovery can bypass the mitigation. See
`worker-recovery-design.md` and keep ARC-013, ARC-021 and ARC-024 open.

### ARC-024 update — atomic user soft-delete and audit

The user-facing document delete now performs a conditional, tenant-scoped soft-delete and its audit
in one database transaction. A forced audit failure previously left the document deleted without
its audit; the rollback regression now preserves the document, and concurrent delete requests yield
one success and one not-found. This improves database consistency only: the endpoint does not remove
file bytes or derived records, and retention still skips already soft-deleted documents. Workflow
deletes and retention file/DB operations have different boundaries. ARC-024 remains open.

### ARC-024 update — transactional retention metadata and audit

A forced retention-audit failure used to leave a soft-deleted row with no purge audit, preventing
normal retry. After removing a primary file, retention now conditionally soft-deletes that document
and records its `retention.purged` audit in the same database transaction. Audit records are now
per document (`target_type=document`, `target_id` set, and `count=1`), not one aggregate per sweep.
`retention-purge-safety.test.ts` exercises audit failure, retry after an already-missing file,
per-document counts and a synthetic lost commit acknowledgement. Retrying relies on the storage
adapter's idempotent delete contract. A failed transaction can still leave bytes absent while metadata
is active; the cross-table reference check and external delete remain unfenced, a concurrent user
soft-delete can skip the retention audit, and historical inconsistencies are not repaired. This is
not a deletion guarantee or a complete retention solution; ARC-024 remains open.

### ARC-024 update — retention candidate, policy and active-job locks

Retention now locks the organisation policy and the selected document before deleting a primary
file, rechecks the policy and document snapshot, and defers candidates with a queued or running
extraction. It holds these locks through storage deletion and the transactionally recorded document
delete and audit. Current-version policy updates and reprocess requests therefore serialize with
the purge. A changed policy or active extraction makes the sweep incomplete, and worker retries are
finite; operators still need to investigate exhausted or permanently running jobs. A user deletion
that wins the lock first is still skipped by retention, so its file is not purged by this path.

SQLite holds a database-wide write lock; PostgreSQL holds organisation and document row locks while
storage is accessed. Slow or stalled storage can block writes, policy changes and shutdown. The
locks do not protect other references or file writes, fence old/out-of-band writers, prove an OCR
process is stopped, or prevent unrelated updates from writing stale policy values later. Storage and
the database are not atomic: a failure or crash after deletion can still leave live metadata without
bytes. Historical soft-deletes, page files, derived data, storage aliases and reference races remain
unresolved, and neither retention nor worker exactly-once guarantees are established.

### ARC-024 update — syntactic storage-path aliases

Filesystem storage normalizes path separators and dot segments, so the same file can have distinct
recorded key strings. Exact-key reference checks alone can miss a live `org//...` or `org/./...`
reference and delete its bytes. Retention, erasure and expired-export reference guards now refuse
non-canonical or invalid deletion targets, and page through syntactic slash/dot alias candidates in
all four known reference tables. If a table reaches 1,024 potential alias candidates the check fails
closed, even if none matched; a blocked sweep needs investigation rather than blind deletion.
Upload rollback and duplicate cleanup now check known references as well and fail closed on lookup
errors; the check does not undo a collision that already overwrote bytes. Tests include cross-tenant
references in each table, guarded cleanup paths, filesystem erasure and paginated/capped scans.
An injected upload audit failure also revealed that the HTTP error handler logged raw unexpected
error messages; it now logs request identifiers without those messages. Other logging and historical
records remain unassessed.

The checks can repeatedly scan whole tables for each candidate file, including while DB locks are
held. Benchmark representative production-sized databases before rollout; the cap bounds returned
candidates, not total database work. Path comparison does not identify links, case-insensitive or
Unicode filesystem aliases, external references or concurrent insertions/writes; it cannot guarantee
safe deletion or reconciliation. No legacy records are rewritten, and ARC-024/ARC-018 remain open.

### ARC-024 update — broader reference checks and stale export metadata

A synthetic cross-tenant regression (`storage-reference-safety.test.ts`) showed that retention and
privacy erasure deleted keys still referenced by exports or template samples, and that expired-export
cleanup deleted keys referenced by other documents, pages, exports or templates. The three paths now
check those known database reference types before deleting. All statuses, including soft-deleted
rows, count as references; only the document being purged and its own pages, or the export being
expired, are excluded. Known aliases therefore block and require investigation, even when both owners
are expired. Tests use deliberately aliased database keys; they are not production incident evidence.

Expired-export cleanup now locks the selected export row and rechecks its key, status and expiry
before removing bytes; queued or unknown states are not expired. The lock is held during storage
deletion and the conditional expired transition, serializing compliant row updates and competing
sweeps. SQLite takes a database-wide write lock; PostgreSQL takes a row lock, so slow or stalled
storage can delay writers and shutdown. A writer must still guard its own transition against an
already expired row; an unconditional update after the lock releases can resurrect invalid metadata.
The reference checks and deletes are not atomic with new references or object writes; reused keys,
old binaries, external files and out-of-band writers can still race. No storage-key non-reuse
constraint exists. Existing files and records are not repaired, separate retention page files remain
untouched, and a database failure after a file deletion can still leave a ready row without bytes
until a successful retry; an ambiguous commit needs inspection. These checks add potentially
unindexed cross-table lookups per file; assess query plans, lock duration and sweep cost on
representative data before production rollout. ARC-024, ARC-026 and P6 remain open; the owner must
design durable, fenced storage lifecycle and recovery semantics.

### ARC-013 update — partial job-row guard

A claim's `attempts` value now guards job success and failure updates, including the failure
read/update race. A stale completion cannot change a queued, newer-running, succeeded or dead job;
a rejected failure does not mark a document failed or emit a failure event. See
`apps/backend/src/repositories/system-repo.ts` (`markSucceeded`, `markFailed`),
`services/worker.ts` (`processJob`), and the regression cases in `worker-recovery.test.ts` and
`worker-lifecycle.test.ts`. This is not a lease or owner token, does not fence other rows or external
side effects, and does not solve crash recovery. At that revision, a deterministic test paused one
extraction, recovered and processed its live claim, then resumed it: two OCR calls and two
extraction records resulted. The test uses one process and synthetic OCR, not a process crash or a
real external provider. P6 and ARC-013 remained open.

### ARC-013 update — transactional extraction publication

The same synthetic test now commits one extraction after both OCR calls. The worker validates the
claim before setting processing state and commits guarded job success, document status, page OCR,
extraction and fields together; dead job and document failure status also commit together. Added
failure-injection rollback/retry, competing recovery, and deletion-during-OCR tests. Reprocess now
returns 409 for an active extraction and locks the document before checking, enqueueing and auditing
in a transaction. It also allows explicit repair of a jobless document in queued or processing state;
concurrent-repair, lock-interleaving, active-job and audit-rollback regressions cover it. A real
SIGKILL subprocess test additionally covers one SQLite crash point during publication and recovery
after artificially aging the claim; it does not establish crash safety generally. Older or manually
inserted overlapping jobs, cross-job review races, duplicate OCR cost, nondurable events, retention
and owner/lease semantics remain unproven. The revised repair locking and subprocess test passed CI on `e115a8e`, including the PostgreSQL
suite; the subprocess crash test itself uses SQLite. P6 remains open.

### ARC-013 update — distinct extraction claims

A regression with two worker instances reproduced concurrent OCR from two different jobs for one
document. Claiming now locks the job and then the existing document, and rechecks for a running
extraction before changing the candidate to running. Focused synthetic SQLite tests cover two
workers, two separate processes, and unrelated job progress; a PostgreSQL barrier test is included
for CI. This is a partial concurrency guard, not a lease or a database constraint: existing running
duplicates, missing documents, old binaries, out-of-band writers and manual requeue of live jobs are
not fenced. External OCR may still repeat on retries. At that revision, review decisions were
nontransactional relative to reprocessing and could act on stale extractions. A synthetic
`review-reprocess-risk.test.ts` characterization showed that rejecting an old review during new OCR
changed the document to failed while the job reported success without publishing its result. See the
following update for the partial mitigation; P6 remains open.

### ARC-013 update — review/reprocess transaction boundary

The old characterization was replaced with a regression that expects a 409 for the stale rejection
and publication of the new OCR result. Review open, correction, approval, rejection and bulk items
now use the document lock and transaction-scoped repositories; reprocessing preserves but
supersedes open reviews. Tests cover failed reprocessing, simultaneous decisions and rollback. A
PostgreSQL lock-wait test is included for CI. Approved-snapshot reads now require the current
approved document and latest extraction, with no active extraction job; tests exercise stale
connector preview and direct snapshot lookup. These are point-in-time guards only: external
sends/exports can race with subsequent reprocessing. Old binaries, event delivery, broader
crash/erasure cases and independent review remain open. `worker-recovery-design.md` describes the
supported semantics and limitations.

### ARC-017 update — connector write success values

Create, update and merge results are now reduced to validated nonnegative safe-integer counts and a
locally generated summary; connector-supplied summary text and extra properties are not persisted or
returned. Invalid results fail with the existing warning to check the destination, which may already
have changed. `connector-success-boundary.test.ts` exercises create and update, invalid counts, run
records and the supplied logger with a synthetic secret. This does not prevent intentional numeric
covert channels or direct in-process access, sanitize successful schema/duplicate-preview data,
clean historical rows, or establish process isolation. ARC-017 and P8 remain open.

### ARC-023 — HIGH: plaintext secrets in connector configuration

`ConnectorService.create` validates only `config` and stores it as plaintext; `toConnectorDto`
returns that config. HubSpot's validation requires a `token` in config even when a token is supplied
in the separately encrypted `credentials` field. `connector-config-risk.test.ts` characterizes the
issue with a synthetic token, demonstrating a 400 for credentials-only creation, followed by token
exposure in the stored row, creation response and connector list. This test records a defect and
must be replaced with a security regression when fixed, not treated as an acceptable contract.
Other connectors accept secrets in config (including SQL connection strings), and arbitrary config
cannot reliably be sanitized by matching a few key names. Existing rows, historical responses,
logs and backups may already contain secrets. Owners should assess access and rotation.

A fix requires an explicit connector-specific public/secret configuration contract, validation of
the merged effective config, secure create and patch semantics, an atomic migration and rollback
plan for existing rows, consistent precedence, and tests for old and new records and all connector
types. Merely changing documentation, hiding some DTO keys or encrypting the separate credentials
field does not resolve this exposure. Owner: unassigned; backend security and connector owners.

### ARC-023 update — encryption of new settings and offline migration

New connector creates and configuration replacements now encrypt the complete config and credentials
together, and DTOs return an empty config even for legacy rows. Validation uses the merged effective
settings, with credentials retaining precedence; replacing config preserves existing credentials.
An offline, single-transaction migration can check and migrate existing rows with a stopped-writer
acknowledgement, preserving both objects. `connector-config-risk.test.ts` covers arbitrary nested
secret values, credentials-only HubSpot validation, legacy DTO redaction and replacement;
`connector-config-migration.test.ts` covers synthetic SQLite check/apply, rollback, key rotation and
CLI gating. This changes the response contents and storage format; old binaries cannot safely run
against migrated rows. `docs/connector-config-migration.md` details downtime, backups and rollback.

This is partial remediation, not a blanket guarantee. Existing databases are still plaintext until
operators execute and verify migration; old database pages, WAL, replicas, backups, logs, historical
errors and other connector outputs may retain secrets. Key-rotation and migration tests are synthetic,
not a production rollout. Explicitly injected in-process connectors and same-privilege child processes are still not security-isolated. Independent security
review, production migration evidence and incident/rotation assessment remain open. P8 is unmet.

### ARC-013 update — offline abandonment without automatic retry

The offline recovery CLI now offers explicit abandonment for a reviewed running attempt of a known
job type. Its conditional transition to `dead`, conservative document status change and system audit
commit together; an unrelated, already-final or ambiguous document is not modified. The unused
unaudited repository requeue helper was removed. Tests cover invalid confirmations, tenant mismatch,
competing requeue/abandonment, audit rollback, a killed SQLite transaction, lost acknowledgement and
an intentionally unsafe resumed extraction. PostgreSQL lock and CLI tests are included. A resumed
current-version extraction cannot publish after its claim is abandoned, but OCR may already have
occurred. A current-version retention worker now locks and rechecks its exact running claim before
each document's destructive transaction, serializing that operation with abandonment and requeue;
already-started deletion completes first and old binaries and out-of-band writers are not fenced.
SQLite and PostgreSQL contention tests cover this boundary; it holds a database lock through storage
I/O and does not fix database/storage atomicity. Local full verification passed 93 suites / 779 tests
with 20 PostgreSQL-only tests skipped; a temporary PostgreSQL 16.16 instance passed the full backend
project (86 suites / 535 tests). An additional SQLite claim-identity regression passed separately. Operator assertions do not prove any process stopped,
the audit references are not authenticated identities, and no external effects are reconciled. This
is not automatic recovery or a replacement for a lease and fencing design.

### ARC-013 update — live recovery across two processes

`worker-stale-process.test.ts` pauses synthetic OCR in one actual SQLite worker subprocess, ages its
running job timestamp in the database, then starts a second actual worker. Previously the second
startup reclaimed the live job; the old test observed two OCR calls, two attempts and one durable
extraction. Startup no longer
requeues by age; the revised safety test observes one call and one attempt in this scenario. It uses
an artificially aged timestamp and fake OCR with SQLite, not real provider or PostgreSQL recovery.
Offline operator requeue remains potentially unsafe and automatic owned recovery is not implemented;
P6 remains unmet.

### ARC-016 / ARC-017 update — historical error and schema output boundaries

Connector list/update DTOs and run history now substitute locally generated guidance for any stored
error text, including historical raw errors. `connector-legacy-errors.test.ts` reproduces the old
response leak with synthetic data; it also verifies historical values remain in the database. The
schema endpoint now validates the declared field types and strips extra schema/field properties;
`connector-boundary.test.ts` covers secret-bearing extra properties and a malformed type. This is
not data-at-rest cleanup or an isolation boundary: historical rows, prior responses, logs, backups,
destination-supplied schema strings, duplicate-preview values and direct in-process access remain
potential exposure paths. An operator-directed offline tool can now page existing connector IDs and
replace selected health/run error fields with fixed messages, with bounded, transactional audit; see
`docs/connector-error-remediation.md`. It does not process orphaned or mismatched runs, summaries,
logs, backups or other copies, and no production execution is claimed. Independent security review
and P8 remain open.

### ARC-014 update — best-effort descendant cleanup on POSIX

The transport now starts POSIX connector children in separate process groups and attempts to kill
that group on failure or timeout while its leader is still running. A regression with one synthetic
same-group descendant observed a delayed write before the change and no write after timeout with the
change. On Windows only the immediate process is signalled. This is not a sandbox or complete process
containment: descendants can escape the group, the leader may exit first, signals can fail, and a
remote operation may already have happened. The same-UID host-kill reproduction still applies. P8
remains unmet, with the enforced boundary and independent security review still required.

### ARC-014 update — fatal connector process reproduction

`connector-fatal-process.test.ts` launches a disposable backend API process with an injected test
connector. When the real connector health-check route invokes it, the connector calls `process.exit`
and the API process exits with the fixture's code before sending a response. This is an explicit
reproduction of P8 failure for explicitly injected in-process registries. The default first-party
registry now uses a child per operation, and `connector-process-api.test.ts` shows survival when a
synthetic child exits. But `connector-process-security.test.ts` demonstrates that a same-privilege
child can signal and terminate its host. P8 remains unmet: an enforced security boundary and review
of privileges, resource limits, network access and external effects are still required.

### ARC-015 update — OCR provider composition

Concrete cloud and Tesseract provider selection moved from the extraction pipeline into
`services/container.ts`. `provider-composition.test.ts` checks selection, injection of a fake
provider and absence of direct concrete-provider imports in the pipeline; focused AI tests also
pass. This is one adapter seam, not proof that every adapter is composed in a single root. Database
and HTTP factories and offline migration entry points remain separate, and broader P5 review is
still required. No real cloud request or OCR engine was tested by this change.

The SMTP transport factory also moved from the service layer to `adapters/smtp-mailer.ts`, leaving
`services/mailer.ts` as the interface and composing the adapter from the service container. Focused
SMTP/auth tests passed using a local fixture, and a static service-layer check rejects direct
`nodemailer` imports. This does not prohibit dynamic imports, make SMTP acceptance a delivery
receipt, prove a production mail server, or establish the rest of P5.

### ARC-023 update — offline-only source key rollout hazard

A synthetic SQLite CLI regression exposed a migration-check gap: a new-format connector envelope
could be readable only with `ENCRYPTION_MIGRATION_SOURCE_KEY`, not the runtime's target or JWT
fallback, yet `--check` returned exit 0. The check now counts source-key ciphertexts and exits 2;
apply re-encrypts both legacy configurations and new-format source-key envelopes, verifies all
values with the target key alone in the transaction, and a later check requires both counts to be
zero. `connector-config-migration.test.ts` reproduces the prior false clean result and tests the
corrected CLI. This is synthetic and does not migrate MFA or prove a production rollout. Historical
backups still require their original keys. ARC-023 and independent security review remain open.

### ARC-028 — batch exception text persisted and exposed (HIGH, partially remediated)

Batch creation previously copied arbitrary storage, database and adapter exception messages into
`batch_items.error`, application logs, batch JSON and CSV. A connector registry lookup also copied
arbitrary adapter exception text into an HTTP validation error. Those paths can disclose credentials,
filesystem paths or document content. The batch service now persists and logs only fixed
application-owned messages, and masks historical free-text errors on all batch JSON and CSV reads;
legacy database values are not automatically rewritten. Known validation classes retain fixed messages.
Registry lookup failures now return a fixed message. Synthetic HTTP tests cover ordinary and
application errors, non-Error throws, legacy database values, CSV/list/detail/items, tenant scope
and subsequent successful items. This is output masking, not deletion of old rows, exports, logs,
backups, screenshots or other copies. Authorized assessment and remediation of historical exposure
remain open, as does a broader audit of other error/output boundaries. Owner: unassigned; backend
security and data governance.

A new offline tool can page through batches with non-allowlisted stored errors in one organisation,
count them per batch and, only after explicit operator review, replace up to 100 per transaction with
a fixed message and append an audit entry. SQLite and PostgreSQL tests cover scope, safe-message
preservation, bounded repeatable pages, concurrent calls, audit rollback and CLI redaction. See
`docs/batch-error-remediation.md` for authorization, legal holds, offline controls, backup and
verification. This tool has not been run on production. It does not enumerate all organisations or
databases, assess past exposure or clean database WAL, exports, logs and backups; these and
independent security review remain open.

### ARC-025 update — additional runtime and provider error boundaries

Current-version cloud OCR transport/parsing and local OCR child failures now return fixed error
messages; the cloud provider only rethrows its own status errors. Unhandled process rejections,
realtime subscriber failures and batch temporary-file cleanup failures no longer log exception text.
API startup, migration and seed fatal errors now log generic diagnostics rather than potentially
sensitive database/configuration exceptions; this sacrifices detailed startup diagnostics, so
operators must inspect configuration and dependencies without copying secrets. Tests exercise real
subprocesses, injected failures and a synthetic OCR executable. Historical log copies and other
logging paths are not remediated or comprehensively assessed; ARC-025 and security review remain open.

### ARC-022 update — durable remote OCR invocation limit, not a spending cap

Migration `013_remote_ocr_invocation_count` adds a nonnegative per-document counter. Current-version
workers lock the exact running claim and transactionally reserve an invocation before calling any
provider that declares itself nonlocal; `AI_MAX_REMOTE_CALLS_PER_DOC` defaults to five and accepts
zero to stop new reservations. Reservations persist across retries and reprocesses and are not
refunded after failures, crash or ambiguous commit acknowledgement. Cloud OCR no longer follows
redirects, avoiding an automatic redirected replay of image bytes. Synthetic tests cover contention,
stale claims, provider failures, local mode, lost acknowledgement, SQLite SIGKILL, migration and
real HTTP redirects. PostgreSQL contention uses a real row-lock barrier. Local full verification
passed 102 suites / 814 tests with 21 PostgreSQL-only tests skipped; a temporary PostgreSQL 16.16
instance passed the full backend project (95 suites / 571 tests). An exhausted job eventually fails
through ordinary finite retries; this is an availability change and no alert or UI reason has been
added.

This is **not a hard cost cap or an exactly-once guarantee**. An individual call can cost an unknown
amount; an injected provider may lie about locality or make multiple external requests, new uploads
get new counters, and old binaries or direct adapter calls do not reserve. Migration initializes
existing rows to zero because prior calls cannot be reconstructed; restored databases can roll back
counts. Mixed versions and differing configuration across workers undermine the limit; zero does not
stop an already-started request. Provider-side spending limits, pricing, actual bill reconciliation,
organisation-wide budgeting and independent assessment remain open. No real provider call or
production migration is claimed.

### ARC-018 / ARC-026 update — exclusive writes and uncertain ownership

The filesystem adapter now uses exclusive final-path creation and memory storage rejects an existing
key instead of overwriting it. Filesystem tests cover competing calls, independent processes,
slash/dot aliases, hard links and final symlinks; synthetic upload and export HTTP tests verify a
collision does not overwrite existing bytes. When an export key reservation is uncertain or a file
write rejects, the service leaves the row untouched for offline review rather than scheduling an
object of unknown ownership for expiry. Tests cover a partial write, an ordinary ambiguous storage
failure, an existing unreferenced object, and a lost reservation acknowledgement. Confirmed-write
publication failures continue to follow the existing failed/expiry path. Local verification passed
105 suites / 822 tests with 21 PostgreSQL-only tests skipped; the full backend suite also passed on a
temporary PostgreSQL 16.16 instance (98 suites / 579 tests).

This reduces overwrite and unsafe-cleanup risks but does not complete ARC-018, ARC-024 or ARC-026.
Exclusive create depends on the filesystem implementing `O_EXCL`; it is not a sandbox or a guarantee
against parent-directory symlinks, untrusted filesystems, hard-link changes, old binaries or later
key reuse. An upload write failure may leave an untracked partial file. Queued export rows can remain
indefinitely, including without a key when a reservation fails. There is no automatic ownership
proof, live-worker fencing, atomic file/database transaction, historical-orphan reconciliation or
production rollout evidence. Investigate stuck rows offline; never delete based on age alone.

### ARC-022 update — per-organisation lifetime invocation reservation

Migration 014 adds a durable, nonnegative organisation reservation counter that survives deletion of
individual documents. On the current-version worker path, the running job is locked and both the
organisation and document reservations commit together before the remote provider is called. A failed
reservation rolls back both counters. `AI_MAX_REMOTE_CALLS_PER_ORG` defaults to 10,000 lifetime
reservations since migration, accepts 0–10,000,000 and has no periodic reset. It is a shared
configuration limit applied separately to each organisation, not an organisation-specific setting.
Synthetic tests cover caps across documents and organisations, zero, local OCR, rollback, concurrent
reservations and a SQLite SIGKILL. Real PostgreSQL lock-barrier tests cover contention on both a new
and an existing counter row. A lost-acknowledgement test verifies both committed counters persist.
An organisation-cap rejection has a fixed job failure reason and terminal realtime message without
exposing provider exception text; UI presentation and operational alerting are not verified. Full
local verification passed 109 suites / 835 tests (24 PostgreSQL-only tests skipped); the full backend
suite passed on temporary PostgreSQL 16.16 (102 suites / 595 tests).

This creates an availability change and does **not** close ARC-022 or establish a monetary cap. No
historical usage is backfilled; a missing row means only that this mechanism has not recorded a call.
Limits cannot cancel in-flight calls, prevent provider-internal retries, bound per-call cost, control
multiple organisations or databases, enforce consistent settings, or stop old/direct/out-of-band
writers. An organisation deletion cascades its counter, and backup restore can roll it back. Jobs at
the cap exhaust normal retries; there is no dedicated alert or verified UI presentation. Owners must review the
threshold and capacity, deploy current code and configuration consistently, independently monitor
usage, enforce provider-side budgets, and verify real billing and production rollout. See
`DEPLOYMENT.md`. No production action or independent assessment is claimed.

### ARC-018 / ARC-024 / ARC-026 update — scoped filesystem inventory

A new read-only offline filesystem inventory enumerates a selected organisation's current-layout
`documents`, `exports` or `pages` directory, including files without an export or document row.
It pages supported names, reports unsupported names and nonregular entries, observes hard-link
counts, and checks known references across tenants and possible syntactic pending-erasure aliases. A complementary
reference mode pages through non-null document, page, export and template keys and observes whether
files are present, missing or unverifiable, including soft-deleted documents. It does not read file
contents and deliberately requires confirmation before outputting sensitive raw storage keys. Tests
exercise pagination, unreferenced synthetic files, missing references, cross-tenant syntactic aliases,
erasure queue entries, hard links, symlinks, invalid paths, scan bounds and the SQLite and PostgreSQL CLI.
Local full verification passed 111 suites / 840 tests with 25 PostgreSQL-only tests skipped; the
full backend suite passed against temporary PostgreSQL 16.16 (104 suites / 601 tests).

This is an investigation aid, **not** reconciliation, deletion authority or proof of ownership or
absence of references. It only covers a chosen directory and supported names; does not descend into
subdirectories or identify all alias forms, external copies or old layouts; and cannot enforce
writer shutdown, root/mount identity or a consistent filesystem/database snapshot. Directory scans
and per-file reference queries can be expensive. Operators must follow the protected, authorized
offline procedure in `docs/storage-inventory.md`, evaluate legal holds and backups, and separately
review any action. No production inventory or cleanup was performed. These findings remain open.

### ARC-029 — HIGH: PostgreSQL connector transaction and schema boundaries

The PostgreSQL destination connector previously sent `BEGIN`, individual statements and `COMMIT`
or `ROLLBACK` through `Pool.query`. The pool API does not hold one client across those calls, so a
connection change or loss can invalidate the intended transaction boundary; partial or uncertain
historical writes are possible, but no production occurrence has been established here. Schema
description also queried every information-schema table with the same unqualified name, potentially
mixing metadata from different schemas. Current code checks out one client for each operation and
restricts schema description to the relation resolved through the connection's search path. Mocked
transport tests verify transaction statements use the checked-out client; a temporary PostgreSQL
integration test covers successful and failed multi-record writes, duplicate schema names and the
first-party subprocess path. This is partial mitigation, not evidence about prior deployments.

The owner must assess historical destination operations and mappings, retry/ambiguous-commit
handling, rolling deployments and remaining remote-effect risks. Schema inspection and write are
separate operations and can race. This work does not isolate connector code, constrain database
network access, prove transactional behavior of MySQL storage engines, guarantee exactly-once remote
writes or independently validate production destinations. See `docs/postgres-connector-operations.md`.
Owner: unassigned; backend integration and security. R01 and P8 remain open.

### ARC-029 update — MySQL database selection

The optional MySQL `database` setting previously controlled schema discovery but not data operations,
which used the connection's default database. If those databases contained same-named tables,
descriptions and writes/reads could refer to different destinations. Current create, update and
read statements use the validated, quoted configured database, or retain default-database behavior
when it is absent. Mocked tests cover both paths and rollback on a single connection. A real MySQL 8
CI service test is configured to create two disposable schemas, check both destinations and exercise
InnoDB success and rollback; CI results for this change have not yet been observed.

The fix changes future destination selection. An authorized owner must review existing configurations,
previous and current destination data, mappings, permissions, mixed-version rollout and any necessary
repair. No production data was inspected or repaired. Engine-dependent rollback, commit uncertainty,
external effects and connector isolation remain unresolved. See `docs/mysql-connector-operations.md`.

### ARC-030 — HIGH: QuickBooks query construction and historical assessment

QuickBooks search previously interpolated filter keys directly into SQL-like query text without
identifier validation; the entity name was checked only when the caller explicitly invoked
`validateConfig`. Backslash-containing values were also not rejected before apostrophe escaping,
leaving ambiguous escape sequences. The connector now validates the entity at each operation,
restricts filter keys to simple or dot-separated identifiers, rejects backslash/control characters
in filter strings and non-finite numbers, and sends bounded query limits. Schema sampling requests
one row. Adversarial fake-HTTP tests check constructed requests and rejection before fetch; they do
not establish actual vendor behavior or that production exploitation occurred. This changes accepted
inputs and defaults; review compatibility and historical mappings/queries and assess any destination
effects before rollout. A limited, unpaginated search cannot prove that no matching record exists;
ambiguous failures and remote side effects remain. No production review or real-vendor integration
was performed. See `docs/quickbooks-query-safety.md`. Local `npm run verify` passed 120 suites / 893
tests (30 skipped), and the backend PostgreSQL 16.16 suite passed 109 suites / 620 tests. These do
not substitute for real-vendor or production evidence. Owner: unassigned; integration and security.

### ARC-031 — HIGH: CRM HTTP response body deadline and memory boundary

The shared HubSpot/QuickBooks transport previously cleared its abort timer after response
headers and then read the whole body with `response.text()`. A stalled body could therefore outlive
the configured request timeout and an oversized body could accumulate without a transport-level
bound. Current code enforces a deadline covering headers and body, rejects response bodies larger
than 2 MiB, attempts to abort and cancel on failure, and validates configured timeouts. Synthetic
stream tests and a local real HTTP server exercise oversized and stalled bodies; no external vendor
has been tested. This changes compatibility for large or slow legitimate responses and invalid
historical timeout configurations. A write failure does not establish rollback at the remote vendor.

This does not cap all allocations, JSON parsing, decompression, repeated requests or remote effects,
and initially did not address Odoo, Google Sheets, SQL or file connectors, malicious code, or OS-level isolation.
Uncooperative injected transports and destination servers need not stop on abort. Assess provider
payloads and configuration, rolling deployments, logging and historical effects with authorized
owners. Local full verification and PostgreSQL results are recorded under ARC-030 above. See
`docs/crm-http-response-limits.md`. Owner: unassigned; integration and security.

### ARC-032 — HIGH: CSV destination errors and destructive writes

The CSV connector treated all read failures as an empty destination, so a duplicate preview could
report no rows on I/O failure and a later write could attempt to overwrite existing content. It
only checked the first incoming record's columns and could silently discard later fields. Current
code treats only an observed absent path as empty, rejects observed nonregular files, propagates
other read errors, checks columns across the batch and leaves empty batches untouched. These are
partial safeguards, not safe transactional file writes. Current code also rejects observed hardlinks,
malformed/ambiguous CSV and invalid UTF-8, creates missing destinations exclusively, and appends to
existing files without rewriting their bytes. A metadata recheck rejects some changed snapshots.
Tests cover byte preservation, malformed files, stale snapshots and a real connector child. Existing
empty files and previously tolerated malformed files now require review. Historical formula cells
remain intact, not sanitized. Concurrent and partial appends, lost acknowledgements, wrong mounts,
path races, later hardlinks and old or external writers can still corrupt data or cause duplicate
writes. A separately designed durable and coordinated protocol, historical destination review and
authorized recovery remain. An earlier local `npm run verify` passed 123 suites / 901 tests (30
skipped), and the backend PostgreSQL 16.16 suite passed 110 suites / 624 tests; those earlier results
predate this update. In pre-commit local testing, `npm run verify -- --runInBand` passed
125 suites / 953 tests (31 skipped); the PostgreSQL 16.16-configured backend suite passed
111 suites / 643 tests. These results do not establish production filesystem behavior or an
independent review. See `docs/connector-write-safety.md`. Owner: unassigned; integration and storage.

### ARC-033 — HIGH: duplicate policy and destination update identity

Non-append policies previously fell through to create when keys or a readable connector were absent;
missing key values could also produce incomplete/unfiltered lookups. CRM update methods address a
record by ID but the service could supply a business duplicate key as that ID. The current backend
fails closed on invalid keys, unavailable lookup and missing mapped values, and rejects ambiguous or
non-exact returned update matches. CRM update/merge requires the vendor ID first, and Odoo requires
a positive integer. HubSpot's top-level ID now wins over a property of the same name. These changes
may block existing mappings; synthetic tests do not demonstrate real-provider compatibility.

Searches remain bounded, provider-dependent and separate from the subsequent write. False negatives,
multiple destination rows, collations, stale results, races, old binaries and direct SDK calls remain;
there is no exactly-once or target-identity proof. Authorized owners must assess historical writes,
mappings and actual destination effects. No production inspection or remediation occurred. Local
full verification and PostgreSQL results are recorded under ARC-032 above. See
`docs/connector-write-safety.md`. Owner: unassigned; integration and security.

### ARC-031 update — Odoo and Google Sheets HTTP bodies

Odoo and Google Sheets now use the same bounded response transport as HubSpot/QuickBooks, including
streaming body size checks and deadlines for individual requests. Stalled and oversized synthetic
responses are tested at authentication, read and write stages; the shared transport also has a real
local stalled HTTP server test. No real vendor call was performed. These limits are availability and
compatibility changes and do not bound all allocations or total operation time, stop hostile code,
prevent remote side effects, or cover SQL/filesystem connectors. See `docs/crm-http-response-limits.md`.

### ARC-034 — HIGH: Sheets header handling and Odoo response integrity

Sheets create previously treated any header lookup failure as an empty sheet and could write a new
header over existing data. Appends used `USER_ENTERED`, potentially interpreting document values as
formulas. The connector now fails closed on failed/malformed header reads, validates the entire batch
before initializing headers and sends values with `RAW`. Odoo no longer treats null/malformed search
results as empty, validates record IDs, and requires an explicit successful write response. These
changes can reject existing inputs and change how strings are interpreted; synthetic tests do not
establish real-vendor compatibility. The Sheets header read and initialization still race concurrent
writers; both providers can commit remote effects despite failure or lost acknowledgement, and
multi-record Odoo writes can partially succeed. Historical data, prior formulas and results have not
been reviewed or repaired. Local `npm run verify` passed 124 suites / 914 tests (30 skipped), and
the backend suite on temporary PostgreSQL 16.16 passed 110 suites / 624 tests. See
`docs/sheets-odoo-connector-safety.md`. Owner: unassigned; integration and security.

### ARC-035 — HIGH: formula-like CSV headers and batch filenames

A user-supplied CSV export column was emitted as an unprotected header, and batch-results CSV only
quoted user-supplied filenames rather than applying formula mitigation. A regression test reproduced
both formula-like header and whitespace-prefix gaps in the shared writer; an API regression showed
unprotected selected column names. New code prefixes formula-like header and text values, including
a formula marker after whitespace and leading tab/CR/LF, and applies it to batch and dashboard CSV.
Distinct headers that collapse after prefixing are rejected, while the CSV connector rejects
formula-like headers rather than changing destination field identities. A synthetic ExcelJS test
checks that a formula-looking XLSX column header is a string cell. Tests demonstrate these specific
paths; they do not establish behavior in real spreadsheet applications.

This is a compatibility change and partial mitigation. Apostrophe handling varies by spreadsheet,
import configuration and save/reopen behavior. Old exports, batch results, destination files,
copies and other output paths have not been inspected or remediated. The connector preserves
existing row content, including formula-like values. Review historical exposure, all export paths,
supported spreadsheet workflows and possible remediation with an authorized owner and independent
security reviewer. No production investigation is claimed. Local full verification passed 125
suites / 970 tests with 31 skipped, and a PostgreSQL 16.16-configured backend run passed 111 suites /
649 tests (including SQLite-specific fixtures). The PostgreSQL run preceded a lint-only test edit.
See `docs/csv-formula-safety.md`. Owner: unassigned; product and security.

### ARC-036 — HIGH: export projection collisions can silently corrupt data

The XLSX writer used header strings as ExcelJS column keys and as properties of a row object. A
projection repeating a field name or colliding with the fixed `document_id` / `document_type`
headers could silently replace or omit values. An API regression demonstrated that a selected
`document_id` field caused the actual document ID to be absent from the XLSX row. In both export
formats, selecting an absent prototype-named field such as `constructor` could produce the literal
text `undefined` rather than an empty cell, because the field lookup included inherited properties.

Current code writes XLSX rows by position without using untrusted headers as keys and only reads own
UDM fields. API tests compare CSV and XLSX position-by-position for repeated and metadata-colliding
projections, check absent prototype names, and inject a synthetic approved snapshot to check that
actual own fields with those names still export. An ExcelJS round-trip also checks a formula-looking
approved XLSX value is a string cell. These are synthetic tests; they do not establish how every
spreadsheet or downstream importer interprets the file.

Repeated headers are still allowed for compatibility, and name-keyed consumers can still conflate
them; consumers must use positions. Existing exports, delivered copies, old binaries and downstream
imports are unchanged. An authorized product/data owner must assess historical projections and
potential impacts, decide whether ambiguous headers should be rejected or renamed, and review
regeneration and downstream corrections. No production investigation or remediation is claimed.
This remains open pending that assessment and independent review. Local `npm run verify -- --runInBand`
passed 125 suites / 973 tests with 31 skipped. The PostgreSQL 16.16-configured backend run passed
111 suites / 652 tests, including SQLite-specific fixtures. Formatting, diff checks and the backend
build passed. Owner: unassigned; product and data integrity.

### ARC-037 — HIGH: required mappings could send empty transformed values

The mapper previously checked whether the source was empty before transforming it, but did not
recheck the result. A required number, date or boolean transform could therefore yield null, or a
trim transform an empty string, while `missingRequired` stayed empty. An API regression reproduced
an approved invoice being sent with a null required boolean. Current mapping checks transformed
required values and rechecks required destinations after all assignments; duplicate preview now
applies the same required check as send. Own-property checks stop an inherited source or destination
from satisfying the required check. Zero and false remain valid; defaults are applied before the
transform, not after an invalid transformation. Tests cover these cases and verify that the fixture
connector is not contacted. A previously accepted configuration can now fail, and the check precedes
connector-run creation.

This is partial mitigation. At that revision, duplicate destinations could overwrite a non-empty
value and optional destination names such as `__proto__` could be lost; subsequent safeguards and
remaining limitations are recorded under ARC-038 below. Other name-sensitive mapping, duplicate,
workflow and review paths need investigation. Direct connector calls, old binaries, other validations,
previous sends and remote side effects are not repaired. An authorized integration/data owner must
assess mappings, historical effects and any correction or retry against the actual destination.
No production or vendor investigation is claimed. Local `npm run verify -- --runInBand` passed
126 suites / 977 tests with 31 skipped; a PostgreSQL 16.16-configured backend run passed 112 suites /
653 tests, including SQLite-specific fixtures. Formatting, diff checks and the backend build passed.
Owner: unassigned; integration and data integrity.

### ARC-038 — HIGH: mapping destination collisions can silently lose values

Two source fields could target the same destination: the later assignment silently replaced the
first, even when both values were non-empty. Optional mapped names such as `__proto__` could also be
lost or alter a local object's prototype, because the mapper and other connector paths use ordinary
JavaScript objects. An API regression confirmed the duplicate profile was accepted before the fix;
unit tests cover the direct mapping boundary and Object.prototype names.

New profiles now reject exact repeated destination names and every own property name of
`Object.prototype`. The SDK mapper rejects the same names; the backend checks stored profiles before
send or duplicate preview, including malformed JSON or non-array field maps, and returns a generic
conflict before invoking a destination. Tests exercise rejected new and synthetic legacy profiles,
including duplicate lookup and a valid control. Existing profiles are not automatically changed;
the API currently provides no mapping edit route, so affected users must review and create/select a
corrected profile. This is a compatibility restriction, including for legitimate destination fields
named `constructor`, `toString`, or `__proto__`.

This is not destination identity validation: case-folding, collation, Unicode normalization,
provider-specific aliases and response/merge names can still collide. Direct calls to connector
implementations bypass backend/mapper checks; old processes, historical mappings and remote writes
are unchanged. Malformed-profile handling does not establish full schema validation. Review other
name-sensitive mapping, duplicate, workflow and review paths; an authorized integration/data owner
must assess affected mappings, historical effects and any destination-specific corrections. No
production or vendor investigation is claimed. Local `npm run verify -- --runInBand` passed
127 suites / 990 tests, with 31 skipped. Four PostgreSQL 16.16-configured connector backend suites
passed 19 tests. A concurrent full PostgreSQL backend command lost its shell before a summary; its
orphaned process was stopped, so a full PostgreSQL pass is not claimed for this revision. Formatting,
diff checks and the backend build passed. Owner: unassigned; integration and data integrity.

### ARC-039 — HIGH: inherited workflow fields can spuriously match and trigger deletion

Workflow condition lookup previously read properties inherited from `Object.prototype` as if they
were present fields. Before the fix, an end-to-end SQLite regression created an owner-configured
`auto_approve` rule with `toString exists`, evaluated it for an invoice without that field, and
observed the document's `deleted_at` become non-null. With `always_ask`, the same false match led
to a pending plan. No production execution is claimed.

Current condition evaluation reads only own field properties, while preserving the special
`documentType` behavior. Tests cover Object.prototype and custom inherited properties, genuine own
properties (including `__proto__`), false and zero, plus API evaluations under both policies. The
synthetic tests verify a skipped plan and no soft-delete for this specific `exists` case. Subsequent
synthetic tests reproduced `not_equals` on a missing documented path matching an approved invoice
and automatically deleting it. All condition operators now fail to match absent, undefined, null and
empty-string values, while retaining false and zero as present. This is a compatibility change: rules
that intentionally compared to null or empty values stop matching. A further synthetic regression
showed an omitted `not_equals` operand could also delete an approved document. Except for `exists`,
conditions with a missing or null operand now fail to match. These guards do not establish correct
field paths or validate all operand values and comparison types.

Approved-trigger deletion now also requires a supported condition-semantics version in the recorded
approval snapshot. Otherwise-current older pending or automatic plans without that version fail closed;
tests exercise both execution paths. Other triggers' deletion plans already fail closed. The marker
is not an authenticated proof, and these plans are neither reevaluated nor proactively cancelled.
Old binaries remain unsafe, and prior soft-deletions and downstream effects are unchanged.
Authorized owners should review affected definitions, runs and records before approving, replaying
or correcting anything; do not blindly retry or restore. Other authorization, trigger, snapshot,
concurrent execution, field semantics and real deployment behavior require independent review.
After these additional guards, `npm run verify -- --runInBand` passed 133 suites / 1047 tests, with
39 skipped. Eight focused PostgreSQL 16.16-configured backend suites passed 76 tests; some tests
use SQLite or doubles. This is not a full PostgreSQL suite. Formatting, diff checks and the backend
build passed. Owner: unassigned; workflow/product and data integrity.

### ARC-040 — HIGH: documented workflow field paths do not match evaluation context

A regression using an approved sample invoice reproduced the API-documented `total.amount > 100`
condition being skipped, even though the synthetic invoice's amount exceeds the threshold. The
same test records that `fields.total.amount.value > 100` matches and waits for approval. This
reflects the current implementation flattening the whole latest extraction, not a specification
that the raw path is the intended long-term interface. Previously `not_equals` on a missing documented
path instead matched and could cause soft-deletion for an owner-configured auto-approve rule. The
missing-value mitigation described in ARC-039 prevents that specific false match but does not repair
path resolution or other comparison semantics.

No automatic path rewrite is made here: activating previously nonmatching rules could itself execute
destructive actions. An authorized product/workflow owner must define the broader field, missing-value,
trigger and snapshot semantics and a versioned, explicitly reviewed migration,
assess existing definitions and runs, and test both databases and supported clients before enabling
changed behavior. Tests characterize one path and do not exhaust all conditions. Historical effects,
production rules and downstream records have not been investigated. Owner: unassigned;
workflow/product and data integrity.

### ARC-041 — HIGH: read-only principals could mutate documents and reviews, execute workflows and send records

A synthetic API regression using a `documents:read`-only API key reproduced HTTP 201 for document
upload, 202 for reprocess, 204 for soft-delete and 200 for workflow evaluation. The evaluation test
used an owner-configured automatic delete; it could run that destructive action even though the key
was mapped to the viewer role. The prior service methods did not check roles. No production access,
incident, credential abuse or historical impact is claimed.

Upload now requires operator or above, while reprocess, soft-delete and workflow evaluation require
reviewer or above; the checks are enforced in the services, and the HTTP upload route also checks
before buffering the file. Integration tests cover read-only keys, viewer and operator sessions,
viewer service calls, a permitted operator upload and permitted reviewer-level key operations. They
show those particular denied operations have no document deletion or workflow run, not that all
routes enforce RBAC. These are compatibility changes: operators who previously reprocessed or deleted
and viewers who previously invoked these actions will be denied. Review intended role policy and
client deployments with product/security owners.

Further synthetic tests reproduced a read-only key opening a review (200), sending an approved record
through a connector (202, with the adapter invoked), and creating a batch (201). In the batch case,
the downstream upload role error was caught as an item failure rather than denying batch creation.
Review open, field edits, approval, rejection and bulk approval, and connector send now require
reviewer or above in their services; direct mapping creation has the same check as its existing HTTP
route. Batch creation requires operator or above in the service before consuming files and in the
HTTP route before multipart spooling. Tests cover denial and unchanged review/extraction state,
no connector adapter call, no batch row, direct service denial, permitted reviewer-level key actions,
and an operator session creating a batch with a non-failed item. These changes also deny operators
review and send operations they may previously have used. They do not undo prior external writes,
review changes or batch records and are not a complete authorization review.

Further synthetic regressions reproduced a `review:write` key deleting a document and a
`connectors:write` key reading exports because scopes were converted to the highest broad role.
Current HTTP code now applies a default-deny, exact method/route scope allowlist before body parsing,
including on public routes when a key is supplied. It derives the route role only from the applicable
scope or `admin`, capped by the creator's live membership. The previous cap omitted `operator` from its
role ladder; this is corrected. The policy and intentional compatibility restrictions are documented
in `docs/api-key-scopes.md`. Synthetic tests cover route policy against registered templates and unrelated
scopes, API denial, allowed combinations, tenant isolation and membership changes. The full local
verification passed 138 suites / 1081 tests with 42 skipped; the PostgreSQL 16.16-configured backend
suite passed 127 suites / 756 tests (some use SQLite or doubles). Backend build, selected formatting
and diff checks passed. This does not enforce scope at direct service boundaries or protect old
binaries, device actors, historical effects or unreviewed route semantics. Product/security review and
integration rollout are still needed. Other routes, credentials and effects remain unaudited; the
`document.approved` workflow trigger still requires a separate current-approval
and race-safety design. Previous soft-deletes, requests, cloud costs, copies, logs and old binaries
are unchanged. An authorized owner should assess exposure, logs, existing keys and possible
credential rotation or record recovery without blind replay. Independent security review and a
complete route/scope/tenant authorization matrix remain necessary. Local `npm run verify -- --runInBand`
passed 129 suites / 1003 tests with 31 skipped after updating two composition fixtures for the new
roles. Six focused PostgreSQL 16.16-configured suites passed 62 tests; the composition suite uses
repository doubles rather than PostgreSQL. An initial PostgreSQL attempt used a nonexistent database
role and did not exercise the integration tests; the corrected run passed. This is not a full
PostgreSQL run. Formatting, diff checks and the backend build passed. Owner: unassigned; security
and product.

### ARC-042 — HIGH: supplied workflow triggers and stale plans can execute destructive actions

Synthetic API tests reproduced an owner-configured `document.approved` automatic deletion against a
`needs_review` document: the owner supplied the trigger even though no approval had occurred.
Evaluation permits reviewer-level callers as well. A `batch.completed` trigger with an unrelated document likewise deleted that document
without evidence of a batch event. A pending approval-trigger delete also executed after reprocessing
was queued. These are synthetic demonstrations, not evidence of production abuse.

As a partial mitigation, evaluation of `document.approved` now requires a currently approved,
non-deleted document with an approval of its latest extraction and no active extraction job. It
returns 409 before creating runs if this check fails. Planning reads the extraction and its review
and extraction identities in one query and records those identities with each run. Before executing
a database-local delete for that trigger, the service locks the document inside the run transaction
and checks that the same review and extraction remain current; a failed check rolls back the action
and causes the run to be marked failed. Tests inject reprocessing between planning and execution and
confirm that a pending plan cannot delete after a newer extraction is approved. The check serializes
against current-version review and reprocessing paths using the same document lock; it does not fence
old binaries, direct database writers or independently enqueued jobs. The identifiers are not content
hashes, and the evaluator reads the extraction, not the separately saved approved UDM.

Migration 015 adds a nullable identity column, with no unsafe backfill; approved-trigger deletion of
legacy, malformed or stale runs fails closed. Existing pending plans may therefore become permanently
failed. Apply the migration before deploying and stop or fence old binaries, which do not enforce this
protocol. New review/extraction identifiers persist in run history; assess retention, erasure and
copies with the responsible data owner.

Synthetic tests also showed `document.extracted` and `document.needs_review` could be supplied for a
queued document and trigger automatic deletion. Matched plans containing deletion for those triggers
or `batch.completed` now fail before any action under either approval policy. Execution also fails
closed for existing pending or matched runs and unknown persisted triggers. Tests cover both policies,
mixed plans, unmatched rules and legacy runs. This intentionally disables deletion under those triggers
until a product-reviewed event and state-binding protocol exists. It does not authenticate events,
remediate historical deletions, or constrain older binaries.

Synthetic tests also reproduced pending and automatic deletions after their workflow was disabled or
deleted. Before supported database-local execution, current code now locks the workflow row and marks
the run failed in the same transaction if the definition is disabled or absent. SQLite tests exercise
pending approvals and automatic plans changed between planning and execution. PostgreSQL tests observe
both lock orderings: a committed disable makes waiting approval fail, while a disable waiting behind an
already-executing approval cannot undo its committed deletion. Subsequent synthetic tests reproduced
revival of an untouched pending plan after disable and re-enable. Migration 016 adds a workflow revision;
current enable/disable requests increment it atomically, including no-op requests. New approved plans
record the candidate revision and execution checks it under the workflow lock. Missing, malformed or
mismatched revisions fail closed, including for plans created before the migration and for a rule
changed between planning and run creation. Concurrent current-version changes cannot lose increments.
Pending runs are not proactively cancelled; reevaluation creates new plans and can execute actions.
Old binaries and direct writers can change workflow state without bumping the revision, and the guard
cannot undo already committed execution or authenticate an event.

**The finding remains open.** `document.approved` remains caller-supplied despite the current-state
identity checks. Repeated evaluation is not deduplicated, and no check here authenticates a historical
event or guarantees external effects. Owners should restrict evaluation and pending-run approval for
unsafe workflows, review existing pending and
historical runs and effects, and avoid blind replay. A product/security-reviewed, versioned event
and snapshot protocol must bind plans to authentic events and immutable state, define cancellation
and re-evaluation semantics, handle mixed deployments and recovery, and be validated with concurrent
writers on both supported databases. Do not interpret this mitigation as closing ARC-027, ARC-040 or
ARC-042. After revision binding, local `npm run verify -- --runInBand` passed 135 suites / 1064 tests,
with 42 skipped. The PostgreSQL 16.16-configured backend suite passed 124 suites / 739 tests; some
tests explicitly use SQLite or doubles. The migration regression covers marker-failure rollback and
legacy snapshot preservation on both configured drivers. A PostgreSQL race test observed an approval
waiting while a disable and re-enable committed, then failing without deletion. A separate test
observed an approval waiting on the document lock while the real reprocessing transaction was held,
then failing without deletion after it
committed. This covers one lock ordering, not all races, mixed versions or external effects.
Formatting, diff checks and the backend build passed. Owner: unassigned; workflow/product,
security and backend reliability.

### ARC-043 — HIGH: automatic schema migration could leave partial schema or race at startup

`createDatabase` calls `applyMigrations` on process startup. Previously the runner executed migration
statements and recorded their `schema_migrations` marker separately, without a transaction around
both or a cross-process lock. A synthetic SQLite test injected a failure after migration 015 added
its column but before its marker was written. The column remained, the marker was absent, and retry
failed with a duplicate-column error. No production state or impact has been established.

The current runner now applies all pending migration SQL and ledger entries in one transaction.
SQLite uses `BEGIN IMMEDIATE`; PostgreSQL obtains a transaction-scoped advisory lock keyed by the
current schema, then reads the ledger under `READ COMMITTED`. Current runners on the same file or
same PostgreSQL database/schema serialize; a lock or statement timeout can instead fail startup.
Tests exercise marker failures, rollback of an entire fresh migration sequence, real SIGKILL before
the marker on each driver, two SQLite processes, and two PostgreSQL connections with an observed
advisory-lock wait. The tests cover selected failure boundaries and current SQL, not all possible
storage, network, schema, or database versions.

This does not repair historical partial migrations, fence old binaries or direct database writers,
or resolve an ambiguous commit. A verified backup, staged deployment, controlled migrator and
fencing of older processes remain necessary. After a failed or ambiguous migration, an authorized
database owner should inspect the actual schema and ledger against a release-specific recovery plan;
do not blindly retry, insert markers, drop columns or restore. Future migrations must be compatible
with transactions. Independent R03/database review, commit/network fault and mixed-version testing,
production evidence and a documented recovery procedure remain necessary. Local verification
(`npm run verify -- --runInBand`) passed 133 suites / 1020 tests, with 39 skipped; the full
PostgreSQL 16.16-configured backend suite passed 121 suites / 692 tests, some of which explicitly
use SQLite or doubles.
Formatting, diff checks and the backend build passed. Owner: unassigned; database and deployment
reliability.

### ARC-044 — HIGH: PostgreSQL connection loss could crash the process and leave work uncertain

A synthetic PostgreSQL test terminated the backend of a checked-out transaction while its callback
was paused. Before the change, `pg` emitted an unhandled client error and the test process exited;
an earlier in-process attempt also reported an unhandled error. Idle pool errors likewise lacked a
pool listener. The current adapter handles idle pool error events with a fixed, non-secret production
log, rejects a checked-out transaction on connection loss, discards the lost connection and
invalidates its scoped handle. Synthetic PostgreSQL tests cover a terminated backend, a lost idle
connection, replacement connections, and stale handle rejection.

This is not ownership or side-effect fencing: JavaScript callbacks can resume after the transaction
has rejected, and already-started filesystem, provider or external operations cannot be cancelled by
this adapter. Commit or connection failure may be ambiguous; rollback is not proof of the outcome.
Other database drivers, process and network failure boundaries, logging paths, supported database
versions and mixed deployments require review. Do not blindly retry external effects; inspect durable
state and use an independently reviewed idempotency and fencing protocol. No production incident or
impact is asserted. The full local and PostgreSQL-configured verification results are recorded in
ARC-043; connection-loss tests exercise the real PostgreSQL driver. Owner: unassigned; database and
backend reliability.

### ARC-045 — HIGH: API key expiry was ignored and machine credentials could manage keys

Synthetic tests reproduced key creation with `expiresInDays` returning no expiry: prior code accepted
the value but neither stored nor enforced it. A key with `admin` or `connectors:write` obtained an
admin-equivalent role and could issue other keys, and a viewer could list key metadata. This is not
evidence of production abuse or proof that any particular historical key was meant to expire.

Migration 017 stores new optional expiry timestamps; current authentication rejects malformed and
elapsed non-null timestamps, including at the exact boundary. New key creation, listing and revocation
require an authenticated user with owner/admin role; API keys and device credentials are denied even
if their role is elevated. This deliberately breaks automated key management. Admins cannot issue
`admin` scope, as before. Tests cover service and HTTP boundaries, expiry, non-expiring keys, and
transactional migration rollback and retry. ARC-041 describes subsequent HTTP scope isolation and
its remaining limitations.

Existing key rows do not record whether expiry was requested, so migration 017 leaves them with null
expiry and they continue to authenticate. Authorized security owners must inventory, assess and
revoke or replace affected keys; a null expiry is not proof of historical intent. The change cannot
undo exposure or revoke already-created delegated keys automatically. Older binaries ignore expiry
and the new authorization policy; fence them and apply migration 017 before relying on this control.
Expiry uses the API process clock; validate clock synchronization. A request already authenticated
can continue after expiry or revocation, and direct database writers remain outside these checks.
Independent security review, historical audit/credential assessment, rotation and deployment evidence
remain required. Local `npm run verify -- --runInBand` passed 137 suites / 1074 tests with 42 skipped;
the PostgreSQL 16.16-configured backend run passed 126 suites / 749 tests, some using SQLite or
doubles. The expiry and migration tests ran on both configured drivers. Backend build, formatting and
diff checks passed. No production action or owner sign-off is claimed. Owner: unassigned; security
and deployment.

### ARC-046 — MEDIUM: PostgreSQL placeholder rewriting does not parse all SQL quoting

`apps/backend/src/db/database.ts:26-40` toggles an in-single-quote flag while rewriting every
other `?`; `apps/backend/src/db/postgres.ts:43,53,79-89` applies it to queries. The existing
`apps/backend/test/security.test.ts:254-261` checks an ordinary single-quoted literal only. A
local, isolated probe of the actual helper (`node docs/reviewers/evidence/R01/placeholder-probe.cjs`)
produced `SELECT $$$1$$ AS q, $2 AS arg` from `SELECT $$?$$ AS q, ? AS arg`, and rewrote the
question mark in a SQL comment while numbering the real placeholder `$2`. Results are saved in
`placeholder-probe-9ec567c.txt`. Both examples are synthetic; no query was sent to a database.

This can alter SQL or parameter numbering when such syntax is used; it does not establish that a
current production query is affected. PostgreSQL migration SQL already uses a dollar-quoted body
(`migrations.ts:292-296`), though that particular body contains no question mark. PostgreSQL quoted
identifiers, escaped strings, operators and other lexical forms also require a contract-specific
review, not an assumption of blanket support. R03 should inventory actual queries and decide and
document the supported SQL subset or design a correctly bounded rewriter, with regression tests and
real PostgreSQL validation as appropriate. R02 should review callers, and R16 test coverage. Owner:
unassigned; proposed review R03/R02. No production incident, remediation, deadline, owner acceptance
or exception is asserted.

### ARC-047 — MEDIUM: shared TypeScript paths do not enforce declared workspace boundaries

`tsconfig.base.json:19-23` maps `@idcp/connectors` globally, and desktop, mobile and shared inherit
that mapping despite not declaring `@idcp/connectors` in their workspace manifests. The TypeScript
resolver resolves the alias to connector source for those projects. This fails the literal
ARC-AC-10 expectation that no path points outside declared dependencies. `workspace-alias-scan.cjs`
checks seven current tsconfigs and their inherited aliases; the saved output
`workspace-alias-scan-9ec567c.txt` shows 114 cross-workspace literal occurrences among 195 tracked
source files and no resolved undeclared edge within that scope. The existing base aliases therefore
permit an undeclared edge at type-check time; this is not evidence that such an edge currently
exists, that a build would bundle it, or that production behavior is affected. The scripts do not
cover runtime/native bundling, tests/config source imports or nonliteral modules.

R01 should specify whether project-specific aliases or an independent import-boundary check should
be the enforcement mechanism; R02/R09/R11/R16 should evaluate compatibility, actual build tooling
and regression tests. Avoid treating an alias as a security boundary. Owner: unassigned; proposed
review R01/R02 with client and QA specialists. No change, production incident or exception is claimed.

### ARC-048 — MEDIUM: job retry policy is embedded in a persistence repository

`apps/backend/src/repositories/system-repo.ts:184-207` decides whether an attempt is exhausted,
sets `dead` versus `queued`, and calculates exponential retry delay capped at 60 seconds before the
conditional row update. `:9-27` also supplies the default maximum attempts. These are behavior
policy as well as persistence, so the brief's strict ARC-AC-04 criterion (repositories contain only
persistence and row mapping) is not met. `layer-policy-review.md` identifies other policy and
transactional invariants, including atomic job claiming and safe erasure bounds. This is an
architectural seam finding, not a demonstration of a retry defect or an operational incident.

R01 and R02 should decide whether to document an explicit repository-policy exception or separate
policy from persistence while preserving the guarded update, transaction and concurrency semantics;
R03/R18/R16 should review changes and relevant tests. Do not remove storage-level safety predicates
or infer exactly-once work from a refactor. Owner: unassigned; proposed R01/R02. No owner acceptance,
implementation, date or exception is claimed.

### ARC-049 — HIGH: process-wide cloud OCR ignores the organisation's provider setting

DEC-007 (`DECISIONS.md:91-101`) says cloud providers are opt-in per organisation. New
organisations are stored with `ai_provider = 'local'` (`repositories/auth-repo.ts:23`), the
organisation service returns and updates the value (`organisation-service.ts:54-87`), and desktop
settings display it (`apps/desktop/src/pages/SettingsPage.tsx:118-120`). However,
`services/container.ts:116-136,363-380` selects one process-wide OCR provider from `AI_PROVIDER`
and injects it into the worker. `services/worker.ts:256-328` reserves remote-call budgets when the
injected provider is nonlocal, but does not check the organisation's `ai_provider` before sending
the document buffer to the pipeline. Per-document and per-organisation call limits are not consent
or provider-selection controls. Conversely, an organisation setting of `cloud` does not switch a
process configured for local OCR to cloud.

Reproduction after `npm ci`:

```sh
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/provider-selection-probe.ts
```

The synthetic SQLite harness registered a default-local organisation, uploaded a generated image, verified that the
cloud-configured factory selects a nonlocal provider, and drained a worker with the real cloud
adapter using an injected **in-memory fetch stub**. The stub observed one request containing the
synthetic image. See `provider-selection-probe-9ec567c.txt`. The injected adapter isolates the
transport for safety; no real remote call, production data, deployment configuration or actual
customer exposure was observed. The counterexample establishes the architectural mismatch, not the
legal status of an organisation's consent or the complete behavior of every provider.

When a deployment enables global cloud OCR and remote-call limits permit it, this mismatch can send
a local-marked organisation's document to the configured external service contrary to the recorded
decision and displayed setting. Authorized privacy/security and operational owners should assess
configuration and historical processing under their policies; no inventory or notification is
asserted here. R02/R14 should design and independently test an explicit organisation-aware,
fail-closed selection and policy protocol with R07/R08, including changes concurrent with queued or
in-flight work, mixed versions, delivery/consent semantics, existing configuration and operational
rollback. A zero call limit can block new reservations on current-version workers but cannot cancel
calls already in flight, govern older versions or prove provider deletion; do not represent it as a
complete remediation. Owner: unassigned; proposed R02/R14 with R07/R08/R19. No fix, exception,
production action or reviewer approval is claimed.

### ARC-050 — MEDIUM: extraction does not record the selected template version

DEC-015 (`DECISIONS.md:229-249`) says template field-list changes are snapshotted so an extraction
under an older layout can always be explained. `template-repo.ts:80-116,130-140` versions and
stores field snapshots, and `worker.ts:280-289` obtains the active template's expected fields.
However, `template-service.ts:175-183` returns the field list without its template ID or version;
`worker.ts:342-355` stores the extraction without either. `documents` has a `template_id` column,
but `document-repo.ts:40` initializes it to null and a source search finds no assignment to it;
`extractions` has no template/version column in the current migrations. See
`adr-architecture-review.md` for the bounded search and evidence.

This means the stored extraction does not directly identify the exact template version that supplied
its expected fields. Timestamp and history may help some investigations but do not establish the
promised unambiguous provenance, particularly across concurrent edits and retries. This is a static
architectural analysis, not proof that an actual customer record is unexplainable or that historical
snapshots are absent. R02/R03/R14 should assess the provenance contract and safe version binding,
including migration, concurrent edits, snapshot retention and legacy data; R20 should review the
wording. No schema change, inferred historic version, owner exception or production action is
claimed. Owner: unassigned; proposed R02/R03/R14.

### ARC-051 — HIGH: the configured upload rate limit is applied to pairing instead

`.env.example:82` describes `RATE_LIMIT_UPLOAD_PER_MIN` as uploads per organisation;
`legal/PRIVACY.md:84` also lists rate limiting on uploads, and `REQUIREMENTS.md:169` asks for rate
limiting on authentication, pairing, upload and export. In current application code,
`services/container.ts:448-453` uses that setting for `pairingLimiter`, and
`http/routes/pairing-routes.ts:12-16` keys it by user for pairing-session creation.
`http/routes/document-routes.ts:27-69` authenticates and applies file-size limits, but does not use
that limiter. Source references to `pairingLimiter` do not show a document upload use.

Reproduce on the local synthetic harness with:

```sh
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/upload-rate-probe.ts
```

With rate limiting enabled and `RATE_LIMIT_UPLOAD_PER_MIN=1`, two uploads by one synthetic
organisation within one minute both returned 201; two pairing-session creations returned 201 then 400. See `upload-rate-probe-9ec567c.txt`. The probe uses in-memory SQLite/storage and a local test
listener; no external proxy, production traffic or real user was tested. An edge proxy might have
its own controls; no statement is made about any particular deployment. Per-file/request size limits
and authentication are separate controls and do not prove an upload request-rate limit. The probe
covers the single-document route and pairing creation, not every batch/export/credential path.

R02/R07/R17 should specify the intended keys, shared or per-replica scope, pre-body enforcement,
retry semantics, batch treatment and resource limits; R19 must evaluate actual deployment controls
and R21 the legal statement. Do not infer a tested fix, production incident, exploitable volume or
legal conclusion from this synthetic reproduction. Owner: unassigned; proposed R02/R07 with
R17/R19/R21. No implementation or exception is claimed.

### ARC-052 — MEDIUM: optional realtime capability returns an undeclared error code

The `RealtimeHub` port declares `subscribe` optional (`realtime/hub.ts:28-33`). When a supplied
hub lacks that capability, `http/routes/realtime-routes.ts:43-51` constructs a 501 response with
`error.code = 'NOT_IMPLEMENTED'` and tells the client to use a realtime socket. That code is not
present in the shared `ERROR_CODES`/`ErrorCode` (`packages/shared/src/constants.ts:117-140`) or
`ErrorEnvelope` type (`packages/shared/src/errors.ts:45-51`); the source says no Socket.IO adapter
is shipped. `docs/openapi.yaml:1894-1911` documents a 200 event stream but not this 501 case.

`apps/backend/test/devapi.test.ts:236-251` injects a hub without subscription support and confirms
the 501/`NOT_IMPLEMENTED` response. This is a reachable port configuration exercised in a synthetic
test, not proof that the default in-memory hub or any production deployment returns it. The JSON
object retains the usual envelope shape, but its code is outside the shared type and the fallback
advice is unsupported by the standard runtime. Health endpoint 503 uses a separate response by
intent and is not asserted to be this finding. See `error-boundary-review.md`.

R04/R02 should decide and document a consistent status/code and truthful client guidance, with
R09/R11/R18 checking compatible client and stream behavior. No contract change, production impact,
owner acceptance or exception is claimed. Owner: unassigned; proposed R04/R02.

### ARC-053 — MEDIUM: neither client coordinates concurrent token refresh

`apps/desktop/src/api/client.ts:236-247` and `apps/mobile/src/api/client.ts:160-175` retry a 401 by
calling their own `refresh()`, and each `refresh()` re-reads the stored token immediately before
exchanging it (`desktop:255-273`, `mobile:179-200`). Neither class keeps a shared in-flight promise
or a mutex, so two requests that receive 401 in the same window both submit the same refresh token;
the later responder overwrites the earlier pair in storage. In a fake-fetch probe the desktop client
issued two `/auth/refresh` calls with the same token and then four document requests, while the
mobile client under a single-use stub received 401 for the repeat, cleared its store and fired
`onSessionExpired` once even though one request had already succeeded. See
`client-refresh-probe-9ec567c.txt` and `client-boundary-comparison.md`.

Reproduce with:

```sh
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/client-refresh-probe.ts
```

The probe uses stubbed HTTP only; no device, packaged app, real token, user or production traffic was
involved. It does not prove a packaged-app sign-out, a leak or how often the interleaving occurs.
Existing suites cover only the sequential refresh path. R09/R11 should decide on a shared refresh
promise or serialised retry and the losing request's behaviour, with R05/R07 for the security
consequences and R04 for any contract expectation. Owner: unassigned; proposed R09/R11 with R05/R07.

### ARC-054 — MEDIUM: refresh rotation is not an atomic single-use claim

`AuthService.refresh` (`services/auth-service.ts:561-572`) reads a session by token hash, checks it is
unrevoked and unexpired, then calls `sessions.revoke(session.id)`
(`repositories/auth-repo.ts:504-509`). That update is conditional on `revoked_at IS NULL`, but its
affected-row count is discarded and the replacement session is created afterwards by `issueTokens`
rather than derived from the revoke; the refresh path is not wrapped in `transaction()`
(`services/container.ts:182-190` provides one). Two callers that both read an unrevoked row therefore
both rotate.

A synthetic probe inserts an artificial barrier between the two reads on the real service, routes,
repository and HTTP stack: the same refresh token submitted twice returned `200` and `200` with two
distinct refresh tokens and two new session IDs, neither equal to the original; afterwards the
original token returned `401` but **both** successors remained usable. See
`refresh-race-probe-9ec567c.txt` and `client-boundary-comparison.md`.

```sh
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/refresh-race-probe.ts
```

Limits: one process, in-memory SQLite, deliberately synchronised reads. PostgreSQL uses the same
read-then-update shape but was not exercised for this race, and real network timing determines
overlap frequency. This does not establish that any deployed token has been stolen or replayed, and
no user-visible defect is claimed. The documented "single-use, rotating" promise (`SECURITY.md:64`,
`API.md:135`) is therefore conditional on sequential use, and no reuse detection revokes a replayed
family. R05 owns the token-lifecycle decision (atomic consumption, reuse detection, family
revocation), R07 the security assessment, R03 cross-driver atomicity, and R09/R11 client coordination.
Owner: unassigned; proposed R05/R07 with R03.

### ARC-055 — HIGH: the "check for updates" call reports success without checking anything

With auto-update enabled, the desktop main process answers the update-check IPC channel with a
constant `{ status: 'up_to_date', version: app.getVersion() }` and performs no network request,
no manifest comparison and no signature check (`apps/desktop/src/main/electron-main.ts:221-224`).
The preload exposes it to the renderer as `checkForUpdates()` with the union
`'disabled' | 'up_to_date' | 'available'` (`apps/desktop/src/main/preload.ts:42-60`), so the renderer's
type system describes a capability the main process does not have. With auto-update disabled the
same handler returns `{ status: 'disabled' }`, and `apps/desktop/test/shell.test.ts:302-324` asserts
both responses — the test locks in the placeholder as if it were the contract.

Why it matters: "up_to_date" is a positive assurance about security patches and release currency. An
operator or a person reading the app receives that assurance at a moment when no check has happened,
and `ARCHITECTURE.md` §2.2 describes this only as a "stub, not a functional update service", which
does not say that the stub reports the affirmative result. Nothing in the packaged app currently
calls the channel (no renderer reference exists), so the exposure is a contract-level and
operator-guidance problem today rather than a shipped button that lies; it would become a direct
user-facing false statement the moment any UI surfaces it.

Reproduce by reading the handler and the two assertions; no packaged build, network or release feed
is involved, and no claim is made about any deployed update pipeline. Suggested fix belongs to
R09/R10: either implement a real signed check and return `available`/`error` truthfully, or remove
the channel and the union so no caller can obtain a false assurance; R19 should correct any operator
guidance that cites the update check as a control.

Owner: unassigned; proposed R09/R10 with R19 and R20.

### ARC-056 — MEDIUM: the "last owner" rule is a read outside the transaction that acts on it

Two ownership rules are enforced by a read followed by a separate write:

- `privacy-service.ts:153-161` lists the organisations the caller owns and refuses erasure if any has
  more than one owner; the erasure transaction opens afterwards at `:164`.
- `organisation-service.ts:122` reads `memberships.countOwners(...)` and refuses a demotion or removal
  when the count is `<= 1`, in a separate statement from the `updateRole`/`remove` call that follows.

`countOwners` itself is `SELECT COUNT(*) … role = 'owner'` (`repositories/auth-repo.ts:452-458`) and
`ownersForOrganisation` is the same predicate in a second repository
(`repositories/privacy-repo.ts:62-66`). Neither read takes a lock, and neither is repeated inside the
transaction that performs the change. Two owners who remove or demote each other, or one owner who
erases while another is being demoted, can therefore each observe "someone else remains" and commit,
leaving the organisation with no owner — the exact state both rules exist to prevent.

Why it matters: an organisation with no owner has no one who can administer members, connectors or
retention; recovering it requires an operator with database access, which the product does not
offer. The window is concurrent administrator actions, not a routine path, and nothing here shows it
happening in practice.

Reproduce by reading the two call sites and their transactions; no probe was written, because
demonstrating it needs a controlled interleaving of two authenticated requests and the result would
still be a synthesised schedule rather than observed use. Suggested fix belongs to R06 with R03: take
the ownership decision inside the same transaction as the change, under a row lock or a conditional
`UPDATE … WHERE (SELECT COUNT(*) …) > 1`, and collapse the two literal predicates into one. R08 owns
the erasure variant.

Limits: static reading of the current source; no concurrency test, no production incident and no
data loss is claimed. The same read-then-act shape is the one already recorded for refresh rotation
(ARC-054), which is why R03 is asked for a cross-driver answer rather than a per-site patch.

Owner: unassigned; proposed R06 with R03 and R08.

### ARC-057 — MEDIUM: the offline read-only guarantee is re-derived per tool, with no shared test

Ten operator CLIs under `apps/backend/src/db/*-cli.ts` each construct their own database connection
instead of using `createDatabase()` (`db/index.ts:11-31`), because they need a pool of one, no
migration application and — for inspection modes — a read-only connection. The first two are
uncontroversial. The third is a **safety property of operator tooling** and it is implemented six
times:

- `batch-error-remediation-cli.ts:43-59`, `connector-error-remediation-cli.ts:43-59`,
  `export-inventory-cli.ts:30-42`, `storage-inventory-cli.ts:45-56` and
  `worker-error-remediation-cli.ts:43-59` open PostgreSQL with
  `SET default_transaction_read_only = on` and SQLite through `ReadOnlySqliteDatabase`;
- `worker-recovery-cli.ts:44-78` opens a **writable** PostgreSQL connection and instead wraps only the
  listing branch in `SET TRANSACTION READ ONLY`.

Both mechanisms are defensible; the per-transaction one is arguably stronger. The gap is that nothing
states which is the contract, no shared helper expresses it, and no test asserts that every
inspection mode is read-only on both drivers. An operator who points `worker-recovery-cli --list` at a
production database is relying on a property that is asserted nowhere: if a later edit moved the
listing code outside that transaction, or added a `--check` mode that queries before opening it, the
tool would write and no test would notice. `read-only-sqlite.ts` is likewise reachable only from these
CLIs, so its own `execute()`/`transaction()` guards are untested by any shared suite.

Why this is MEDIUM rather than higher: the current code does read only, on both drivers, for every
mode that claims to. This is missing enforcement and evidence for an operator safety property, not a
demonstrated write or an incident.

Suggested fix belongs to R02 with R19/R03: one offline-access factory taking
`{ readOnly, applyMigrations: false, poolSize: 1 }`, with a shared test that drives every `--list` and
`--check` mode against both drivers and asserts a write is refused. R16 owns the test design; R03 owns
the PostgreSQL behaviour.

Limits: static reading plus per-file grep of the read-only mechanisms; no CLI was executed against a
database in this review, and no claim is made about any deployed operator practice.

Owner: unassigned; proposed R02 with R03/R16/R19.

### ARC-058 — HIGH: one open SSE stream blocks shutdown until the client leaves

`http/routes/realtime-routes.ts:76-82` registers `request.raw.on('close', close)` but never registers a
`reply.raw.on('close')`/`socket.on('close')` cleanup, and `buildApp` sets no
`forceCloseConnections` (`http/app.ts:30-36`). `index.ts:33-44` closes in the order
`maintenance.stop()` → `worker.stop()` → `app.close()` → `db.close()`, so shutdown blocks in
`app.close()` waiting for the long-lived stream to end. The server never ends the stream, and the
stream's `close()` only runs when the client goes away.

A synthetic probe over loopback HTTP with in-memory SQLite, a synthetic user and no external service
records four cases (`shutdown-probe-9ec567c.txt`):

```sh
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/shutdown-probe.ts
```

- **A.** No client connected: boot 1063 ms, `SIGTERM` → exit code 0 after **10 ms**.
- **B.** One authenticated SSE stream open: `SIGTERM` → **still running after 8000 ms**, killed by the
  probe; the client saw a transport error only when the probe killed the process.
- **C.** Same as B with `MAINTENANCE_ENABLED=false`: **still running after 8000 ms**. The cause is the
  open stream, not the maintenance scheduler.
- **D.** `SIGTERM` with a live stream, client disconnects 2 s later: still running at the disconnect,
  then exit code 0 after a further 2013 ms.

Why it matters: `DEPLOYMENT.md` tells operators to run the service under a supervisor that forwards
`SIGTERM` and to "configure the supervisor's grace period accordingly", stating there is no
application shutdown deadline. Because shutdown now waits on remote clients, the effective deadline is
the slowest client's session: Docker's default 10 s grace expires first, which means `SIGKILL` during
whatever `maintenance.stop()`/`worker.stop()` were still finishing, and a torn HTTP close rather than a
clean one. Every connected desktop window holds an SSE stream open for as long as it is open, so the
blocking case is the normal state of a running deployment, not an edge case.

This is not a crash or data loss on its own — the idle path still exits in 10 ms, and D shows the
process does finish once clients leave. It is a HIGH because the documented shutdown and recovery
behaviour does not hold under ordinary use, and because the operator guidance that was supposed to
cover it ("configure the grace period") cannot bound a wait on remote clients.

Reproduce requires nothing but the probe. No production incident is claimed, and no supervisor,
container or systemd configuration was tested here.

Suggested fix belongs to R18 with R02/R04: track live SSE responses and end them during shutdown (or
register `reply.raw.on('close')` and a server-level `closeAllConnections`-style drain), then add a
bounded shutdown deadline so `app.close()` cannot wait indefinitely. R09/R11 must confirm the desktop
and mobile clients reconnect correctly after a server-initiated stream end — the clients already
implement reconnect, but that path is not covered by this probe. R19 should correct the deployment
guidance.

Owner: unassigned; proposed R18 with R02/R04/R19.

### ARC-059 — MEDIUM: a historical extraction can fail to deserialise after a UDM schema change

Storage of an extraction is a validated UDM, but the _read_ path re-parses whatever is stored with the
**current** schema. `ai/pipeline.ts:105` validates on the way in; `worker.ts:427` calls `parseUdm(udm)`
on the way out, and `review-service.ts` does the same at six read/patch sites (`:99, :125, :150, :237, :301`) — including the patch and approval paths. `parseUdm`
throws on any mismatch (`packages/shared/src/udm/schema.ts:166-176`).

So the guarantee is one-directional: nothing unvalidated gets _written_, but a row written under an
older `UDM_VERSION` is not guaranteed to be readable by a newer binary. There is a version field
(`udmVersion`) and the reader ignores it — it does not dispatch on version, migrate, or degrade.

Why it matters for an architecture review: the UDM is the interchange contract every connector and
export depends on (DEC-004), and the product stores documents that must remain reviewable and
exportable for the retention period. A schema change that tightens a field type would make older,
already-approved documents fail at read time with `Invalid UDM payload` — an upgrade hazard rather
than a present defect, and one that only appears once there are historical rows written by a previous
version.

What is _not_ claimed: no such incompatible change has been made at this baseline, no failing upgrade
was observed, and the parser's error surfaces as a safe message rather than leaking data. The
versioned schema exists and the code has not yet needed to exercise it.

Reproduce by reading the two call sites; no probe was written, because demonstrating it requires
crafting an old-schema row and asserting the reader's behaviour, which is R03's job against the real
migration policy. Suggested owner: R03 with R02/R04 — decide whether historical rows are migrated on
write, read through a version-dispatching decoder, or explicitly invalidated, and test the upgrade path
with fixture rows from the previous version. R08 should confirm the retention interaction, since an
unreadable row is still customer data.

Owner: unassigned; proposed R03 with R02/R04/R08.

### ARC-061 — MEDIUM: a single crash strands one document, and the checklist does not notice

An unfenced claim does not duplicate work — the claim guard prevents that — but it does abandon work.
A probe killed the only worker with `SIGKILL` **while it held a claim** (verifying `status = 'running'`
in the database before killing) and then started a fresh process on the same database:
11 of 12 documents completed, the twelfth stuck in `processing`, 0 jobs requeued, no duplicate audit
rows and no duplicate job rows (`two-worker-audit-9ec567c.txt`).

This is the same root cause as ARC-013 and the same mechanism as ARC-060 (whose fence is what blocks
recovery), recorded separately because it changes what the evidence means. `ARC-AC-17`'s literal pass
criterion — no double-processing, no crash, no duplicate audit rows — is **fully satisfied while a
document is lost**. A reviewer who ran only that checklist item would sign it green.

Scope: one document per interrupted claim, and only when no operator follows up. Duplication is
genuinely prevented, and the happy path is clean (12/12, no duplicates, both processes healthy), so this
is not a corrupted-data finding. It is a _silent-loss_ finding: no error, no retry, no user-visible
signal, and recovery requires database-level knowledge or the offline CLI.

Why MEDIUM rather than HIGH: the crash is a normal failure mode, but nothing is corrupted and no wrong
data is produced; the impact is one queued document per crash needing operator attention. It is a
strong argument for the lease/fencing protocol in ARC-013 rather than a separate defect to fix.

Suggested owner: R02 with R18 (recovery protocol), R04 (surface the stuck state to the user), R19
(runbook). No code was changed here.

Owner: unassigned; proposed R02/R18 with R04/R19.

### ARC-060 — LOW: recovery requires correlating a job id the product never surfaces

A worker killed mid-extraction leaves its job `running`; startup deliberately does not requeue by age,
so an operator must review and requeue or abandon it. The blocking predicate is
`claimNext`'s refusal to claim any `extract_document` job while another job for the same document is
`running` (`repositories/system-repo.ts:103-113`). A probe with two real backend subprocesses and one
synthetic SQLite file records what that means in practice (`claim-block-probe-9ec567c.txt`):

```sh
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/claim-block-probe.ts
```

- **A.** Worker killed inside OCR: 1 job left `running`.
- **B.** A second extraction job is enqueued directly for that document: `queued`, new id.
- **C/D.** A healthy worker drains once and leaves both the orphan `running` and the new job `queued`.
- **E/F.** Abandoning the orphan through the offline tool (`abandonWithAudit`) lets the new job run to
  `succeeded` on its first attempt.

**This is narrower than it first appears.** The product's own reprocess path does _not_ have this
problem: `document-service.ts:344-347` calls `jobs.hasActiveExtraction`, which counts jobs in
`queued` **or** `running`, and returns a clear 409 ("This document already has an extraction queued or
in progress"). So a reviewer using the UI is told to wait, and their request is refused rather than
silently parked — correct behaviour. The probe reached the stuck state only by enqueuing directly
through the repository, which no service does. An earlier draft of this finding called the state
silent and HIGH; that was wrong, and the correction is recorded here rather than quietly dropped.

What remains true and worth recording: the operator's recovery loop is job-id-oriented, and the
product never shows a job id. `GET /documents/:id` does not expose the interrupted claim, the offline
`worker-recovery-cli --list` is the only way to discover it, and the reprocess 409 tells the person to
wait for something that will never progress. Recovering a crashed job therefore requires database-level
knowledge (or the offline CLI) plus the recovery runbook — which `docs/worker-recovery.md` does
describe, but the in-product message points at waiting instead.

Severity LOW: no silent loss, no wrong data, a documented operator path exists, and the misleading
message is a wording/UX gap rather than a correctness defect. R02/R18 should decide whether the 409
should name the stale claim and R04 whether the document representation should expose it; R19 owns the
runbook wording. P6 remains unmet for the separate, larger reasons in ARC-013.

Owner: unassigned; proposed R02/R04 with R18/R19.
