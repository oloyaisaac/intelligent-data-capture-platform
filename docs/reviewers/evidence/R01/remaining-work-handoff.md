# R01 remaining work — engineering handoff, not approval

R01 is **not complete or passed**. This note identifies work still requiring implementation,
operational evidence and independent review. It is not a substitute for the checklist in
`docs/reviewers/R01-software-architect.md`; unlisted checklist items must also be answered. No owner,
exception, production execution, reviewer or approval is implied by this note. For an item-by-item
inventory of all twelve passing conditions, currently recorded findings and required runtime evidence,
see `completion-status.md`.

## P6 — recovery and duplicate work

Age-only automatic startup recovery has been removed. The deliberately offline, per-attempt command
in `docs/worker-recovery.md` supports audited requeue or reviewed abandonment without retry. The
unaudited repository requeue helper was removed. These remain availability and operational trade-offs,
not an ownership lease or a guarantee against duplicated OCR, billing, file deletion or other side
effects. Older versions can still reclaim live jobs, and abandonment cannot stop an active worker.
Current-version retention workers lock and recheck the claim during each destructive transaction,
but already-started deletion, storage/database ambiguity and old workers remain unresolved. The technical owner must decide an ownership, fencing, retry and deployment
protocol, including what guarantees are possible for external providers. Test both supported
databases with real separate processes at claim, failure, recovery, concurrent work, stale resume,
publication and external-effect boundaries. Cover conflicting distinct jobs, purge and review as
well as the same-claim publication guard. Establish operational detection and bounded shutdown.
See `worker-recovery-design.md` and findings ARC-013/ARC-021. A happy-path 20-document test and the
new narrow SQLite live-claim regression do not by themselves satisfy P6. ARC-024 additionally
records incomplete retention deletion: primary file failures are now retried instead of silently
reported as purged. A successful conditional retention metadata soft-delete and its per-document
purge audit now commit together; storage deletion remains outside that transaction and retries depend
on idempotent delete. Prior soft-deleted files, separate pages and retained/derived rows require a
designed and authorized reconciliation and deletion strategy. Known cross-table storage references
now block retention, erasure-file and expired-export deletion, and stale export metadata updates are
conditional. Neither change fences file deletion or enforces key non-reuse; test and design for
concurrent references, changed exports and mixed versions. Measure cross-table scan costs and plan
indexing with a safe deployment strategy. ARC-026 adds an export key reservation before file writes;
ambiguous reservation, collision and failed writes are now left for investigation rather than
scheduled for deletion, while failures after confirmed writes may be marked failed for expiry.
Interrupted and queued exports still need detection and authorized offline reconciliation. Historical orphans, publication and
external-effect races are not repaired; age alone cannot establish that a writer is dead. The
read-only `docs/export-inventory.md` tool assists offline investigation only; it does not reconcile,
delete or prove that a candidate belongs to an export, and cannot find files with no export row.

## P8 — connector isolation

The default first-party registry runs validation, health, schema, duplicate preview and writes in
one-shot child processes. `connector-process-api.test.ts` covers a fatal child without killing the
API, but `connector-process-security.test.ts` demonstrates that the same-privilege child can signal
and terminate its host. Explicitly injected registries can still run in-process;
`connector-fatal-process.test.ts` demonstrates that path. These controls are not a sandbox. An implementer and security owner
need to choose and verify a separately enforced runtime boundary. At minimum, the design must address:

- fault containment for every connector entry point, including synchronous validation; bounded
  request/response sizes, timeouts, child cleanup and caller-visible safe errors;
- CPU, memory, process and concurrency limits; `process.exit`, hangs, malformed replies and abrupt
  termination; preventing connector code from killing or exhausting the API host;
- no inherited backend/database/signing secrets or broad filesystem access; authenticated,
  tenant-scoped request context and only the destination credentials required for the operation;
- enforced network egress controls for HTTP **and** database connectors, DNS rebinding/redirect
  handling, and an explicit capability/mount strategy for CSV and SQLite destinations;
- logging, diagnostics and response validation without leaking credentials or documents, plus
  duplicate/partial remote-write semantics when an invocation times out or dies;
- deployment, upgrade, compatibility and rollback behavior across supported platforms.

A same-privilege subprocess or worker thread alone is not a security sandbox. Prove controls using
adversarial integration tests in the actual supported deployment environment, not only mocks.
The subprocess implementation is only a partial mitigation; there is no approved security sandbox in this handoff.

## P5, P7 and the rest of the architecture review

The layer map, dependency scan, ADR register and drift notes are working evidence, not complete
independent validation. `services/container.ts` composes most services; `index.ts`, `db/index.ts`,
HTTP assembly and offline CLI entry points also construct or select adapters. The new worker recovery
CLI is another offline composition entry. The reviewer must decide whether the literal P5 requirement
can be met or needs an authorized exception; no such exception is recorded. Review remaining modules,
dynamic imports, all process-local state and all runtime exercises against the actual checklist,
complete the canonical evidence and assign named owners to findings. High findings require closure
or written, dated owner exceptions under P12. ARC-025 requires assessment of previously persisted
worker errors, logs and events, plus broader verification of sensitive-data logging; the new generic
worker failure messages do not clean historical copies or constrain arbitrary provider logging.

## Production migration evidence

No production database, credentials, backup or deployment has been accessed or migrated as part of
this review. The authorized deployment operator must follow `docs/connector-config-migration.md`
and `docs/encryption-key-migration.md` as applicable, including stopping writers, verifying backup and
restore, target keys, migration and target-only verification, deployment compatibility and rollback.
Record the actual environment, reviewed commit/artifact, operator, timing, non-secret command
results, verification counts and incident/credential-rotation decisions in an appropriately protected
operational record. Do not paste secrets, connection strings or customer data into review evidence.
Synthetic SQLite tests and PostgreSQL CI do not establish a production rollout or sanitize old
backups, WAL, logs or historical data.

## Independent reviewer

Once engineering and operational evidence is ready, an independent qualified software architect
must inspect the actual reviewed commit, execute or verify the required R01 checks, assess every
passing condition and finding/exception, and record their own named, dated decision in the specified
review artefact. That person's decision cannot be delegated to the author of these changes or
pre-filled here. G1/G8 remain unsigned until the required people actually review and decide.

### Batch and runtime error disclosure (ARC-028 / ARC-025)

New batch failures use fixed messages and API/CSV reads mask arbitrary historical batch error text.
Historical rows and copies still contain their original values and require an authorized exposure
assessment and remediation. `docs/batch-error-remediation.md` describes a scoped, audited offline
per-batch remediation tool with an organisation-level inventory; it has not been run on production
and does not discover all organisations or clean historical copies. Other provider, runtime and
registry error boundaries were narrowed;
they do not establish that every application or third-party log and output is safe. See `findings.md`.

### Cloud cost controls (ARC-022)

Per-document and lifetime per-organisation current-version remote OCR reservations and configurable
count limits now bound calls on the guarded worker path; zero blocks new reservations. The default
organisation cap is 10,000 since migration and has no automatic reset. This does not bound the price
of one call, organisation-wide spend, provider-internal retries, new organisations, old/direct writers,
prior calls or rollback to a backup. A crash or ambiguous commit consumes a slot in each counter.
Operators need provider-side budgets, verified billing, consistent deployments, capacity monitoring
and a reviewed response to exhausted limits; see `DEPLOYMENT.md`. ARC-022 and independent review
remain open.
