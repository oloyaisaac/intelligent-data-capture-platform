# Offline SQLite and filesystem backup/restore

This tool is for the **single-host SQLite + filesystem** deployment only. It does not back up or
restore PostgreSQL, Compose volumes, S3, configuration, marketplace signing keys, or external
systems. For PostgreSQL use a tested database-specific backup/PITR and a coordinated document-volume
snapshot; stopping writes while taking both is the simplest consistency boundary. Follow your host
provider's procedures and test recovery separately. No production backup or restore has been run by
this repository's tests.

## Before running

- Use Node 22.16 or newer (with `node:sqlite` and its backup API); the same code release and schema
  should be available for the restore rehearsal. Run commands from the repository root.
- **Stop the API, worker, maintenance tasks, all replicas and every other writer** to the database
  and storage for the entire backup or cutover. Wait for in-flight work to finish. `--confirm-offline`
  is an operator attestation, not an automatic lock or a check that processes are stopped. A live
  SQLite snapshot alone does not coordinate files with database transactions.
- Identify the real persistent `SQLITE_PATH` and `STORAGE_PATH`. Both must exist; the database must
  be a persistent IDCP SQLite database and outside the storage tree. The tool rejects symlinks and
  storage names outside the app's key format. Use a dedicated, access-controlled backup location
  outside the source tree, repository, and any served directory. Output must not already exist and
  its parent must already exist. Protect the source and target from concurrent changes by other
  users/processes; this tool is not designed to defend against hostile local filesystem races.
- Ensure sufficient space for a complete copy. Backups contain sensitive personal data, password
  hashes and encrypted credentials. Directory/file modes are restrictive on POSIX, but **the backup
  is not encrypted**. Encrypt storage and transport separately, restrict and audit access, and keep
  independent encrypted off-host copies. Hashes detect accidental corruption, not malicious rewriting
  of both data and manifest; authenticate backups separately.
- Securely escrow the matching `ENCRYPTION_KEY`, any legacy JWT key still needed for unmigrated
  records, and other configuration/secrets **separately**. Never put them in the backup directory or
  source control. Restore with matching keys; new keys cannot decrypt old ciphertext. Plan for token
  and secret rotation after a compromise. Restoring old backups can reintroduce erased records and
  files: reconcile deletion requests and follow the retention/legal policy before reopening service.

## Create and verify

With the service stopped, substitute absolute paths for your own installation:

```sh
node scripts/sqlite-backup.mjs create --confirm-offline \
  --database /srv/idcp/idcp.db --storage /srv/idcp/documents \
  --output /secure-backups/idcp-2026-11-17
node scripts/sqlite-backup.mjs verify --input /secure-backups/idcp-2026-11-17
```

The SQLite backup API captures committed WAL data into `database.sqlite`; the snapshot is converted
to a standalone rollback-journal database. `documents/` contains copied storage files and
`manifest.json` records their SHA-256 hashes. Creation checks SQLite `quick_check` and the presence
of `schema_migrations`; verification compares all file hashes and checks the database again. These
checks do **not** prove all referenced files were present at backup time, that migrations or keys
are correct, or that a backup is recoverable at the application level. Empty storage directories are
not preserved. An interrupted operation can leave an incomplete output directory; never use it
without successful `verify`, and manually remove it only after confirming its identity. The tool
cleans up output on ordinary errors and never overwrites an existing destination.

## Restore rehearsal and cutover

1. On an isolated host, obtain an authenticated copy of the backup and the matching secrets. Verify
   it, then restore into a **new** directory (never directly over live data):

   ```sh
   node scripts/sqlite-backup.mjs verify --input /secure-backups/idcp-2026-11-17
   node scripts/sqlite-backup.mjs restore --confirm-offline \
     --input /secure-backups/idcp-2026-11-17 --output /srv/idcp-restore
   ```

2. Configure the isolated application with `SQLITE_PATH=/srv/idcp-restore/database.sqlite` and
   `STORAGE_PATH=/srv/idcp-restore/documents`, using the matching encryption/JWT keys and a compatible
   app release. Set `WORKER_ENABLED=false`, `MAINTENANCE_ENABLED=false` and `MAIL_TRANSPORT=disabled`;
   block outbound access to external services and restrict access to the isolated rehearsal host.
   Do not run restored connectors or workflows. Starting the app will create/change SQLite WAL files:
   this restored directory is now working data, not an immutable backup. Keep the original backup
   unchanged.
3. Check `/api/v1/health`, sign in with a test account, and download representative original
   documents and exports. Check pending jobs and erasure requests; inspect logs and reconcile external
   state. Record timing, results and recovery point, and test regularly. Synthetic automated tests
   exercise this path but cannot substitute for a restore of your own backups.
4. For a real cutover, keep writers stopped, preserve the current data separately for rollback, set
   both paths to the restored pair, reconcile deletions and keys, then restart one instance and repeat
   the checks before reopening access. Do not mix a database from one snapshot with files from another.

Schedule encrypted off-host backups, alert on failure, define retention and test restores before
relying on this procedure. The script does not provide scheduling, monitoring, encryption, remote
copy, point-in-time recovery, secret backup, or automatic cutover.
