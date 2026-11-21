# Offline filesystem inventory — read-only investigation

This command helps an authorized operator discover files in one organisation's current-layout
`documents`, `exports` or `pages` directory, including files for which there is no corresponding
known database reference. It can also list recorded document, page, export and template-sample
keys and observe whether their files are present, missing or unverifiable. It **does not delete,
reconcile, restore, adopt, expire or repair** any file or row. An apparently unreferenced file is **not** proof that it is an orphan or that deletion
is safe. R01 ARC-018, ARC-024 and ARC-026 remain open.

## Before inventory

1. Obtain approval from the data owner and incident/security team, identify the exact environment
   and scope, and respect legal holds and retention obligations. Stop all API, worker, maintenance,
   old-version, replica and external database/storage writers and disable restarts throughout the
   inventory and any subsequent investigation. `--confirm-offline` is an operator assertion, not a
   process or liveness check. This tool does not fence writers or take a consistent snapshot.
2. Take and verify an appropriate protected backup. Set the correct `DB_DRIVER`, database settings
   and trusted `STORAGE_PATH`. Verify the actual database, mount, storage root and all root ancestors
   belong to the same deployment. The command cannot verify these. It does not apply migrations.
   PostgreSQL uses a read-only session; use a restricted read-only role. SQLite must be an existing
   persistent database; the read-only connection may require or create WAL shared-memory sidecars.
3. **Output contains raw storage keys and filenames.** They may identify organisations or people or
   contain sensitive legacy text. `--confirm-sensitive-output` acknowledges this; it does not protect
   the output. Restrict terminal, process arguments, shell history, redirected files and incident
   records. Do not put raw output, identifiers or paths in public evidence. Never use untrusted data
   as command arguments without separate review.

## Commands

From a packaged backend or container, using an actual, approved organisation ID and kind:

```sh
node dist/storage-inventory.js --list --organisation ORG_ID --kind documents --confirm-offline --confirm-sensitive-output
node dist/storage-inventory.js --list --organisation ORG_ID --kind documents --after LAST_FILENAME --confirm-offline --confirm-sensitive-output
node dist/storage-inventory.js --references --organisation ORG_ID --kind documents --confirm-offline --confirm-sensitive-output
node dist/storage-inventory.js --references --organisation ORG_ID --kind documents --after LAST_RECORD_ID --confirm-offline --confirm-sensitive-output
```

For `--list`, `--kind` accepts `documents`, `exports` or `pages`; `--references` also accepts
`templates`. From a checkout, replace the `node` command with
`npm run db:storage-inventory --workspace=@idcp/backend --`. Flags and their order are
required. The organisation ID and cursor must be simple ASCII path components starting with a
letter or digit, containing only letters, digits, `_`, `-` and `.`, without `..`, and at most 255
characters. Only scan operator-approved identifiers. The command does not enumerate organisations;
use an authorized separate inventory, including consideration of deleted organisations.

Each `--list` response contains up to 25 eligible directory entries sorted by filename. If
`nextAfter` is non-null, use it as `LAST_FILENAME` and repeat until null with all writers still stopped. Each page
rescans the entire directory; it refuses a directory over 100,000 entries rather than silently
returning a partial page. The limit bounds per-page enumeration, not total cost across pages. Each
regular entry triggers known-reference and erasure-queue queries, including potentially unindexed
cross-table alias scans. Test query plans, elapsed time and database load on a representative
protected copy before running in production. Exit 0 means a command completed, not that its scope or
results are complete or safe to delete; exit 1 means invalid arguments or a generic failure.

For `--references`, each page returns up to 25 non-null recorded keys ordered by record ID. Continue
with its `nextAfter` as `LAST_RECORD_ID` until null; this is a record ID, **not** the filename cursor
used by `--list`. If a legacy ID does not satisfy the command's cursor syntax, stop and investigate
separately; do not claim complete coverage. Document and page rows include soft-deleted documents.
Exports without a stored key and templates without a sample key are omitted; use the separate export
inventory for legacy candidate keys. Database and filesystem state must remain offline and stable
between pages. The command does not verify that the organisation exists; an empty page can mean a
wrong or deleted organisation ID. A zero count does not cover other organisations, tables, or
historical copies.

## Interpreting observations

For `--references`, `file` is `present`, `missing` or `unverifiable` based on metadata, not content
or ownership. The `documentHasDeletedAt` flag is the parent document's `deleted_at` presence for a
document/page, and null for exports/templates; it does not by itself establish deletion or retention
eligibility. Invalid paths, symlinks, non-files and I/O errors are `unverifiable`. Root ancestors,
mount identity, hard links and concurrent replacement remain outside this check. No repair or
conclusion about the authoritative copy follows from a missing file.

For `--list`:

- `directory: missing` means a checked component below an accessible root was absent at that instant.
  It is not proof that a database reference has no file, that the correct mount was selected, or that
  files are absent elsewhere. `directory: present` is likewise only a point-in-time observation.
- `unsupportedNames` counts entries whose names cannot be passed safely as canonical keys. These
  entries are **not** returned individually; even with `nextAfter: null`, a nonzero count means they
  require separate investigation. The count is repeated on each page, not a page total to sum.
- `file: regular` reflects `lstat` at one moment; `hardlinkCount` is the observed link count, not a
  list of aliases. `file: unverifiable` covers symlinks, directories, special files, vanished or
  inaccessible entries. It has null reference/erasure observations and must not be treated as
  absent or unreferenced. This command does not descend into subdirectories or follow symlinks.
- `referenceMayExist` checks known document, page, export and template sample keys across all
  organisations, including soft-deleted/inactive rows, and certain syntactic aliases. `true` can also
  mean alias scanning hit its 1,024-candidate safety bound or a key was unsafe. `false` is **not**
  proof of no reference: unknown tables, external copies, symlink/hardlink aliases, case-insensitive
  or Unicode aliases, old binaries and later writes are outside that check.
- `pendingErasureMayExist` checks the privacy queue for exact and certain syntactic key aliases.
  `true` also covers unsafe keys or reaching the 1,024-candidate scan bound; it need not mean a
  matching queue entry exists. `false` does **not** rule out filesystem aliases, external erasure
  obligations or later queue changes. Do not treat it as authorization to retain or delete a file.

All metadata and database checks are separate and can race. Symlinks at or below the selected root
are rejected when observed, but root ancestors, hard links, filesystem mount behavior and concurrent
replacement remain outside the guarantee; the command is not a filesystem security sandbox. It does
not inspect file contents, arbitrary layouts, nested directories, other backends, backups, logs,
replicas or files outside the chosen scope. A key can have been reused, partially written or owned
by another process. Never delete based solely on age, a false reference result, or this inventory.
Any action needs a separately authorized reconciliation plan covering all writers, references,
recovery, legal holds, backups and verification. See `docs/export-inventory.md` for the complementary
export-row inventory and the R01 evidence for unresolved limitations.
