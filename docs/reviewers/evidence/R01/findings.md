# R01 findings — interim register

**Incomplete:** this is not the full R01 review, a G1 decision or reviewer sign-off. Findings
span multiple revisions; later updates identify the relevant revision or current worktree. No named
owner has accepted these findings or provided a dated exception.

| ID      | Severity | Evidence                                                                                                                                              | Finding and impact                                                                                                                                                                                                                                                                                                                                                             | Reproduce / next action                                                                                                                                                                                                                                                                                                                                  | Owner                                             |
| ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| ARC-013 | HIGH     | `apps/backend/src/services/worker.ts:83`, `apps/backend/src/repositories/system-repo.ts` (`requeueInterrupted`)                                       | **Partially remediated:** age-only startup recovery previously reclaimed live jobs. It is removed; interrupted jobs require manual offline requeue, which cannot prove the old process is dead or prevent repeated external effects.                                                                                                                                           | The two-backend, 20-document happy path passes locally with synthetic OCR (`workers-process.test.ts`), but `worker-stale-process.test.ts` now verifies startup does not reclaim an artificially aged live claim; offline recovery still requires operator controls. Design owned leases, fencing and idempotent effects; test recovery and side effects. | Unassigned; backend architecture                  |
| ARC-014 | HIGH     | `packages/connectors/src/contract.ts:8`, `apps/backend/src/services/connector-service.ts` (`sendDocument`)                                            | **Partially remediated:** default first-party operations run in one-shot children with bounded IPC and timeouts; same-privilege children can still terminate the host or access its resources. Injected registries may run in-process. P8 remains unmet.                                                                                                                       | `connector-process-api.test.ts` verifies survival of an exiting child; `connector-process-security.test.ts` demonstrates a child can signal and kill the host. Design and verify an enforced security boundary before claiming P8.                                                                                                                       | Unassigned; backend architecture                  |
| ARC-015 | MEDIUM   | `apps/backend/src/services/container.ts`, `apps/backend/src/db/encryption-migration-cli.ts`, `apps/backend/src/ai/pipeline.ts`                        | **Partially remediated:** direct service-level repository construction was moved to the service container or offline CLI composition entry; the broader claim that all concrete adapters have a single composition root still needs examination.                                                                                                                               | `composition-boundary.test.ts` covers direct and named/namespace-aliased repository constructors in top-level service modules, not dynamic construction or all adapters. Review separate CLI and provider factories; verify transaction behavior.                                                                                                        | Unassigned; backend architecture                  |
| ARC-016 | HIGH     | `apps/backend/src/services/connector-service.ts` (`sendDocument` catch)                                                                               | **Partially remediated:** new send failures no longer store, log or return the connector exception. Existing connector-run records may still contain older raw messages and have not been remediated.                                                                                                                                                                          | `connector-throw.test.ts` fails against the old handler and passes with the new handler for secret-bearing Error, AppError and non-Error failures, including create/read/update. Assess existing data and safe remediation before closing.                                                                                                               | Unassigned; backend security                      |
| ARC-017 | HIGH     | `apps/backend/src/services/connector-service.ts` (`create`, `update`, `test`, `describeSchema`, `previewDuplicates`, `context`)                       | **Partially remediated:** validation, health, schema and preview failures use safe messages and the supplied connector logger discards untrusted text/context. Existing records, successful outputs and direct process logging are not sanitized; in-process isolation is absent.                                                                                              | `connector-boundary.test.ts` and `connector-throw.test.ts` reproduce and verify secret-bearing failures. Assess existing data, other outputs and direct logging before closing.                                                                                                                                                                          | Unassigned; backend security                      |
| ARC-018 | HIGH     | `apps/backend/src/services/document-service.ts` (`upload`), `apps/backend/test/architecture-flow.test.ts`                                             | **Partially remediated:** an idempotent upload retry previously queued an additional extraction for the existing document. Document metadata and its initial job were not committed together. The new transaction and retry path avoid this for covered sequential and concurrent requests, but file storage is outside the transaction and worker recovery is still unfenced. | Replay failed with two OCR calls before the change and passes locally afterward; `documents.test.ts` covers forced contention, enqueue failure, legacy missing job and lost commit acknowledgement. PostgreSQL CI and orphan reconciliation need verification.                                                                                           | Unassigned; backend architecture                  |
| ARC-019 | HIGH     | `apps/backend/src/services/workflow-service.ts` (`evaluate`, `approveRun`, `execute`), `apps/backend/test/workflows.test.ts`                          | **Partially remediated:** connector-send, export and notification formerly reported success without dispatch. New plans fail closed before any action; existing false-success history remains and actual delivery is still unimplemented.                                                                                                                                      | `workflows.test.ts` covers each unsupported action in automatic and approval-required mixed plans. Assess historical runs, implement real dispatch and independently verify effects and retry semantics with the R02/product owner.                                                                                                                      | Unassigned; R02 workflow/product owner            |
| ARC-020 | MEDIUM   | `AGENT_STATE.md` (historical snapshot), `DECISIONS.md` DEC-028, `apps/mobile/src/screens/PairingScreen.tsx`, `apps/desktop/src/pages/ExportsPage.tsx` | Handover and localization claims drifted: the old snapshot predates container, backup, SMTP and batch changes, while literal English strings contradict the claim that every visible string uses the catalogue.                                                                                                                                                                | Compare source examples and current CI with the historical document. A dated warning and DEC-028 note were added; full cross-document and localization review remains open.                                                                                                                                                                              | Unassigned; documentation and localization owners |
| ARC-021 | HIGH     | `apps/backend/src/services/worker.ts` (`stop`, `drain`), `apps/backend/src/index.ts` (shutdown)                                                       | **Partially remediated:** a normal SIGTERM previously exited and closed the database while an extraction was running; concurrent calls to one worker's drain could also overlap. Shutdown now waits for startup and active work and coalesces drains. Active maintenance sweeps are also awaited. No shutdown deadline or forced-kill safety is established.                   | `worker-lifecycle.test.ts` and `worker-shutdown-process.test.ts` fail on the prior worker and pass locally with this change; test uses synthetic OCR and SQLite. Design and test bounded shutdown, crashes, ownership and fencing; validate maintenance across replicas.                                                                                 | Unassigned; backend reliability                   |
| ARC-022 | HIGH     | `apps/backend/src/ai/providers/cloud.ts` (`ocr`), `apps/backend/src/config.ts`, `DEPLOYMENT.md` §10                                                   | **Not remediated:** despite the configuration name, the cloud cost setting is not a hard spend cap. The request is made before a rough token estimate is compared; it only logs a warning, absent usage becomes zero, and there is no cumulative budget or reservation. The prior implementation comment and deployment guide incorrectly claimed enforcement.                 | `ai.test.ts` demonstrates that an over-threshold response is returned and only warned after the request. Comments and operator guidance now describe the limitation; implement provider-aware pricing and pre-request budget controls, and verify billed usage before claiming enforcement.                                                              | Unassigned; AI/product and operations             |

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
reserve their generated key on a queued row before writing. A caught failure schedules cleanup when
possible, preserves an existing expiry if `markReady` may have committed, and returns a generic
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
Historical job rows, logs, delivered events and backups are not cleaned. Other services and custom
providers may still log sensitive data directly. Operators and security owners must assess prior
exposure, retention and credential rotation, and independently review the broader boundary before
closing this finding. Owner: unassigned; backend security and operations.

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

### ARC-024 update — broader reference checks and stale export metadata

A synthetic cross-tenant regression (`storage-reference-safety.test.ts`) showed that retention and
privacy erasure deleted keys still referenced by exports or template samples, and that expired-export
cleanup deleted keys referenced by other documents, pages, exports or templates. The three paths now
check those known database reference types before deleting. All statuses, including soft-deleted
rows, count as references; only the document being purged and its own pages, or the export being
expired, are excluded. Known aliases therefore block and require investigation, even when both owners
are expired. Tests use deliberately aliased database keys; they are not production incident evidence.

Expired-export metadata updates now compare the selected key, status and expiry before clearing the
key; `maintenance.test.ts` covers a concurrent replacement. This does **not** fence the storage
operation: a separate test extends an export with the same key during deletion and observes the
file gone while the changed metadata remains. The reference checks and deletes are not atomic;
new references, overwritten/reused keys, old binaries, external files and out-of-band writers can
still race. No storage-key non-reuse constraint exists. Existing files and records are not repaired,
separate retention page files remain untouched, and a database failure after a file deletion still
requires reconciliation. These checks add potentially unindexed cross-table lookups per file; assess
query plans and sweep cost on representative data before production rollout. ARC-024 and P6 remain
open; the owner must design durable, fenced storage lifecycle and recovery semantics.

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
potential exposure paths. Independent security review and P8 remain open.

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
