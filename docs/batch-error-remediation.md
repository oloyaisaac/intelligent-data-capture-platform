# Offline batch error remediation (ARC-028)

Older versions stored arbitrary upload exception text in `batch_items.error`. It may contain secrets,
paths or document data. Current API and CSV responses mask unrecognized values, but the original
text remains in the database. This tool can replace those values in **one explicitly selected batch**
with a fixed generic failure message. It is not an exposure assessment or a complete erasure tool.
No customer data is changed automatically or by applying schema migrations.

## Safety and prerequisites

1. An authorized incident/security and data owner must decide whether to preserve or remediate the
   original diagnostic information, assess legal holds and retention, and select each batch and its
   organisation. This operation discards potentially useful evidence from the live row. The tool does
   not authenticate its operator or verify authorization; operator/incident references are assertions.
   Never enter secrets, names of customers, exception text or other sensitive data in arguments or
   reference fields: references are retained in an audit entry and shell/process history may be visible.
2. Stop **all** API, batch and other database writers, including old versions, replicas and external
   scripts, and disable automatic restarts through check, apply and final verification. The flag
   `--confirm-offline` is an assertion, not a process check or fence. Old writers can reintroduce
   arbitrary error text after remediation. Check the exact database/environment and verify that each
   batch ID belongs to the intended organisation before applying. Obtain organisation IDs from an
   authorized, separately protected inventory; the tool does not enumerate organisations or databases.
3. Before changing data, take an encrypted consistent backup and test restoration under the approved
   incident plan. Treat that backup as sensitive and handle it under retention, access and legal-hold
   rules. A restore can reintroduce the old error values; restoring also risks losing later writes.
   SQLite WAL, PostgreSQL WAL, replicas, snapshots, exports, application logs, client downloads and
   backups can retain earlier values. Replacing live rows is **not secure deletion** or proof of
   absence from other copies. Review exposure, rotate affected credentials if appropriate and follow
   authorized retention and incident procedures for each copy.
4. Apply schema migrations separately and set the target database configuration (`DB_DRIVER` and
   `DATABASE_URL`, or an existing persistent `SQLITE_PATH`) and application configuration via secure
   injection. This tool does not migrate schemas. For PostgreSQL, use an appropriately restricted
   role; `--list` and `--check` set the session read-only, while `--apply` requires SELECT/UPDATE on
   the batch tables, row-lock privileges, and INSERT into `audit_logs`. SQLite list/check open read-only but
   WAL shared-memory sidecars may be created or required. The apply connection enables WAL and uses
   an immediate write transaction. Protect database logs, SQL tracing and operator output as sensitive.

## Commands

In a packaged backend image, run these with actual, non-secret identifiers (the order is required):

```sh
node dist/batch-error-remediation.js --list --organisation ORG_ID --confirm-offline
node dist/batch-error-remediation.js --list --organisation ORG_ID --after LAST_BATCH_ID --confirm-offline
node dist/batch-error-remediation.js --check --organisation ORG_ID --batch BATCH_ID --confirm-offline
node dist/batch-error-remediation.js --apply --organisation ORG_ID --batch BATCH_ID --operator OPERATOR_REF --incident INCIDENT_REF --confirm-offline --confirm-loss-reviewed
node dist/batch-error-remediation.js --check --organisation ORG_ID --batch BATCH_ID --confirm-offline
```

From a checkout, substitute `npm run db:batch-errors --workspace=@idcp/backend --` for the `node`
command. `--list` pages through up to 100 batches with eligible errors for one organisation, returning
only batch IDs and counts. Continue using `nextAfter` until null, keeping writers offline. Record the
IDs securely, then review and process each batch. After remediation, list again from the beginning;
a changing dataset or a failed/interrupted page does not prove the inventory was complete. Batch and
organisation IDs and cursors must match the command's restricted identifier syntax; if historical
IDs cannot be passed, stop and investigate separately instead of assuming they were checked. The
list query can scan many rows despite its output limit; assess load and query plans first.

`--check` returns `found` and an `eligible` count for exactly that organisation/batch. Neither list
nor check selects or prints error text. Exit 2 means the scoped batch was not found; exit 1 means
invalid arguments or a generic failure. Exit 0 means the command completed, **not** that every batch
or historical copy is clean. `--check` can return exit 0 with a nonzero eligible count.

`--apply` selects at most 100 eligible item IDs and replaces each still-eligible value with the
application-owned generic message. Null, empty and the four exact application-owned safe messages
are left unchanged. Eligibility is text-based, not a classification of whether a value is actually
sensitive. A batch may require multiple `--apply` calls while `remaining` is true; always run a final
`--check` while still offline. IDs, counts and audit references are operationally sensitive. Do not
put them in public evidence.

Each nonempty page commits the replacements and one append-only `batch.errors_remediated_offline`
audit entry together. Its metadata records the count and supplied operator/incident references, not
original text or individual item IDs. A failed audit causes a rollback. On an ambiguous commit or a
crash, inspect the scoped batch count and its audit trail before deciding whether to repeat: each
command processes whatever is still eligible, and repeating after success makes no additional change.
Locks and conditional updates reduce current-version contention but do not replace the offline
requirement or prevent other writers after the transaction. Test timing and database load on a
representative protected copy before deployment.

A zero result covers only this field of this batch at that moment. Review other batches and tables,
including historical worker and connector errors, as separate work. The tool does not inspect outputs,
filenames, logs, backups or external systems and does not establish R01 completion.
