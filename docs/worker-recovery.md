# Interrupted worker jobs: offline recovery

The worker no longer requeues running jobs just because they are old. After a crash they remain
`running` until an operator reviews and explicitly requeues them. This is an availability change:
startup alone will not restore those jobs, and monitoring and manual intervention are required.
Normal queued jobs still run. The startup warning counts all running jobs, including work that may
be legitimately active; age is not evidence that a worker is dead.

This procedure reduces one live-claim race; **it does not guarantee exactly-once effects, safe
automatic recovery, or multi-worker safety**. OCR and billing may already have happened, retention
purge may already have deleted files, and events or other external effects may be missing or
repeated. Requeueing is an explicit decision to retry despite any remaining uncertainty. The tool
cannot detect a live or paused process, prevent it from resuming, confirm an external action, enforce
operator authorization, or protect against old binaries and out-of-band database writers.

## Before recovery

1. Identify the correct environment, database and incident owner. Stop **all** API/worker processes
   that can claim jobs, including old versions, scheduled jobs, orphaned children and replicas.
   Disable orchestration restarts and ensure none can resume until the procedure ends. A lock taken
   by this tool cannot replace that control. Keep other writers stopped as appropriate for backup
   and investigation.
2. Take and verify a suitable backup under the deployment's approved backup procedure; retain
   incident evidence and follow the organisation's access and change controls. Do not use the
   recovery tool if the worker state or external effects are unknown and retry is unacceptable.
3. Configure the same database and validated environment as the deployed application. The CLI does
   not apply migrations or start services and requires an existing persistent SQLite database, or a
   configured PostgreSQL database. Avoid printing environment variables or secrets. Output contains
   organisation, document and job identifiers: treat it as sensitive operational data.

## Inspect and requeue

From the backend workspace, using the same configuration as the application:

```sh
npm run db:worker-recovery -- --list --confirm-offline
npm run db:worker-recovery -- --requeue JOB_ID --attempt N --confirm-offline --confirm-effects-reviewed
```

For the built container or backend build, use `node dist/worker-recovery.js` with the same arguments.
The list returns at most 1,000 running claims and a total count and `truncated` flag. It omits payloads
and error text. Investigate each selected job's owner, current status, attempt, document, logs and
possible external effects using authorized operational tools. Confirm the old process cannot resume;
reconcile the provider, billing and destination state as appropriate. Obtain an explicit owner decision
for each retry. Replace `JOB_ID` and `N` with that job's actual ID and current attempt. Both
confirmation flags are required; they are operator assertions, not proof.

The update requeues only the named job if it is still `running` with that exact attempt. It leaves
other jobs untouched and preserves the attempt count; the next claim increments it. Exit status 2
means no matching running attempt was updated; re-inspect rather than blindly retrying. Exit status 1
means a command/configuration/database failure. A successful update can still be followed by an
ambiguous response or later processing failure, so re-inspect before repeating any action.

When reviewed recovery changes are complete, restart only the supported single worker on this
version, restore normal scheduling under the deployment procedure, and verify the job outcome and
external effects. Keep older binaries from starting: they can requeue live jobs using the old
age-only heuristic. Record the decision, the observed outcome and any duplicate/missing effects in
the incident system without recording secrets. This procedure is not evidence of a production
rollout or an independent architecture approval.
