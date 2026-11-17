# Offline encryption-key migration

The application encrypts connector credentials with `ENCRYPTION_KEY` and tenant ID as AES-GCM additional authenticated data (AAD). It encrypts MFA secrets with the same key and `mfa:<userId>` as AAD. Older records may instead use the then-current `JWT_SECRET`; the runtime currently tries that secret as a fallback. Rotating JWT before migrating those records makes them unreadable. The offline migration checks each existing connector and MFA ciphertext and, where needed, re-encrypts it with the target `ENCRYPTION_KEY` in one transaction. It never prints plaintext, ciphertext, row identifiers or keys.

**Do not rotate a key solely because a command ran successfully.** The procedure requires a verified restore plan, actual downtime, a post-migration check and coordinated rollout. This tool has not been run against production data, real backups or a live deployment.

## Preparation

1. Inventory every deployment instance, worker, scheduled job and external database writer. Stop them all and verify they remain stopped until migration, verification and configuration rollout are complete. Both `--check` and `--apply` require `--confirm-offline`; this flag is an operator acknowledgement, not a mechanism that stops other processes. PostgreSQL table locks and SQLite's write transaction protect the scan while it runs, but **cannot** prevent an old process writing old-key data after the transaction commits. Do not run a rolling migration.
2. Take a consistent encrypted database backup and a coordinated storage backup. Test restoration in an isolated environment, including retention of the old keys required to decrypt that backup. SQLite runs in WAL mode; do not copy the main database file alone while it is active. For PostgreSQL, use a tested backup/restore method with appropriate privileges. Keep the prior key in an approved secret manager for as long as retained backups require it; do not delete keys on a schedule that makes those backups unrecoverable.
3. Apply existing schema migrations separately before the key migration; this tool does not apply them. The database role needs access to `connectors`, `users`, and `webhooks`, including the privileges needed to lock those tables and update connector credentials and MFA secrets. The PostgreSQL table locks can block other database activity; schedule downtime and test duration with a production-sized copy. The whole migration is one transaction and loads encrypted rows in memory, so very large databases may require additional engineering.
4. Provision a distinct, non-default target `ENCRYPTION_KEY` of at least 32 characters. For the normal legacy migration, the source is the **old** `JWT_SECRET` that encrypted the existing data. Provide both through your approved secret manager/environment injection, not command-line arguments or shell history. Never print or log them. `ENCRYPTION_MIGRATION_SOURCE_KEY` may instead provide one explicit previous encryption key when rotating `ENCRYPTION_KEY`; it is read only by the offline command, not by the running API.

## Migrate

With all writers stopped, the existing database selected by `DB_DRIVER` and `DATABASE_URL` or `SQLITE_PATH`, and the old JWT and target encryption key securely injected:

```sh
# Check encrypted records without updating them. Exit 2 means source-key records remain.
node dist/encryption-migration.js --check --confirm-offline

# Only after inspecting the check and verifying the backup:
node dist/encryption-migration.js --apply --confirm-offline

# Verify again before changing JWT or restarting any writer. Require exit 0 and zero legacy counts.
node dist/encryption-migration.js --check --confirm-offline
```

For a repository checkout with dependencies installed, replace `node dist/encryption-migration.js` with `npm run db:encryption --workspace=@idcp/backend --`. The built backend image contains the compiled CLI; run a one-off container with the same database/secret configuration and network as the stopped service. Do not mount a private key or credentials file unnecessarily. `SQLITE_PATH` must be an existing persistent database, not `:memory:`. The commands report counts of already-current and source-key records for connector credentials and MFA. Exit codes: **0** means the operation completed (for `--check`, no source-key records were found); **2** means a check found source-key records; **1** means a configuration, database, unsupported-record or decryption failure. On failure the apply transaction rolls back; do not rotate. The command intentionally suppresses raw database errors that might contain secrets. Investigate in a protected environment without copying sensitive data into logs.

A successful apply verifies all scanned ciphertexts with the target key before commit. Check again while still offline, then update the JWT secret in the secret manager and deploy the same target encryption key to **every** instance. Confirm the intended configuration and smoke-test login with MFA and connector credential access before reopening traffic. Rotation can invalidate sessions or require reauthentication. If validation fails, keep traffic stopped and follow the tested rollback/restore procedure; restoring an old database snapshot also requires the keys that were valid at that snapshot.

## Boundaries

- Only `connectors.credentials_encrypted` and `users.mfa_secret_enc` are migrated. Staged MFA enrolments are included. An enabled MFA account with no encrypted secret stops the migration; an enabled factor is never bypassed by password-only login. Use a recovery code or an authorised support recovery process for affected users.
- The schema has a `webhooks.secret_encrypted` column but no implemented webhook encryption path in this release. Any webhook row stops the migration; investigate and resolve those records rather than assume their key or AAD. Inventory future or external encrypted fields separately.
- The command accepts exactly one source key per run and fails atomically if any record is encrypted with a third key or is corrupt. For `ENCRYPTION_KEY` rotation when both legacy-JWT and previous-encryption-key records may exist, first migrate all JWT-derived records to the existing encryption key, then run a separate offline migration from that key to the new one. Do not discard any old key until every relevant live record and retained backup has a verified recovery plan.
- A zero-count check only covers the selected database at the locked point in time, with the supplied keys and the fields above. It does not validate external stores, retained backups, replicas, unknown schema fields, or writes after the lock is released. PostgreSQL, SQLite and storage backups may retain previous ciphertext. There is no online multi-version keyring, automatic background migration, or automatic recovery from lost keys.
