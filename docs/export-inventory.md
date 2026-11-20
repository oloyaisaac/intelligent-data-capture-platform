# Offline export-file inventory — read-only investigation

This tool helps an authorized operator investigate interrupted and historical export records. It
**does not reconcile, delete, restore, adopt, expire or repair anything** and its output is not proof
of erasure or of file ownership. An export file can remain even if a record is failed, expired or
has no storage key. Conversely, a queued writer may still be alive. `--confirm-offline` is an
operator assertion, not a lock or process-liveness test. ARC-024 and ARC-026 remain open.

## Before inspection

1. Identify the approved environment, owner and incident scope. Stop all API, worker and maintenance
   processes that can write to this database or storage, including old binaries and replicas, and
   disable restarts. Confirm no orphaned process can resume. Stop other storage/database writers.
   These controls must remain in place throughout inventory; the tool cannot enforce them.
2. Take and verify an appropriate backup using the deployment's authorized procedure. Respect legal
   holds and retention obligations; obtain an owner decision before any later repair or deletion.
3. Set the application's database configuration and the actual trusted `STORAGE_PATH` to inspect.
   Resolve it relative to the working directory of the command, not the browser or container host.
   Validate the mount and all root ancestors: this tool does not verify that the selected database
   and filesystem belong to the same deployment. Restrict access to both; read-only PostgreSQL
   credentials are recommended. The tool opens SQLite read-only and does not apply migrations;
   SQLite may nevertheless require or create WAL shared-memory sidecars. PostgreSQL uses a read-only
   session and issues only queries. A storage or database snapshot is not taken.

## Commands

From the backend workspace, in the same configured environment:

```sh
npm run db:export-inventory -- --list --confirm-offline
npm run db:export-inventory -- --list --after LAST_ID --confirm-offline
npm run db:export-inventory -- --inspect EXPORT_ID --confirm-offline
```

A packaged backend or container can run `node dist/export-inventory.js` with the same arguments.
List returns up to 100 exports ordered by ID; use `nextAfter` from the previous response as `LAST_ID`
until it is null. Inspect one actual ID from that list. IDs, organisation IDs, timestamps and key
fingerprints are sensitive operational data; protect output, terminal history and incident records.
The tool does not print filter contents, file contents, raw storage keys or connection strings. Key
hashes are not secrets protection: predictable keys can be guessed. Do not paste reports or secrets
into public R01 evidence. Exit 0 means a query completed, 1 means invalid arguments/configuration or
an error, and 2 means the requested export was not found. A completed query does not prove safety.

## Interpreting an inspection

For an existing row, `stored` describes its recorded key when present. `canonicalCandidate` is the
key this repository's export writer would generate from the row's organisation, export ID and CSV
or XLSX format. It is included even if no key was recorded, to help investigate a possible legacy
partial write. A candidate is **not** proof that a file belongs to that export; older versions,
manual writes, changed keys, collisions or reuse can invalidate the inference. Two observations can
have the same hash. Unknown formats have no canonical candidate.

`file` is `present` for a regular filesystem entry, `missing` when a key component is absent under
an accessible directory root, and `unverifiable` for invalid keys, missing/inaccessible roots,
symlinks, non-files or other errors. These are point-in-time filesystem metadata observations, not
content checks, ownership checks or secure deletion verification. Symlinks at or below the root are
not followed, but ancestor symlinks, hard links and concurrent replacement remain possible. Errors
or an incorrect mount can mislead even when a name is missing. The tool does not inspect backups,
logs, replicas, other storage backends or arbitrary files without an export row.

`referencedElsewhere` checks known document, page, export and template-sample references across
organisations, including deleted/inactive rows, excluding only the inspected export. `pendingErasure`
checks the privacy file queue. A false result is not proof of no reference: it omits external copies,
unknown database tables and out-of-band writers, and the check is not atomic with later actions.
The inventory can miss files whose export rows were removed and objects at noncanonical unknown keys.
It makes potentially unindexed cross-table queries; assess load and use a suitable maintenance window.

Use the results only to direct a separately authorized investigation. Do not automatically delete a
file, mark a record expired or resume writers based on these observations. A safe reconciliation
plan must address live and old writers, reference and key-reuse races, legal retention, backups,
external copies and verification. Record the real decision and outcome in a protected operational
system. Independent architect sign-off and production migration/reconciliation evidence remain
separate requirements.
