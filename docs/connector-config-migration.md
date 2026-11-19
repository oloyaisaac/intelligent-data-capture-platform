# Offline connector configuration migration

New and replaced connector configurations and credentials are encrypted together. Existing connector
`config` rows may contain plaintext secrets and remain so until explicitly migrated. The API no
longer returns config, including for old rows, but this alone does not remove plaintext from the
database. ARC-023 is not closed merely because this tool exists.

**This changes the storage format.** Old binaries cannot use newly encrypted connector configs;
do not run old and new binaries together or roll back the application binary against a migrated
database. Connector DTOs now return `{}` for `config`, not the former settings. Check all external
API consumers before rollout. A config PATCH replaces the whole config and retains existing
credentials; credentials override duplicate config keys. PATCH does not update credentials.

## Before migration

1. Stop **all** API servers, workers, scheduled jobs and other database writers and keep them stopped
   through check, apply, re-check and deployment. The `--confirm-offline` flag is an operator
   acknowledgement, not enforcement. PostgreSQL locks and SQLite's write transaction protect only
   the transaction; they cannot stop an old binary writing plaintext afterward. Do not perform a
   rolling upgrade.
2. Take an encrypted, consistent database backup and verify restoration in an isolated environment.
   SQLite WAL requires a coordinated backup, not a copy of the live main file alone. Preserve the
   correct historical keys for each retained backup. Establish a tested rollback plan before starting:
   restoring the pre-migration backup can lose subsequent writes and restores plaintext secrets;
   never point the old binary at the new storage format. Manage this as a security incident if
   appropriate, review access to prior connector lists, files and backups, and rotate exposed tokens.
3. Select the existing database with `DB_DRIVER` and `DATABASE_URL` or `SQLITE_PATH`. Supply the
   actual `JWT_SECRET` and `ENCRYPTION_KEY` through approved secret injection; the tool requires
   explicit distinct keys and a non-default encryption key of at least 32 characters. It can read
   existing ciphertext under the target key or one source key, the JWT secret by default. If an
   alternate old encryption key was used, set `ENCRYPTION_MIGRATION_SOURCE_KEY` securely. Mixed
   ciphertexts requiring more than one source key or corrupt rows fail the operation; first resolve
   those using the key-migration runbook. Do not put keys in command arguments or logs.
4. Apply normal schema migrations separately. On PostgreSQL the migration role needs SELECT and
   UPDATE access and permission to lock `connectors`; table locks can block other activity. The tool
   loads every connector row in memory and uses a single transaction; test capacity with a suitably
   protected production-sized copy. SQLite must be an existing persistent database, not `:memory:`.

## Run while offline

The built backend image includes `dist/connector-config-migration.js`. Use a one-off container with
identical database access and securely injected keys:

```sh
node dist/connector-config-migration.js --check --confirm-offline
node dist/connector-config-migration.js --apply --confirm-offline
node dist/connector-config-migration.js --check --confirm-offline
```

For a checkout with dependencies installed, substitute
`npm run db:connector-config --workspace=@idcp/backend --` for the `node` command. The report has
counts only: `plaintext` counts legacy rows and `alreadyEncrypted` counts the new format. A check
exits **2** when any plaintext row remains, **0** when none remain; apply exits **0** on successful
transaction and **1** on failure. Both check and apply verify that every scanned credential payload
can be decrypted; apply verifies the persisted config and credential values before committing. A
failure rolls back all updates. Errors are intentionally generic to avoid printing secrets. Recheck
while offline and require zero plaintext rows before deploying the new binary everywhere and
performing a controlled connector smoke test. Never treat a check on one database as proof for other
replicas or retained backups.

Already-encrypted configurations are not re-keyed by this command, even when read using a fallback
key. Use `docs/encryption-key-migration.md` to rotate keys, and keep old keys while needed for
backups. Configuration migration does not erase plaintext from SQLite pages/WAL, PostgreSQL dead
tuples/WAL/replicas, snapshots, logs, exports or backups. Follow the appropriate platform-specific
secure disposal and retention procedures; rotating affected credentials is often necessary.

Synthetic tests cover SQLite rollback, check/apply and the existing key-rotation utility. PostgreSQL
CI exercises the transaction service when available, but this tool has not been run against a real
production database or backup. It does not sanitize historical connector errors or untrusted output,
or isolate connector processes.
