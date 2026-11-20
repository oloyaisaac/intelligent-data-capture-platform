# R01 worker recovery — open design work

This is an engineering proposal, not an approved design, complete implementation, or G1 sign-off.
See ARC-013 and ARC-021 in `findings.md`. P6 remains unmet.

## Observed failure boundary

`claimNext` atomically claims a queued job and increments its attempt. Previously startup requeued
claims based only on age, unable to tell a live worker from a dead one. Startup no longer does so:
crashed claims remain running until individually reviewed and requeued with all workers stopped
(`docs/worker-recovery.md`). This operational mitigation sacrifices automatic availability and
cannot prevent an incorrect operator decision or repeated external effects. The extraction start validates the
attempt under a job lock; the publication transaction guards job success and commits page text,
extraction, field and final document status together. Guarded final failure and document status also
commit together. Reprocess requests now lock the document, reject active extraction jobs, and
reserve the document, enqueue the job and audit atomically. A synthetic recovery regression that previously produced two
extractions now commits one, but still performs two OCR calls. OCR, billing, notifications and
retention purge are outside this publication transaction. The current claim code also serializes
new claims for distinct extraction jobs on the same existing document: it locks the candidate job
then the document and rechecks for a running extraction. SQLite uses its immediate write transaction;
PostgreSQL uses row locks and skips locked candidates. A blocked duplicate remains queued without
consuming an attempt, and unrelated runnable jobs can proceed. This assumes all workers use the
new protocol, the document exists, and the database is using its normal read-committed isolation;
it cannot repair already overlapping running jobs, stop an old worker, or enforce behavior of
out-of-band writers. Contending candidates may cause a poll to return no work until the next poll.
Concurrent review/reprocess interactions, ambiguous commit acknowledgement, process crashes and
overlapping deployments require further analysis and testing. The supported
single-worker topology reduces overlap but does not prove idempotence. A jobless document stranded
in `queued` or `processing` can now be explicitly reprocessed: the document lock serializes
concurrent requests, and the active-job check prevents re-enqueueing if work already exists. This
is not automatic crash recovery: jobs still marked `running` are considered active even if their
worker died, and old-binary or out-of-band writers that ignore the lock are not covered.

`worker-crash-process.test.ts` kills a real worker subprocess with SIGKILL after it enters the
SQLite publication transaction, then checks that page text, extraction and final status rolled
back. Startup leaves the interrupted claim running even after its timestamp is artificially aged;
the test explicitly requeues the attempt after the killed process exits. This covers one controlled
crash point and a synthetic OCR provider, not production operator controls, PostgreSQL process
crashes, external OCR cost, event
persistence or all possible crash boundaries.

## Necessary design decisions before claiming P6

1. Define a durable claim identity, owner and monotonic fencing token; specify renewal, expiry,
   clock/DB-time assumptions, deployment overlap, startup and recurring recovery. A timeout or
   heartbeat alone cannot stop an old worker resuming after expiry.
2. Specify a transactional completion boundary. A conditional job-row check must be tied to the
   same database transaction as page, extraction, field, document and final-job state changes;
   row locking/order and stale-claim behavior need explicit SQLite and PostgreSQL designs. Respect
   review/approval and erasure races. Define which data is authoritative after partial failure.
3. OCR calls and other external effects cannot be rolled back with SQL. Define provider-supported
   idempotency keys or an explicit at-least-once/billing model; use an outbox or equivalent for
   durable notifications and connector effects. A fence checked only before an HTTP request does
   not prevent a paused process from sending after losing ownership. Purge/file deletion must have
   independently justified idempotence and protect retained/reused keys.
4. Plan schema migration, rolling upgrade behavior with old binaries, operational detection and
   cleanup of abandoned claims, per-attempt cost accounting, and a documented unsupported or
   fail-closed path when a required guarantee cannot be met.
5. Exercise both database drivers with deliberate barriers at claim, lease renewal, recovery,
   commit, review and side effects. Include separate processes, long live work, lost database
   connection, hard kill at each boundary, restart before and after grace, stale resume after
   reclaim, concurrent review, retry and duplicate external delivery. Assert actual durable effects,
   not just job status; run on real PostgreSQL CI and inspect limitations of any fake provider.

A named technical owner must choose and review the design, and evidence must demonstrate the stated
semantics. None of the above constitutes an owner-approved exception or independent reviewer sign-off.

## Two-process active-claim reproduction

`worker-stale-process.test.ts` uses two actual SQLite worker subprocesses and a paused synthetic OCR
provider. After the test artificially ages the first process's still-running job, the second worker's
startup formerly reclaimed it and performed OCR, causing two OCR calls and attempts. With age-only
recovery removed, the second worker no longer reclaims the claim; after the first resumes, the test
observes one extraction and one attempt. This focused safety regression does not establish safe
manual recovery, multi-worker operation, PostgreSQL behavior, real-provider billing, or general
crash safety. Running an old binary or requeueing a live job manually still bypasses the mitigation.
The same two-process test now also queues a distinct extraction for the document while the first OCR
is paused and confirms the second process leaves it queued with zero attempts. A separate in-process
worker test confirms one synthetic OCR and extraction, eventual duplicate-job completion after the
first publishes, and progress for an unrelated job. A PostgreSQL row-lock/barrier regression is
included for CI; neither test establishes production safety or exactly-once provider calls.

Review actions remain a separate unresolved race: approval, rejection and corrections currently use
multiple independent writes without the reprocess document lock and can refer to an old extraction
while reprocessing is queued or running. `review-reprocess-risk.test.ts` is a characterization of a
defect, not an acceptance test: it opens an old review, starts reprocessing and pauses synthetic OCR,
then rejects the old review. The API currently accepts the rejection, sets the document to failed,
and the resumed job is marked succeeded without publishing the new extraction. The serialization
above does not make review actions atomic or prevent stale decisions from changing document state.
A complete fix needs agreed version and review lifecycle semantics, transactional locking and race
tests on both databases; do not treat P6 as passed.
