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
