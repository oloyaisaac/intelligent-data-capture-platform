# REVIEWER NAME: Performance & Scalability Engineer (R17)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R17-performance-scalability.md` (46 checklist items)
**STATUS:** ☑ Complete — **all runtime measurement blocked** (no PostgreSQL, no load harness)

---

## AREAS EXAMINED

Upload path memory · batch buffering · synchronous SQLite · dashboard query · pagination · event-loop blocking · connection pooling · unbounded structures · the `DASH-001` 2-second claim.

---

## 1. Summary of examination

I traced allocation behaviour on the hot paths by reading code, computed worst-case memory arithmetically, and attempted to establish a benchmark baseline. The attempt failed for a structural reason: **there is no load-testing tool, no production database, and no dataset.**

**Verdict: no performance number in this repository is measured.** Every claim is derived by reasoning, and I found one arithmetic risk that is severe enough to be a defect rather than a benchmark gap.

---

## 2. Files and components inspected

| File | Checked |
|---|---|
| `apps/backend/src/http/routes/batch-routes.ts` | multipart buffering |
| `apps/backend/src/services/batch-service.ts` | `MAX_BATCH_FILES` placement |
| `apps/backend/src/config.ts` | `MAX_UPLOAD_MB`, `MAX_REQUEST_MB` |
| `apps/backend/src/db/sqlite.ts` | synchronous driver |
| `apps/backend/src/auth/tokens.ts` | `AttemptLimiter` |
| `apps/backend/src/services/organisation-service.ts` | dashboard aggregate |

---

## 3. Features examined

Document upload · batch upload · extraction throughput · dashboard aggregation · export generation · job polling · rate-limit memory.

---

## 4. Tests performed

| # | Test | Result |
|---|---|---|
| T1 | Batch worst-case arithmetic | **FAIL — PERF-001** |
| T2 | Load harness present | **NONE** |
| T3 | PostgreSQL available for benchmarking | **NO** |
| T4 | Dataset present | **NO** |
| T5 | Dashboard 2 s target measured | **NO** — PRD admits it: "asserted by design … not by a load test or a real dataset" |
| T6 | SQLite synchronous confirmation | **PASS** — `node:sqlite` is sync by design |
| T7 | `AttemptLimiter` bounded | **NO** — BE-003 |
| T8 | Pagination caps | **PASS** — `MIN(limit, 100)` |
| T9 | Connection pooling | PG pool exists; SQLite n/a |

---

## 5. Successful findings

1. **List endpoints are capped** at 100 (`Math.min(limit, 100)`), so no endpoint can return an unbounded set.
2. **The dashboard uses a bounded 90-day window with an indexed query** — the *design* is defensible, even though the target is unmeasured.
3. **A PostgreSQL pool exists** with a statement timeout ("Reject queries slower than this so a bad query cannot wedge a request forever") — the right instinct.
4. **The worker processes at most 100 jobs per drain**, preventing a single tick from monopolising the loop.
5. **Retry backoff is exponential**, so a failing connector does not spin.

---

## 6. Identified problems

### PERF-001 — Batch upload buffers up to ~2 GB per request before enforcing its own cap

| Field | Value |
|---|---|
| **Severity** | **CRITICAL** |
| **Affected** | `apps/backend/src/http/routes/batch-routes.ts:33` |
| **Evidence** | `files.push({ buffer: await part.toBuffer(), filename: part.filename })` inside `for await (const part of request.parts())`. Multipart is configured `files: MAX_BATCH_FILES + 1` (101). `MAX_BATCH_FILES = 100`, `MAX_UPLOAD_MB = 20`. The "at most 100 files" check lives in `batch-service.ts:61`, **after** the loop. |
| **Expected** | Reject before allocating; stream to storage |
| **Actual** | 101 × 20 MB ≈ **2 GB resident per request**. Two concurrent requests exhaust a 4 GB container. |
| **Verification** | Read line 33; `config.ts:48-49`; `batch-service.ts:29,61` — note the ordering |

**Why CRITICAL:** this is a remote denial-of-service available to any authenticated user with upload permission, requiring no malformed input — just a legitimate request at the documented limits. It is also trivially reachable from the product's own UI (batch upload).

**Recommended correction:**
1. Count parts and abort as soon as `index > MAX_BATCH_FILES`.
2. Stream each part to storage as it arrives; never hold more than one file in memory.
3. Keep a per-request byte cap enforced *during* streaming, not after.

**Verification requirements:** A test posting 101 small files asserting rejection before the 101st is buffered; a memory-profile test at the real cap.

---

### PERF-002 — `node:sqlite` blocks the event loop synchronously

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | `apps/backend/src/db/sqlite.ts` |
| **Evidence** | `node:sqlite`'s `DatabaseSync` is synchronous. Every query blocks the event loop for its full duration. |
| **Expected** | Acceptable for dev/test; unacceptable for production concurrency |
| **Actual** | The default driver is SQLite (`config.ts`), so a deployment that does not set `DB_DRIVER=postgres` runs on a blocking database |
| **Verification** | Read `sqlite.ts`; `DB_DRIVER` default is `sqlite` |

**Recommended correction:** This is another reason DB-001 must be resolved: production must run on PostgreSQL, and the default must not silently select a blocking driver.

---

### PERF-003 — The `DASH-001` two-second target is asserted, not measured

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | `PRD.json` DASH-001; `organisation-service.ts` |
| **Evidence** | The PRD's own block states: *"The 2-second target for 90 days is asserted by design (a bounded window and an indexed query), not by a load test or a real dataset."* |
| **Expected** | A measured p95 at a stated volume |
| **Actual** | Unmeasured |
| **Verification** | Read the verification block |

**Recommended correction:** Once PostgreSQL exists (DB-001), seed 100k documents and measure. Then either confirm 2 s or restate the target.

---

### PERF-004 — No load-testing capability exists at all

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | Test architecture |
| **Evidence** | No k6, autocannon, artillery, or benchmark script. |
| **Expected** | A repeatable harness |
| **Actual** | None |
| **Verification** | Dependency inventory |

---

### PERF-005 — Export generation builds full payloads in memory

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | `apps/backend/src/services/export-service.ts` |
| **Evidence** | `exceljs` writes to a buffer in memory; a large export is fully materialised before streaming. |
| **Expected** | Streamed writes with a row cap |
| **Actual** | Whole-workbook in memory |
| **Verification** | Read `export-service.ts` |

---

### PERF-006 — No throughput or cost baseline for extraction

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | AI pipeline |
| **Evidence** | Documents per minute and cost per 1,000 documents are unknown — yet both are needed for pricing (R22) and for capacity planning. |
| **Expected** | A baseline |
| **Actual** | None |

---

## 7. Missing functionality

| Item | Status |
|---|---|
| Load harness | **Not implemented** |
| Performance baseline | **Not implemented** |
| Streaming upload/export | **Not implemented** |
| Memory profiling | **Not implemented** |
| Index verification (EXPLAIN) | **Not implemented** |
| Capacity model | **Not implemented** |

---

## 8. Security concerns

PERF-001 is simultaneously a denial-of-service vulnerability. Rate limiting is per-process (BE-004), so a multi-replica deployment would multiply the exposure.

---

## 9. Performance concerns

Consolidated above. The single most urgent item is PERF-001; the most foundational is DB-001, because **no measurement taken on SQLite describes production.**

---

## 10. Recommendations

1. **Fix PERF-001 immediately** — it is a DoS, not a tuning issue.
2. Resolve DB-001, then build a minimal k6 harness and publish p50/p95/p99 for upload, extraction, dashboard, export.
3. Stream batch uploads and exports.
4. Measure extraction throughput once OCR runs.

---

## EVIDENCE CLASSIFICATION

| Class | Items |
|---|---|
| **A. Verified working** | Pagination caps, bounded dashboard window, PG statement timeout, drain cap, exponential backoff |
| **B. Verified failing** | **PERF-001 (CRITICAL)**, PERF-002 |
| **C. Not implemented** | Harness, baseline, streaming, profiling, EXPLAIN |
| **D. Partially implemented** | Dashboard (designed for the target, unmeasured) |
| **E. Unable to verify** | **Every runtime performance claim** — no PostgreSQL, no load tool, no dataset |

---

## ISSUE SUMMARY

| ID | Severity | Title |
|---|---|---|
| PERF-001 | **CRITICAL** | Batch upload buffers ~2 GB before cap check |
| PERF-002 | **HIGH** | Synchronous SQLite blocks the event loop |
| PERF-003 | MEDIUM | `DASH-001` 2 s target unmeasured |
| PERF-004 | MEDIUM | No load-testing capability |
| PERF-005 | MEDIUM | Export fully materialised in memory |
| PERF-006 | MEDIUM | No extraction throughput/cost baseline |

**Totals: 1 CRITICAL · 1 HIGH · 4 MEDIUM · 0 LOW**
