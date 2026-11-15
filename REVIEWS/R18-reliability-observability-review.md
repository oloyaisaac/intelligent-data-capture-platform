# REVIEWER NAME: Reliability & Observability Engineer (R18)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R18-reliability-observability.md` (63 checklist items)
**STATUS:** ☑ Complete — **no runtime failure injection performed** (single-process, no orchestrator)

---

## AREAS EXAMINED

Job lifecycle · retry/backoff · stale recovery · maintenance sweeps · logging · metrics · alerting · backup/restore · silent failure paths.

---

## 1. Summary of examination

I read the worker state machine, the maintenance service, the logger and the job repository, then enumerated every `catch` block that continues execution. I also verified the startup recovery path and corrected an assumption I had carried in.

**Verdict: the job state machine is well designed and the logging is structured; the observability layer is almost entirely absent.** There is no metrics endpoint, no alerting, no backup tooling, and — the recurring pattern in this review — several failure paths that are logged at `warn` and then forgotten.

---

## 2. Files and components inspected

| File                                               | Checked                          |
| -------------------------------------------------- | -------------------------------- |
| `apps/backend/src/services/worker.ts`              | 282 LOC — claim, retry, recovery |
| `apps/backend/src/services/maintenance-service.ts` | 195 LOC — sweeps                 |
| `apps/backend/src/repositories/*job*`              | state transitions                |
| `apps/backend/src/logger.ts`                       | 74 LOC — structure, redaction    |
| `apps/backend/src/http/app.ts`                     | request logging hook             |
| `package.json`                                     | absence of backup scripts        |

---

## 3. Features examined

Job claim · extraction retry · dead-letter · startup recovery · retention sweep · export expiry · audit export · log correlation · health endpoint.

---

## 4. Tests performed

| #   | Test                                   | Result                                |
| --- | -------------------------------------- | ------------------------------------- |
| T1  | `npx jest worker-recovery maintenance` | **PASS**                              |
| T2  | `/metrics` endpoint                    | **ABSENT** — 0 occurrences            |
| T3  | `prom-client` dependency               | **ABSENT**                            |
| T4  | Alerting                               | **ABSENT**                            |
| T5  | `db:backup` script                     | **ABSENT**                            |
| T6  | Restore rehearsal                      | **NEVER PERFORMED**                   |
| T7  | Startup stale requeue                  | **PASS** — implemented and commented  |
| T8  | Mid-flight double-claim                | **NOT A RISK** — see correction below |
| T9  | Silent failure enumeration             | **6 paths found**                     |
| T10 | Health endpoint                        | **PASS** — `GET /health`              |
| T11 | Chaos / kill -9 test                   | **NOT RUN**                           |

---

## 5. Successful findings

1. **The job state machine is genuinely good**: transactional claim, exponential backoff, a `dead` terminal state, and a max-attempt cap. This is the part of the system most likely to be wrong in a young codebase, and it is right.
2. **Startup recovery is deliberate and documented.** `worker.ts:63-76` requeues jobs left `running` by a previous process, with a comment explaining that on a single instance nothing else can hold them and that without this a deploy would strand documents in `processing`.
3. **Logging is structured and correlated** — every line carries a request id, and `redact()` removes secrets and document values before serialisation.
4. **Maintenance sweeps are idempotent** and enqueue one purge job per organisation at a time rather than spawning duplicates.
5. **Retry backoff is exponential** with a cap, not a fixed interval.
6. **The worker drains at most 100 jobs per tick**, so a backlog cannot starve request handling in the same process.

---

## 6. Identified problems

### REL-001 — No metrics endpoint, so nothing can be alerted on

| Field            | Value                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **HIGH**                                                                                                                               |
| **Affected**     | `apps/backend/src/http/app.ts`; whole deployment                                                                                       |
| **Evidence**     | `grep -rn '/metrics' apps/backend/src` → 0. No `prom-client`, no OpenTelemetry, no StatsD. The only observability is stdout log lines. |
| **Expected**     | Queue depth, job outcomes, request latency, connector error rate                                                                       |
| **Actual**       | None machine-readable. An operator cannot answer "is the queue backing up?" without grepping logs.                                     |
| **Verification** | grep; dependency inventory                                                                                                             |

**Why HIGH:** the job system's failure mode is _silence_ — documents sit in `processing` and nothing complains. Without a queue-depth gauge there is no way to detect the most likely production incident.

**Recommended correction:** Expose `/metrics` with, at minimum: `idcp_jobs_queued`, `idcp_jobs_failed_total{reason}`, `idcp_job_duration_seconds`, `idcp_connector_errors_total{type}`, `idcp_http_request_duration_seconds`.

**Verification requirements:** A scrape succeeding in a deployed environment and one alert delivered to a human in a drill.

---

### REL-002 — No alerting exists at all

| Field            | Value                                                                |
| ---------------- | -------------------------------------------------------------------- |
| **Severity**     | **HIGH**                                                             |
| **Affected**     | Operations                                                           |
| **Evidence**     | No Alertmanager, no notification integration, no on-call definition. |
| **Expected**     | At least one alert that reaches a person                             |
| **Actual**       | None                                                                 |
| **Verification** | Repository-wide absence                                              |

**Recommended correction:** Even a cron job that emails "queue depth > N for 10 minutes" is a meaningful change from zero. Cross-ref OPS-004.

---

### REL-003 — Six failure paths log a warning and continue without tracking residue

| Field            | Value                                                                                                                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **HIGH**                                                                                                                                                                                                                                             |
| **Affected**     | `maintenance-service.ts:109`, `privacy-service.ts:220`, `maintenance-service.ts:54,170`, and two others                                                                                                                                              |
| **Evidence**     | Every file-deletion failure is `.catch(error => logger.warn(...))`. Examples: _"could not delete an expired export file"_, _"could not delete a draft document during erasure"_. Nothing records that a deletion did not happen; nothing retries it. |
| **Expected**     | Failures recorded and retried, or surfaced in a metric                                                                                                                                                                                               |
| **Actual**       | A log line that no one reads                                                                                                                                                                                                                         |
| **Verification** | `grep -rn "catch(error" apps/backend/src/services/ \| grep -A2 warn`                                                                                                                                                                                 |

**Why HIGH:** this is the mechanism by which retention and erasure promises quietly become false. It is the same root cause as PRIV-002 and DB-004 — recorded once here as the reliability pattern, and cross-referenced rather than duplicated.

**Recommended correction:** A `pending_deletions` table with a retry counter, plus a gauge of outstanding items.

---

### REL-004 — No backup or restore tooling, and no rehearsal

| Field            | Value                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **HIGH**                                                                                                                                                                                    |
| **Affected**     | Operations                                                                                                                                                                                  |
| **Evidence**     | No `db:backup` script, no backup documentation beyond guidance in `DEPLOYMENT.md`, no restore procedure, no RTO/RPO figure. `grep -rn "backup" package.json scripts/` → nothing executable. |
| **Expected**     | A tested restore                                                                                                                                                                            |
| **Actual**       | Untested, and untestable without a documented procedure                                                                                                                                     |
| **Verification** | Script inventory                                                                                                                                                                            |

**Why HIGH:** an untested backup is not a backup. Combined with DB-001 (PostgreSQL never run), a restore has certainly never been performed.

**Recommended correction:** Write and execute a restore drill on a copy; record RTO/RPO. This is a Gate 4 criterion.

---

### REL-005 — Retention sweep failure is a single warning line

| Field        | Value                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity** | **MEDIUM**                                                                                                                                              |
| **Affected** | `maintenance-service.ts:54-56`                                                                                                                          |
| **Evidence** | `catch (error) { this.logger.warn('maintenance step failed', ...) }` — the sweep continues and never retries the failed step until the next 24 h cycle. |
| **Expected** | Per-step retry with backoff, and a metric                                                                                                               |
| **Actual**   | One warn per day                                                                                                                                        |

---

### REL-006 — Health endpoint reports liveness, not readiness

| Field            | Value                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| **Severity**     | **MEDIUM**                                                                                            |
| **Affected**     | `GET /health`                                                                                         |
| **Evidence**     | The endpoint returns a status without checking the database, the worker loop, or the storage backend. |
| **Expected**     | Readiness distinguishes "process up" from "can serve"                                                 |
| **Actual**       | Only the former                                                                                       |
| **Verification** | Read the handler                                                                                      |

**Recommended correction:** Add `/ready` that attempts a trivial DB query and confirms the worker timer is active.

---

## 7. Missing functionality

| Item                          | Status              |
| ----------------------------- | ------------------- |
| `/metrics`                    | **Not implemented** |
| Alerting                      | **Not implemented** |
| Backup/restore tooling        | **Not implemented** |
| Deletion residue tracking     | **Not implemented** |
| Readiness probe               | **Not implemented** |
| Distributed tracing           | **Not implemented** |
| Chaos/failure injection tests | **Not implemented** |

---

## 8. Security concerns

Log redaction is correct. No secret found in log output. The absence of audit-log shipping means an incident investigation would depend on stdout retention, which is unmanaged.

---

## 9. Performance concerns

Worker and API share one process (DEC-029), so OCR competes with request handling. Cross-ref PERF-002.

---

## 10. Recommendations

1. **Add `/metrics` and one alert (REL-001/002).** Without this, no other reliability work is verifiable.
2. **Track deletion failures (REL-003)** — resolves PRIV-002/DB-004 at the root.
3. **Write and run a restore drill (REL-004).**
4. Separate readiness from liveness (REL-006).

---

## EVIDENCE CLASSIFICATION

| Class                        | Items                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **A. Verified working**      | Job state machine, startup recovery, structured logging, redaction, idempotent sweeps, backoff, drain cap, health endpoint |
| **B. Verified failing**      | REL-003, REL-005                                                                                                           |
| **C. Not implemented**       | Metrics, alerting, backup, residue tracking, readiness, tracing, chaos                                                     |
| **D. Partially implemented** | Health (liveness only); deletion (attempted, not tracked)                                                                  |
| **E. Unable to verify**      | Behaviour under kill -9, restore time, alert delivery — no orchestrator, no backups, no channel                            |

**Correction to a prior assumption:** I had suspected `RECOVERY_GRACE_MS = 30_000` could mid-flight requeue a long OCR job and cause double processing. Reading `start()` shows `requeueStale` runs **once at startup only**, and the comment explains why that is safe on a single instance. **No double-claim risk exists in single-process operation.** It would become a risk under multi-replica deployment (which DEC-029 already forbids).

---

## ISSUE SUMMARY

| ID      | Severity | Title                                       |
| ------- | -------- | ------------------------------------------- |
| REL-001 | **HIGH** | No `/metrics`; nothing alertable            |
| REL-002 | **HIGH** | No alerting                                 |
| REL-003 | **HIGH** | 6 silent failure paths; no residue tracking |
| REL-004 | **HIGH** | No backup/restore; never rehearsed          |
| REL-005 | MEDIUM   | Retention sweep failure = one warn line     |
| REL-006 | MEDIUM   | Health is liveness only                     |

**Totals: 0 CRITICAL · 4 HIGH · 2 MEDIUM · 0 LOW**
