# Offline connector error remediation (ARC-016)

Older versions persisted arbitrary connector health and run exception text, which may contain
credentials, paths or customer data. Current list and run-history responses substitute generic
messages but do not remove historical text from the database. This operator-directed tool can replace
`connectors.last_error` and `connector_runs.error` for **one selected organisation and connector**
with application-owned generic messages. It does not run automatically or establish that R01 is
complete. No production remediation is claimed here.

## Authorization and prerequisites

1. An authorized security/incident and data owner must assess exposure, legal holds, diagnostic loss,
   backups, rotations and scope before running this destructive operation. Original errors may be
   useful evidence; this tool irreversibly replaces live-row values. Operator/incident references and
   flags are assertions, not authentication or proof of authorization. Never include secrets, customer
   names or exception text in arguments or references: shell history, process lists and audit metadata
   may be retained. Restrict access to outputs, identifiers, database logs and query tracing.
2. Stop **all** application, connector, maintenance and other database writers, including old
   versions, replicas and external scripts, and disable restarts throughout list, check, apply and
   verification. `--confirm-offline` does not check or fence processes. Locks and conditional updates
   only mitigate contention between cooperating executions; old or external writers may reintroduce
   values. Verify the exact database and organisation/connector identifiers from an authorized
   inventory. This tool does not enumerate organisations, databases or deleted connectors.
3. Take an encrypted consistent backup and test restoration under the approved incident plan before
   changing rows. Protect copies and follow retention and legal-hold decisions. Live-row replacement is
   **not secure deletion**: PostgreSQL/SQLite WAL, physical pages, replicas, snapshots, logs, backups,
   exports, client downloads and external destinations can retain older text. A restore can reintroduce
   data or lose subsequent writes. Assess exposure and rotate credentials where authorized.
4. Apply migrations separately; configure `DB_DRIVER` and `DATABASE_URL` or an existing persistent
   `SQLITE_PATH` securely. The tool does not migrate. For PostgreSQL use a restricted role: list and
   check set the one session read-only; apply requires SELECT/UPDATE on the connector tables, row-lock
   privileges and INSERT on `audit_logs`. SQLite list/check open read-only, though WAL shared-memory
   sidecars may be needed or created; apply enables WAL and uses an immediate write transaction.

## Commands

In a packaged backend image, with actual non-secret identifiers and the shown flag order:

```sh
node dist/connector-error-remediation.js --list --organisation ORG_ID --confirm-offline
node dist/connector-error-remediation.js --list --organisation ORG_ID --after LAST_CONNECTOR_ID --confirm-offline
node dist/connector-error-remediation.js --check --organisation ORG_ID --connector CONNECTOR_ID --confirm-offline
node dist/connector-error-remediation.js --apply --organisation ORG_ID --connector CONNECTOR_ID --operator OPERATOR_REF --incident INCIDENT_REF --confirm-offline --confirm-loss-reviewed
node dist/connector-error-remediation.js --check --organisation ORG_ID --connector CONNECTOR_ID --confirm-offline
```

From a checkout, substitute `npm run db:connector-errors --workspace=@idcp/backend --`. The list
returns up to 100 existing connector IDs with eligible health or run errors for that organisation;
continue from `nextAfter` while offline, and list again from the beginning after remediation. IDs
and cursors must use the command's restricted ASCII identifier syntax. If an old ID cannot be used as
a cursor, stop and investigate separately rather than claiming complete coverage. Listing and count
queries may scan many runs despite their bounded output; identifier and replacement comparisons use
PostgreSQL's `C` or SQLite's `BINARY` collation, which can limit index use. Assess query plans and load
on a protected representative copy before production use. Exit 0 means the command completed, not that all data is
clean; exit 2 means the selected connector was not found in that organisation; exit 1 means invalid
arguments or a generic failure. Check can succeed with eligible rows still present.

`--check` reports a boolean `healthEligible` and number `runEligible`; it does not select or print
error text. `--apply` changes an eligible health error and at most 100 eligible run errors per
transaction; repeat while `remaining` is true and verify using `--check`. A non-null error is eligible
unless it is exactly the corresponding fixed generic replacement. Thus even benign or empty old
messages and current safe policy-specific messages may be replaced: eligibility is not a sensitivity
classification. Null and exact replacement values are preserved. Run records must match **both**
organisation and connector IDs. Each nonempty apply commits its changes and one append-only
`connector.errors_remediated_offline` audit entry together, with counts and supplied operator/incident
references but no original text or run IDs. Audit failure rolls back the page. If the commit outcome
is ambiguous, inspect the count and audit trail before deciding to repeat; repeated successful calls
are otherwise idempotent while writers remain stopped.

## Coverage limits

This tool does not inspect `request_summary`, `response_summary`, connector configuration,
credentials, mapping profiles, audit records, worker errors, arbitrary other fields, logs, exports,
backups or external systems. Historical run summaries can themselves contain sensitive data. It
only lists existing connector rows and only updates run rows whose organisation matches that row;
runs for deleted connectors, inconsistent organisation IDs, invalid historical IDs, other databases
and other organisations require separate authorized investigation. A zero count therefore does not
prove those records or copies are clean. Current connector success/schema and duplicate-preview outputs
and runtime isolation remain separate risks; see R01 findings and `batch-error-remediation.md`.
