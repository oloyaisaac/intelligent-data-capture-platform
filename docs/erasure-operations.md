# Account erasure: operation and limitations

Account erasure anonymises the user row and revokes its sessions, API keys and existing devices. It removes the database rows of identified draft documents and commits a queue of their document and page storage keys in the same transaction. After commit, deletion is attempted immediately; the maintenance scheduler retries pending keys in batches of up to 100 per run. Storage deletion must be idempotent, and keys must not be reused. A key still referenced by another document or page is retained in the queue for investigation instead of being deleted.

The API returns `200` when the identified file-deletion queue is empty, and `202` when files remain pending or their count cannot be determined. `erased: true` means that the account transaction committed, **not** that all personal information has been erased. `pendingFileCount` can be null when the count is unknown. The response is a point-in-time result, not a way to track completion after sign-out. The desktop shows this result on the sign-in screen.

## Operations

- Enable `MAINTENANCE_ENABLED` (default true) and ensure at least one backend scheduler runs. Its default interval is daily; a backlog of more than 100 can take multiple runs. Failed deletes are retried on future runs, not continuously.
- Monitor the number and age of rows in `erasure_file_deletions` and warnings named `erasure file deletion remains pending`; investigate storage permissions, provider health, and shared references. Filesystem deletion also refuses certain observed unsafe roots, symlinks, non-regular entries and hard links; see `storage-deletion-safety.md` before intervening. The queue contains sensitive storage keys and user identifiers: restrict access and do not copy keys into tickets or logs.
- After correcting the underlying issue, wait for the next maintenance run and verify the queue drains. A permanent shared-reference conflict requires human review of data retention and ownership before taking action; do not force-delete a file still needed by another record.
- Expired export files are handled separately by maintenance. A failed deletion retains the key and is retried on the next run; expired exports are not downloadable even before that retry.
- A database restore can resurrect queue entries after files were deleted, or resurrect document rows whose files are missing. A storage restore can resurrect deleted files after queue entries were cleared. Coordinate and test backup/restore procedures, including replaying erasure decisions; this queue alone is not a backup-erasure solution.

## Queue concurrency and failures

Current-version processors recheck and lock the selected queue row in a database transaction before
checking known references and deleting bytes. A competing current-version processor with the same
stale row waits, then skips it if the first committed its removal. A row whose storage key changed is
also skipped. Before deletion, the processor additionally checks for another pending erasure row
with the same key or a syntactic path alias, across users. If found, or if the bounded alias scan is
exhausted, it leaves the row pending for investigation. These conflicts may prevent both requests
from draining indefinitely; operators must assess ownership and legal obligations before any
reconciliation, rather than blindly removing queue entries. Retention purge, expired-export cleanup
and uncommitted-upload cleanup also defer when they observe a pending erasure for the key or an
alias; the erasure itself may be blocked by the document or export reference, requiring human review.
The scan may add significant database work on a large queue and is not a complete filesystem alias
check.

Failed work rolls back the queue removal and is retried; a delete may already have succeeded when a
storage or commit error is reported. Completion counts only transactions reported as committed. A
later retry therefore still requires idempotent deletion and no key reuse.

This holds a database transaction over storage I/O: PostgreSQL consumes a pool connection and locks
the row; SQLite holds its database write lock and queues operations on the same adapter. Slow or hung
storage can delay other work, and competing SQLite connections may block or time out. Monitor storage
latency, lock contention, database capacity and queue age. The lock is not a storage fencing token: a
lost database connection or stopped transaction can release it while a storage call is still in
flight. The queue-reference check is a point-in-time observation: concurrent inserts and different
queue rows are not locked together. Older processors, retention/export deletion, new references,
key reuse, external writers and filesystem races are not serialized by this lock.
Do not use it as justification to reuse keys or run mixed versions; stop and coordinate writers for
any operational reconciliation.

Focused tests cover stale same-row selection, ambiguous storage failure, exact and syntactic-alias
queue conflicts, the alias-scan limit, and conflicts with retention, export and upload cleanup. The
PostgreSQL suite also observes a competing processor waiting on the row lock. These tests use
synthetic data and do not establish production storage behavior or safety under concurrent queue
insertion, connection loss, mixed versions, restores or independent writers.

## Important boundaries

This is not a complete legal or technical erasure guarantee. Retained approved documents, audit records, exports, organisation data and their contents can still identify a person. Existing backups and copies at connectors or external destinations are not purged by this mechanism. Work already in flight during erasure (including uploads, worker extraction and pairing) is not coordinated across processes; it may create additional rows or files or credentials after the snapshot. Existing long-lived connections may also need explicit revocation. Address these races and validate the full data inventory before claiming complete erasure. Storage-key reference checks are not a cross-process lock and depend on keys never being reused. Previously orphaned blobs are not discovered automatically. Operators need alerting and an accountable follow-up process; no user-facing completion notification is implemented.
