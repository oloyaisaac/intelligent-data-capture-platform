# Offline historical worker-error remediation (ARC-025)

Older workers persisted arbitrary exception text in `jobs.last_error`; it may contain credentials,
paths or document data. Current workers write fixed messages but do not clean historical rows. This
operator-directed tool can replace the eligible `last_error` on **one selected organisation/job**
with a fixed application-owned redaction message. It does not run automatically or establish R01
completion. No production operation is claimed here.

## Authorization and prerequisites

1. A qualified, authorized security/incident and data owner must assess historical exposure, legal
   holds, diagnostic loss, backups, credential rotation and the exact scope before using the tool.
   Error text can be evidence; this replaces the live-row value. Operator and incident references
   and confirmation flags are assertions, not authentication or proof of authorization. Never put
   secrets, customer names or error text in arguments or references: shell history, process lists and
   audit metadata may retain them. Restrict output, identifiers, database logs and query tracing.
2. Stop **all** workers, API services and other database writers, including older versions, replicas,
   recovery commands and external scripts; disable restarts through list, check, apply and final
   verification. `--confirm-offline` does not verify or fence any process. A job-row lock and guarded
   update reduce contention with cooperating processes, but do not stop running work, external effects
   or older writers from reintroducing text. This is not worker recovery; do not use it to requeue,
   abandon, alter ownership or infer that a running job is dead. Verify the database and job's
   organisation using a separately authorized inventory. Jobs do not require a corresponding live
   organisation row; a listed ID alone does not establish present ownership or authorization.
3. Take an encrypted consistent backup and test restoration under the approved incident plan before
   modifying rows. Replacement is **not secure deletion**: database pages, PostgreSQL/SQLite WAL,
   replicas, snapshots, logs, delivered events, exports, backups and other systems can retain text.
   A restore can reintroduce values or lose later writes. Protect copies, assess exposure, rotate
   credentials where appropriate, and follow authorized retention and legal-hold procedures.
4. Apply migrations separately and securely set `DB_DRIVER` and `DATABASE_URL`, or an existing
   persistent `SQLITE_PATH`. This tool does not migrate. For PostgreSQL, use an appropriately
   restricted role: list/check set the one session read-only; apply requires SELECT/UPDATE and
   row-lock privileges on jobs and INSERT on `audit_logs`. SQLite list/check open read-only, though
   WAL shared-memory sidecars may be required or created; apply enables WAL and uses an immediate
   write transaction. Treat database output and audit references as sensitive.

## Commands

In a packaged backend image, with actual non-secret identifiers and the shown flag order:

```sh
node dist/worker-error-remediation.js --list --organisation ORG_ID --confirm-offline
node dist/worker-error-remediation.js --list --organisation ORG_ID --after LAST_JOB_ID --confirm-offline
node dist/worker-error-remediation.js --check --organisation ORG_ID --job JOB_ID --confirm-offline
node dist/worker-error-remediation.js --apply --organisation ORG_ID --job JOB_ID --operator OPERATOR_REF --incident INCIDENT_REF --confirm-offline --confirm-loss-reviewed
node dist/worker-error-remediation.js --check --organisation ORG_ID --job JOB_ID --confirm-offline
```

From a checkout, replace the node command with `npm run db:worker-errors --workspace=@idcp/backend --`.
List returns at most 100 eligible job IDs and a `nextAfter` cursor. Continue through all pages while
offline; after remediation, list again from the start. The tool does not enumerate organisations or
other databases. IDs and cursors must use its restricted ASCII syntax; if a historical ID is not
usable, stop and investigate separately rather than claiming complete coverage. Matching and ordering
use PostgreSQL `C` or SQLite `BINARY` collation, which can limit index use; output is bounded but
queries can scan many rows. Assess query plans and workload on an approved representative copy.

`--check` reports `found` and `eligible`; list/check do not select or print error text or payload.
Exit 2 means the job was not found in the specified organisation; exit 1 means invalid arguments or
a generic failure. Exit 0 means a command completed, not that all historical data is clean. Check
may succeed while a row remains eligible.

`--apply` updates **one** eligible job and inserts one `worker.error_remediated_offline` audit row in
the same transaction. Audit metadata contains operator and incident references, not error text or
payload. An audit failure rolls back the update. An ambiguous commit or crash requires checking the
job and audit trail before deciding whether to repeat. Repeating a confirmed successful apply changes
nothing while writers remain stopped. Non-null errors are eligible unless they exactly match one of
the application's fixed worker, offline-recovery or remediation messages. Empty and benign historical
messages may therefore be replaced; eligibility is not a sensitivity classification. A null or exact
allowlisted message is preserved. The operation does not change job status, attempts, scheduling,
payload, documents or other fields.

## Coverage limits

This only addresses `jobs.last_error` for selected jobs, not their payloads, document fields, audit
metadata, logs, realtime events, client copies, worker/provider output, other tables, databases,
backups or external systems. Historical IDs that cannot be passed, missing or incorrect organisation
identifiers and deleted/unknown organisations need a separate authorized investigation. A zero
result for a selected organisation or job is not proof that other copies are clean. See the R01
findings and `connector-error-remediation.md` and `batch-error-remediation.md` for other scoped tools.
