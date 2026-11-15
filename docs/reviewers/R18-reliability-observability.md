# REVIEWER 18 — RELIABILITY & OBSERVABILITY ENGINEER

| Field | Value |
|-------|-------|
| **Reviewer ID** | R18 |
| **Title** | Reliability & Observability Engineer |
| **Board** | E — Quality, performance & reliability |
| **Wave** | 4 (weeks 6–8) |
| **Effort** | 8 person-days |
| **Gate chaired** | none |
| **Co-signs** | G4, G6, G10 |
| **Evidence to** | G2, G9 (contributes findings, not an approver) |
| **Finding prefix** | `REL-###` |
| **Upstream** | R03 (job tables), R02 (health route) |
| **Downstream** | R19 (alerting in deployment), R22 (support runbooks) |
| **Status** | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Determine what happens when things go wrong — and, more importantly, **whether anyone finds out**. A system
that fails loudly and recovers is production-grade. A system that fails silently is a liability, however good
its code.

**The measured starting condition.** There is no `/metrics` endpoint and no alerting of any kind. The access
log exists (one structured line per request). Structured application logs exist (`logger.ts`). But:

- A **job that exhausts its retries** produces a `document:failed` SSE event — which nobody receives if no
  client is connected, and which is never surfaced to an operator later.
- A **failed retention sweep** is *"a `warn` line in the log and nothing else"* — the repository says so
  itself (`AUDIT-2026-10.md` §3).
- **No backup or restore exists** (`db:backup` is absent) even though the database and the document storage
  must be restored **together** or documents silently become orphans.

That is the gap you close: not by writing features, but by proving what is observable and specifying what must
be. Aggregate: **14 of 14** reliability risks in this domain are currently either unmonitored or unexercised.

---

## 2. Required expertise

- Failure-mode and effects analysis; state-machine verification
- Idempotency, at-least-once vs exactly-once, retry storms, dead-letter handling
- Crash recovery and stale-claim reclamation
- Structured logging, correlation ids, log hygiene
- Metrics design (RED/USE), SLOs and error budgets
- Alerting design and on-call practicality
- Backup, restore, RTO/RPO, and consistency between a database and object storage
- Health-check design (liveness vs readiness)

---

## 3. Repository context (self-contained)

**Product.** One Node process (DEC-029) hosting both the HTTP API and an in-process worker that polls a
`jobs` table. If the process dies mid-job, the document must not be stranded.

**Reliability-relevant implementation:**

| Element | Path | Size |
|---------|------|------|
| Worker loop, claim, execute, backoff | `apps/backend/src/services/worker.ts` | 282 |
| Job repository: claim, retry, dead-letter, `requeueStale` | `apps/backend/src/repositories/system-repo.ts` | 203 |
| Retention/expiry/session sweep | `apps/backend/src/services/maintenance-service.ts` | 195 |
| Realtime hub (SSE) | `apps/backend/src/realtime/hub.ts` | 104 |
| Structured logger + redaction | `apps/backend/src/logger.ts` | 74 |
| Fastify assembly, access log, error handler, health route registration | `apps/backend/src/http/app.ts` | 238 |
| Process bootstrap (signals? graceful shutdown?) | `apps/backend/src/index.ts` | 52 |
| Recovery test | `apps/backend/test/worker-recovery.test.ts` | 108 |
| Maintenance test | `apps/backend/test/maintenance.test.ts` | 143 |
| Dashboard live regression test | `apps/backend/test/dashboard.test.ts` | 127 |

**Documented job semantics:**

```
queued → running → succeeded | failed | dead
attempts / max_attempts = 5
backoff = exponential (see system-repo.ts)
requeueStale: any job claimed (running) more than RECOVERY_GRACE_MS (30 s) before the worker started is re-queued
```

**Documented operational gaps (`DEPLOYMENT.md` §11, `AGENT_STATE.md`):**
container image, `db:backup`, `/metrics`, alerting, dependency audit gate — all open.

---

## 4. Exact files and components to examine

### 4.1 Must read in full

`services/worker.ts` · `repositories/system-repo.ts` · `services/maintenance-service.ts` ·
`realtime/hub.ts` · `logger.ts` · `http/app.ts` · `index.ts` · `db/{database,sqlite,postgres}.ts` ·
`test/{worker-recovery,maintenance,dashboard}.test.ts` · `DEPLOYMENT.md` (§11 checklist) ·
`AGENT_STATE.md` (operational gaps).

### 4.2 Must cross-check

- `apps/backend/src/http/routes/privacy-routes.ts` and `organisation-routes.ts` — the health route and any
  operational endpoints.
- `apps/backend/src/services/document-service.ts` — what state a document is left in on failure.
- `apps/desktop/src/lib/realtime.ts` — how the client behaves when the stream dies (coordinate with R09).
- `apps/backend/src/services/privacy-service.ts` — erasure vs a concurrently running job.

### 4.3 Explicit non-goals

Throughput and latency measurement → R17 · database correctness and migration portability → R03 ·
deployment pipeline construction → R19 · security of the log stream → R07.

---

## 5. Upstream artefacts required

| From | Artefact | Why |
|------|----------|-----|
| R03 | `evidence/R03/restore-rehearsal.md` | You own the *operational* backup story; R03 proves restorability |
| R17 | `evidence/R17/bottleneck-ranking.md` | The saturation signals that must be alerted on |

---

## 6. Checklist

### 6.1 Job state machine

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| REL-01 | Enumerate every state and every transition | Read `worker.ts` + `system-repo.ts` | A complete state diagram in evidence | **WRITE** |
| REL-02 | Every state has a terminal path | Trace each state forward | No state can hang indefinitely | STATIC |
| REL-03 | Claim is atomic (two workers cannot claim one job) | Read the claim SQL; run two workers | Exactly-once execution | **RUNTIME** |
| REL-04 | `requeueStale` uses a defensible grace period | `RECOVERY_GRACE_MS` = 30 s | Justified against real job durations; **a legitimate 45 s OCR job would be re-queued** — assess | STATIC |
| REL-05 | Retry backoff is exponential and capped | Read | Bounded | STATIC |
| REL-06 | `max_attempts` (5) leads to `dead`, not an infinite loop | Read | Terminal | STATIC |
| REL-07 | A dead job marks the document `failed` | Read worker failure path | Confirmed | STATIC |
| REL-08 | Jobs are idempotent per attempt | Read each job type's side effects | Safe to re-run | STATIC |
| REL-09 | Crash during a job leaves a recoverable state | T-01 | Re-queued and completed | **RUNTIME** |

### 6.2 Crash and restart behaviour

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| REL-10 | `SIGTERM` triggers graceful shutdown (stop accepting, drain) | Read `index.ts` | Implemented, or the gap is recorded | STATIC |
| REL-11 | In-flight requests are allowed to finish on shutdown | T-02 | No truncated responses | **RUNTIME** |
| REL-12 | Half-uploaded files are cleaned or orphaned safely | Kill mid-upload | No corrupt document row | **RUNTIME** |
| REL-13 | Restart resumes the queue without duplication | T-01 | Confirmed | **RUNTIME** |
| REL-14 | A restart mid-maintenance does not corrupt retention state | Kill during sweep | Idempotent | **RUNTIME** |
| REL-15 | Temp files from OCR are cleaned after a crash | Kill during OCR; inspect `tmpdir` | Cleaned on next run or documented leak | **RUNTIME** |

### 6.3 Health, readiness and liveness

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| REL-16 | `GET /api/v1/health` exists | Call it | 200 | **RUNTIME** |
| REL-17 | It actually checks the database | Read the route; stop the DB and call it | 503 with `dependencies.db: "error"` | **RUNTIME** |
| REL-18 | It distinguishes liveness from readiness | Read | Present or recommended | STATIC |
| REL-19 | It checks storage writability | Read | Likely absent — record | STATIC |
| REL-20 | It checks worker liveness (last successful tick) | Read | Likely absent — record | STATIC |
| REL-21 | It leaks no internal detail on failure | Read the 503 body | Generic | STATIC |

### 6.4 Observability — what exists

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| REL-22 | Every request produces a structured access-log line | Read `app.ts` `onResponse` | method, path, status, duration, request id | STATIC |
| REL-23 | Query strings and bodies are excluded from access logs | Read | Excluded (prevents the SSE token leaking — but see R-17 for proxies) | STATIC |
| REL-24 | A request id is generated and correlated | Read | Present in logs and error envelopes | STATIC |
| REL-25 | The request id propagates into worker logs for the same document | T-03 | Correlated end to end, or recorded as a gap | **RUNTIME** |
| REL-26 | Errors log with a stack and context but no secrets | Force errors | Clean | **RUNTIME** |
| REL-27 | Log levels are appropriate (no debug in production) | Read config + call sites | Correct | STATIC |
| REL-28 | Log output is machine-parseable JSON | Inspect | One JSON object per line | **RUNTIME** |

### 6.5 Observability — what is missing (primary finding source)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| REL-29 | Confirm **no `/metrics` endpoint** exists | `grep -rn "prom-client\|/metrics"` | Absent | STATIC |
| REL-30 | Confirm **no alerting** exists anywhere | Search integration/config | Absent | STATIC |
| REL-31 | **Enumerate every failure that is currently silent** | Reason over the system | A table: failure → current signal → who notices → in what time | **WRITE** |
| REL-32 | Queue depth is not observable | Confirm | Recorded | STATIC |
| REL-33 | Job outcomes (success/dead) are not aggregated | Confirm | Recorded | STATIC |
| REL-34 | Connector error rate is not observable | Confirm | Recorded | STATIC |
| REL-35 | Retention-sweep failure is invisible | Confirm (`maintenance-service.ts` warn only) | Recorded | STATIC |
| REL-36 | Disk capacity is not monitored | Confirm | Recorded | STATIC |
| REL-37 | Design the required metric set (RED + queue + storage) | Proposal | `evidence/R18/metrics-spec.md` | **WRITE** |
| REL-38 | Design the alert set with thresholds and routing | Proposal | `evidence/R18/alerting-spec.md` | **WRITE** |

### 6.6 Realtime reliability

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| REL-39 | SSE reconnect uses bounded exponential backoff | `apps/desktop/src/lib/realtime.ts` | 6 retries, 30 s cap | STATIC |
| REL-40 | **Giving up is visible to the user** | After max retries | Status `offline` surfaced in the UI | **RUNTIME** |
| REL-41 | Events missed while disconnected are recoverable | Refresh on reconnect? | Documented (poll-on-focus, or a gap) | STATIC |
| REL-42 | The hub cleans up dead connections | Read `hub.ts` | No leak | STATIC |
| REL-43 | A slow client cannot block the broadcaster | Read | Backpressure handled or a gap | STATIC |
| REL-44 | The stream survives a proxy idle timeout | Run behind the documented proxy | Heartbeat/keep-alive present or a gap | STATIC |

### 6.7 Backup, restore and disaster recovery (operational view; R03 proves restorability)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| REL-45 | Confirm no `db:backup` script | `grep -n "db:backup" package.json` | Absent (R-09) | STATIC |
| REL-46 | Confirm DB and storage must be restored together | Reason + read `STORAGE_PATH` usage | Documented consistency rule | STATIC |
| REL-47 | Define the backup procedure and schedule | Proposal | `evidence/R18/backup-plan.md` | **WRITE** |
| REL-48 | Define and rehearse a restore | Coordinate with R03's rehearsal | Step-by-step, with timings | **WRITE** |
| REL-49 | State RPO/RTO honestly | From the rehearsal | Numbers | **WRITE** |
| REL-50 | Erased data must not be resurrected by a restore | Reason about `POST /me/erase` vs backups | A documented policy (e.g. re-apply erasure log) | **WRITE** |
| REL-51 | A restore is verified by the application, not only the DB | Start the app post-restore | Sign-in + document download work | **RUNTIME** |

### 6.8 Graceful degradation

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| REL-52 | Backend down: the mobile queue holds | T-04 | Nothing lost | **RUNTIME** |
| REL-53 | Backend down: the desktop shows a clear state | T-05 | Legible, not spinning forever | **RUNTIME** |
| REL-54 | Database down: the API returns 503, not 500 with internals | Stop the DB | 503, generic body | **RUNTIME** |
| REL-55 | Storage full: uploads fail closed with a clear error | Fill a small volume | `INTERNAL_ERROR`, nothing half-written | **RUNTIME** |
| REL-56 | OCR binary missing: documents fail actionably | Unset the binary | `failed` + message naming tesseract | **RUNTIME** |
| REL-57 | External connector down: the review workflow is unaffected | Break a connector | Review still works | **RUNTIME** |
| REL-58 | Clock skew / DST does not corrupt retention windows | Reason about `nowIso()` UTC usage | UTC throughout | STATIC |

### 6.9 Operational readiness

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| REL-59 | A runbook exists for "document stuck in processing" | Search docs | Present or written by you | **WRITE** |
| REL-60 | A runbook exists for "connector write failed" | Same | Present or written | **WRITE** |
| REL-61 | A runbook exists for "password reset without mail" | Same | Present or written (R-02) | **WRITE** |
| REL-62 | A runbook exists for "erasure refused" | Same | Present or written | **WRITE** |
| REL-63 | On-call has a defined escalation | Search | Absent — recommend | WRITE |

---

## 7. Known reliability risks to confirm or refute

| Risk | Statement | Severity |
|------|-----------|----------|
| **R-11 (MEDIUM)** | No `/metrics`, no alerting; failures are silent | MEDIUM |
| **R-09 (MEDIUM)** | No backup/restore path; DB + storage must be restored together | MEDIUM |
| — | `RECOVERY_GRACE_MS = 30 s` may re-queue legitimate long OCR jobs | Assess |
| — | No graceful shutdown handling verified | Assess |
| R-10 | Migrations run at boot; a crash mid-migration is a boot failure | MEDIUM |
| R-17 | SSE tokens may be captured by proxy logs | MEDIUM |

---

## 8. Questions you must answer

1. **If the process dies mid-OCR tonight, what does the customer see tomorrow — and who knows?**
2. Which failures are silent today? List each with the mean time to detection.
3. Is there graceful shutdown, and are in-flight requests drained?
4. Does the health check detect a dead database, a full disk, and a stuck worker?
5. What is the RPO and RTO, and has a restore actually been performed?
6. Can erased data come back from a backup?
7. What does an operator do at 2 a.m. when the queue stops draining?

---

## 9. Commands to run

```bash
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund
npm run db:migrate && npm run db:seed

# ---------- what observability exists ----------
grep -rn "prom-client\|/metrics\|statsd\|opentelemetry\|sentry" package.json apps/*/package.json apps/backend/src
grep -n "onResponse\|onSend\|requestId\|log\." apps/backend/src/http/app.ts
sed -n '1,80p' apps/backend/src/logger.ts

# ---------- health ----------
npm run dev:backend &
curl -s http://127.0.0.1:4000/api/v1/health | jq
# stop the DB (rename the sqlite file) and call again:
mv ./local-storage/idcp.db /tmp/x.db && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4000/api/v1/health
mv /tmp/x.db ./local-storage/idcp.db

# ---------- crash recovery ----------
#  upload a document, then:
pkill -9 -f "tsx watch src/index" ; sleep 1
npm run dev:backend &
sleep 5
sqlite3 ./local-storage/idcp.db "SELECT id,status,attempts,last_error FROM jobs ORDER BY created_at DESC LIMIT 3;"
sqlite3 ./local-storage/idcp.db "SELECT id,status FROM documents ORDER BY created_at DESC LIMIT 3;"

# ---------- graceful shutdown ----------
npm run dev:backend &
PID=$(pgrep -f "tsx watch src/index" | head -1)
curl -s -o /dev/null http://127.0.0.1:4000/api/v1/health &   # in flight
kill -TERM $PID ; wait ; echo "shutdown exit=$?"

# ---------- silent failure enumeration ----------
grep -n "logger.warn\|logger.error" apps/backend/src/services/maintenance-service.ts
grep -n "document:failed\|toOrganisation" apps/backend/src/services/worker.ts
grep -n "catch" apps/backend/src/services/worker.ts

# ---------- retention-sweep failure visibility ----------
grep -n "MAINTENANCE_INTERVAL_MS\|MAINTENANCE_ENABLED" apps/backend/src/config.ts
```

---

## 10. Tests to perform

| # | Test | Procedure | Pass criterion |
|---|------|-----------|----------------|
| T-01 | Crash mid-job | `kill -9`, restart | Job re-queued and completed; nothing stranded |
| T-02 | Graceful shutdown | SIGTERM with in-flight requests | Requests complete or fail cleanly |
| T-03 | Correlation | Trace one document through API → worker logs | Same id visible on both sides, or a gap |
| T-04 | Backend down — mobile | Upload offline | No loss |
| T-05 | Backend down — desktop | Load the app | Clear offline state |
| T-06 | DB down | Stop DB, call API | 503, generic body |
| T-07 | Disk full | Fill a volume | Closed 5xx, no partial file |
| T-08 | OCR binary missing | Unset | Actionable failure |
| T-09 | Two workers | Run both | Exactly-once execution |
| T-10 | Stale claim | Pause a worker >30 s mid-job | Re-queued (and assess the false-positive risk) |
| T-11 | Restore | Follow R03's rehearsal | App works on restored data |
| T-12 | Erasure vs restore | Erase, restore an older backup | Policy behaviour documented |

---

## 11. Evidence required

```
docs/reviewers/evidence/R18/
├── job-state-machine.md         # REL-01, every transition
├── silent-failures.md           # REL-31 — the key deliverable
├── observability-current.md     # REL-22 … REL-36
├── metrics-spec.md              # REL-37
├── alerting-spec.md             # REL-38
├── backup-plan.md               # REL-47 … REL-50
├── degradation-matrix.md        # REL-52 … REL-58
├── runbooks/                    # REL-59 … REL-62
├── transcripts/                 # T-01 … T-12
├── commands.log
└── findings.md                  # REL-### register
```

---

## 12. Passing conditions (co-signs G4, G6, G10)

- [ ] **P1** The job state machine is fully documented with every transition terminal (REL-01, REL-02).
- [ ] **P2** Exactly-once claim is proven with two workers (REL-03, T-09).
- [ ] **P3** Crash recovery is demonstrated end to end (REL-09, REL-13, T-01, T-10).
- [ ] **P4** Graceful shutdown is implemented or the gap is recorded with a mitigation (REL-10, REL-11, T-02).
- [ ] **P5** The health check verifies real dependencies — DB at minimum, storage and worker ideally (REL-17 … REL-21, T-06).
- [ ] **P6** **Every silent failure is enumerated, and each is either alerted or accepted in writing with an owner** (REL-31 … REL-36, REL-38).
- [ ] **P7** A metric and alert specification exists and is implementable (REL-37, REL-38).
- [ ] **P8** A backup/restore plan exists, has been rehearsed, and states RTO/RPO (REL-47 … REL-49, T-11).
- [ ] **P9** The erasure-vs-restore policy is defined (REL-50, T-12).
- [ ] **P10** Support runbooks exist for the four named failure modes (REL-59 … REL-62).
- [ ] **P11** Degradation behaviour is verified for backend down, DB down, disk full and missing OCR (REL-52 … REL-57, T-04 … T-08).

---

## 13. Blocked items

| Item ID | Blocker | What unblocks it | Owner |
|---------|---------|------------------|-------|
| REL-48, T-11 | Needs R03's restore rehearsal | R03 | R03 |
| REL-44 | Needs the documented reverse proxy | R19 | R19 |

---

## 14. Findings register

| ID | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
|----|----------|-----------|---------|----------------|-----------|---------------|-------|
| REL-001 | | | | | | | |

---

## 15. Reviewer sign-off

| Field | Value |
|-------|-------|
| Reviewer name | |
| Date started | |
| Date completed | |
| **G4 co-sign result** | ☐ Pass ☐ Fail ☐ Abstain |
| **G6 co-sign result** | ☐ Pass ☐ Fail ☐ Abstain |
| **G10 co-sign result** | ☐ Pass ☐ Fail ☐ Abstain |
| Co-sign G6 / G10 | ☐ ☐ |
| Silent failures found | |
| RTO / RPO | / |
| Conditions failed (IDs) | |
| Reviewed commit | `43d384b` |
| Statement | *I killed the process mid-job, stopped the database, filled the disk and removed the OCR binary, and recorded what a customer and an operator each observed.* |
| Signature | |
