# R01 worker recovery — open design work

This is an engineering proposal, not an approved design, complete implementation, or G1 sign-off.
See ARC-013 and ARC-021 in `findings.md`. P6 remains unmet.

## Observed failure boundary

`claimNext` atomically claims a queued job and increments its attempt. At startup,
`requeueStale` uses only claim age; it cannot tell a long-running live worker from a dead one.
A recent crashed claim is not revisited in the same process. The extraction start validates the
attempt under a job lock; the publication transaction guards job success and commits page text,
extraction, field and final document status together. Guarded final failure and document status also
commit together. Reprocess requests now lock the document, reject active extraction jobs, and
reserve the document, enqueue the job and audit atomically. A synthetic recovery regression that previously produced two
extractions now commits one, but still performs two OCR calls. OCR, billing, notifications and
retention purge are outside this publication transaction. Existing or externally inserted distinct
jobs for a document, concurrent review/reprocess interactions, ambiguous commit acknowledgement,
process crashes and overlapping deployments require further analysis and testing. The supported
single-worker topology reduces overlap but does not prove idempotence. A jobless document stranded
in `queued` or `processing` can now be explicitly reprocessed: the document lock serializes
concurrent requests, and the active-job check prevents re-enqueueing if work already exists. This
is not automatic crash recovery: jobs still marked `running` are considered active even if their
worker died, and old-binary or out-of-band writers that ignore the lock are not covered.

`worker-crash-process.test.ts` kills a real worker subprocess with SIGKILL after it enters the
SQLite publication transaction, then checks that page text, extraction and final status rolled
back. A fresh startup leaves the interrupted claim running; the test artificially ages its timestamp
and restarts again to recover it. This covers one controlled crash point and a synthetic OCR
provider, not real elapsed-time recovery, PostgreSQL process crashes, external OCR cost, event
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
startup recovery reclaims it and performs OCR; resuming the first produces no second durable
extraction due to the publication guard, but two OCR calls and attempts occurred. This is a
characterization of unsafe recovery, not a safety test or a PostgreSQL/real-provider result. It does
not prove real wall-clock expiry, billing behavior or general crash safety.
