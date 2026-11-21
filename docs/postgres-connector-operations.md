# PostgreSQL destination connector: transaction and schema boundaries

Each current-version PostgreSQL connector operation checks out one database client and releases it
when the operation finishes. Multi-record create and update issue `BEGIN`, all record statements and
`COMMIT` or `ROLLBACK` on that same client. The schema-description query resolves the unqualified
table through the connection's PostgreSQL `search_path`, then only returns information-schema
columns for that resolved relation; it no longer combines same-named tables from other schemas.
The database role's own privileges and current schema/search path still govern access. A missing or
inaccessible table can yield an empty description; schema inspection and later writes use separate
connections and can race schema changes or configuration changes.

Older versions used `Pool.query` for each statement, which does not promise the same client remains
checked out for a transaction. A connection change or loss can invalidate the intended transaction
boundary; assess potentially affected historical writes using an authorized destination-side review.
No actual production history was inspected and no historical data was repaired by this change.
Existing mappings made from same-named tables across schemas may also need review. Do not assume the
connector's prior successful or failed responses prove the destination's current state.

A single connection is not exactly-once delivery. The process can die, the network can fail, the
server can commit and the acknowledgement be lost, or cleanup can fail after commit. A failure or
timeout therefore does **not** prove a write was rolled back; inspect the destination before retrying.
Transactions do not roll back external effects of triggers or extensions, and target schema changes,
other writers, old binaries, backups and out-of-band operations are outside this check. No provider
idempotency protocol or production destination validation is implied. MySQL uses a single connection,
but whether its transaction is atomic depends on the destination storage engine and other destination
behavior. Both database connectors can reach internal network hosts; they are not a sandbox or an
SSRF boundary. See `connector-process.md`, `connector-network-security.md` and R01 evidence.
