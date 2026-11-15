# REVIEWER 17 — PERFORMANCE & SCALABILITY ENGINEER

| Field | Value |
|-------|-------|
| **Reviewer ID** | R17 |
| **Title** | Performance & Scalability Engineer |
| **Board** | E — Quality, performance & reliability |
| **Wave** | 4 (weeks 6–8) — **blocked until R03 settles PostgreSQL** |
| **Effort** | 10 person-days |
| **Gate chaired** | **G6 — Performance & reliability approval** |
| **Co-signs** | none |
| **Evidence to** | G2, G10 (contributes findings, not an approver) |
| **Finding prefix** | `PERF-###` |
| **Upstream** | **R03 (must confirm the production database works first)**, R02 (route registry) |
| **Downstream** | R18, R19 (capacity envelope), R22 |
| **Status** | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Replace assertion with measurement. The product makes performance claims — a "live" dashboard, a "2-second"
analytics target, per-document AI latency — and **none of them has ever been measured**. Establish the real
numbers, find the first bottleneck, and state a capacity envelope a salesperson and a support engineer can
both rely on.

### 1.1 ⚠ HARD BLOCKER: do not start until R03 resolves the database

The measure-then-report order matters:

| If … | Then measuring performance is … |
|------|--------------------------------|
| PostgreSQL works and migrations apply | Valid. Measure on the production driver. |
| PostgreSQL is broken (R-04) | **Meaningless.** You would benchmark SQLite and report numbers for a system that cannot be deployed. |

`AGENT_STATE.md` admits the `pg` path is "typechecked but never executed". Confirm R03's verdict before
spending any of your 10 days. If R03 has not finished, work on §6.1 (static analysis) only.

---

## 2. Required expertise

- Load and soak testing (k6, autocannon, artillery) and result interpretation (p50/p95/p99, throughput, error rate)
- Node.js event-loop analysis, `perf_hooks`, heap snapshots, GC behaviour
- SQLite concurrency limits (WAL, write locks, `busy_timeout`) and PostgreSQL connection pooling
- Streaming vs buffering I/O in Node
- SSE fan-out and backpressure
- Capacity planning and cost-per-document thinking

---

## 3. Repository context (self-contained)

**Product.** Upload a document → OCR/extract in an in-process worker → human review → export/connector write.
Everything runs in **one process** (DEC-029) with an **in-process** job queue in the `jobs` table.

**Performance-relevant implementation:**

| Element | Path | Size / value |
|---------|------|--------------|
| Worker loop and poll interval | `apps/backend/src/services/worker.ts` | 282; `WORKER_POLL_INTERVAL_MS` **500 ms** |
| Job claim, backoff, dead-letter | `apps/backend/src/repositories/system-repo.ts` | 203 |
| Batch upload (**buffers in memory**) | `apps/backend/src/services/batch-service.ts` | 223; `MAX_BATCH_FILES` cap |
| Export generation (exceljs) | `apps/backend/src/services/export-service.ts` | 228; `listApproved` capped at **10 000** |
| OCR subprocess fan-out | `apps/backend/src/ai/providers/tesseract.ts` | 116; 60 s timeout, 32 MB `maxBuffer` |
| SSE hub | `apps/backend/src/realtime/hub.ts` | 104 |
| Rate limiter (in-process, unbounded map) | `apps/backend/src/auth/tokens.ts` `AttemptLimiter` | 141 |
| DB drivers | `apps/backend/src/db/{sqlite,postgres}.ts` | 90 / 80 |
| Upload limits | `apps/backend/src/config.ts` | `MAX_UPLOAD_MB` **20**, `MAX_REQUEST_MB` **50** |
| Pool size | `apps/backend/src/config.ts` | `DATABASE_POOL_SIZE` **10** |
| Dashboard target | `PRD.json` `DASH-001` | **"2 seconds" — asserted by design, never measured** |

**Unmeasured claims to test:**

| Claim | Source |
|-------|--------|
| "2-second dashboard" | `DASH-001` verification block |
| Analytics is "a 14-day (up to 90) SVG chart" with the target "asserted by design (bounded window, indexed query), not by a load test" | `AGENT_STATE.md` gap 5 |
| "API is stateless (scale horizontally); workers scale on queue depth" | `ARCHITECTURE.md` §7 |
| Batch is "bounded" by the 100-file cap and 20 MB per-file limit | `AGENT_STATE.md` gap 4 |

---

## 4. Exact files and components to examine

### 5.1 Must read in full

`services/worker.ts` · `repositories/system-repo.ts` · `services/batch-service.ts` ·
`services/export-service.ts` · `realtime/hub.ts` · `auth/tokens.ts` (the limiter) ·
`db/{sqlite,postgres,database}.ts` · `config.ts` · `services/document-service.ts` ·
`ai/providers/tesseract.ts` · `http/routes/document-routes.ts` · `http/routes/batch-routes.ts` ·
`http/routes/export-routes.ts` · `http/routes/dashboard`-serving route (in `organisation-routes.ts` or a
dedicated file — locate it) · `services/review-service.ts` (bulk approve).

### 5.2 Must check the indexes

`apps/backend/src/db/migrations.ts` — 29 indexes. Confirm the hot-path indexes exist:
`documents(organisation_id, status, created_at)`, `documents(organisation_id, idempotency_key)`,
`jobs(status, run_after)`, `extractions(document_id)`, `audit_logs(organisation_id, created_at)`,
`sessions(refresh_token_hash)`.

### 5.3 Explicit non-goals

Correctness of the job state machine → R18 · schema portability → R03 · cost of security controls per se → R07 ·
UI responsiveness perception → R12.

---

## 5. Upstream artefacts required

**You are runtime-blocked until R03 settles the database.** Static review may proceed; no benchmark number
produced on SQLite may be presented as a production figure.

| From | Artefact | Why |
|------|----------|-----|
| **R03** | `evidence/R03/pg-verdict.md` — does PostgreSQL run the migrations and the suite? | Determines whether any timing is meaningful |
| R03 | `evidence/R03/index-plan.md` | Predicates you must confirm are indexed |
| R02 | `evidence/R02/route-map.md` | Route → service → repository call paths |
| R18 | `evidence/R18/slo-proposal.md` | Target latencies to test against |
| R19 | `evidence/R19/reference-hardware.md` | The machine your numbers describe |

## 6. Checklist

### 6.1 Static analysis of known bottlenecks

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| PERF-01 | Quantify batch memory: files held as `Buffer` × 100 × 20 MB | Read `batch-service.ts`; compute worst case | Worst case ≈ 2 GB (or whatever it is) — a hard finding | STATIC |
| PERF-02 | Confirm whether the batch path streams or buffers | Read | **Buffers** — record | STATIC |
| PERF-03 | Quantify OCR process fan-out | Read the worker's concurrency | Is it bounded? If unbounded, N concurrent documents spawn N `tesseract` processes | STATIC |
| PERF-04 | `tesseract` uses `execFile` with a 60 s timeout and 32 MB `maxBuffer` | Read | Per-process memory cost estimated | STATIC |
| PERF-05 | The job poll is 500 ms per process | `WORKER_POLL_INTERVAL_MS` | Polling overhead at idle measured | STATIC |
| PERF-06 | SQLite write-lock behaviour under concurrent writers | Read `sqlite.ts` pragmas (WAL? busy_timeout?) | Documented | STATIC |
| PERF-07 | `node:sqlite` is **synchronous** | Confirm the API used | A slow query blocks the event loop — quantify | STATIC |
| PERF-08 | `AttemptLimiter.hits` never evicts | Read `tokens.ts` | Unbounded growth — measure under abuse | STATIC |
| PERF-09 | Export is fully buffered in memory | Read `export-service.ts` (exceljs) | 10 000-row memory cost estimated | STATIC |
| PERF-10 | SSE hub broadcasting strategy | Read `hub.ts` | Per-org filtering or global fan-out | STATIC |
| PERF-11 | Dashboard query shape | Find the analytics route + SQL | Bounded window, indexed | STATIC |
| PERF-12 | Connection pool 10 vs concurrency | `DATABASE_POOL_SIZE` | Pool exhaustion point identified | STATIC |

### 6.2 Baseline single-user latency

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| PERF-13 | Measure `GET /health` | k6/autocannon | p95 recorded | **RUNTIME** |
| PERF-14 | Measure sign-in | Same | p95 | **RUNTIME** |
| PERF-15 | Measure document upload (1 MB, 5 MB, 20 MB) | Same | p95 per size | **RUNTIME** |
| PERF-16 | Measure list documents (100 / 1 000 / 100 000 rows) | Same | p95 per size | **RUNTIME** |
| PERF-17 | Measure the dashboard/analytics endpoint | Same | **p95 vs the 2 s claim** | **RUNTIME** |
| PERF-18 | Measure extraction wall time per document type | Timed runs | p50/p95 per type | **RUNTIME** |
| PERF-19 | Measure review approve/correct | Same | p95 | **RUNTIME** |
| PERF-20 | Measure export generation (1k / 10k rows) | Same | p95 + memory | **RUNTIME** |
| PERF-21 | Measure SSE connection establishment and event delivery latency | Instrument | p95 | **RUNTIME** |

### 6.3 Load and saturation

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| PERF-22 | Concurrent uploads: 10 / 50 / 200 / 1 000 | k6 ramp | Throughput curve + error rate | **RUNTIME** |
| PERF-23 | Concurrent sign-ins (Argon2id is CPU-heavy at 64 MiB) | k6 | **Find the CPU saturation point** — this is likely the first real bottleneck | **RUNTIME** |
| PERF-24 | Concurrent SSE clients: 10 / 100 / 500 | k6 | Memory per client + fan-out cost | **RUNTIME** |
| PERF-25 | Queue depth growth under sustained upload | Sustained 1 h | Does the worker keep up? | **RUNTIME** |
| PERF-26 | Two API replicas + one DB | Run both | Where does in-process state break | **RUNTIME** |
| PERF-27 | Write contention on SQLite with 2 workers | Run both | Error rate / lock waits | **RUNTIME** |
| PERF-28 | Identify **the first bottleneck** | From the above | A single, named cause | **WRITE** |

### 6.4 Soak and resource behaviour

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| PERF-29 | 1-hour soak at moderate load | k6 constant arrival | No memory growth, no latency drift | **RUNTIME** |
| PERF-30 | Heap profile before/after | `node --inspect` / `heapdump` | Flat, or growth explained | **RUNTIME** |
| PERF-31 | Rate-limiter map growth under 100 000 distinct keys | Script | Measured RSS delta | **RUNTIME** |
| PERF-32 | File descriptor / temp file leak under OCR load | `lsof` before/after | No leak | **RUNTIME** |
| PERF-33 | Disk growth of `STORAGE_PATH` under load | Measure | Linear, as expected | **RUNTIME** |
| PERF-34 | Job table growth and index performance at 1 M rows | Seed | Query time stable | **RUNTIME** |

### 6.5 Database performance

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| PERF-35 | `EXPLAIN ANALYZE` the 8 hot queries on PostgreSQL | Run | Index scans, not seq scans | **RUNTIME** |
| PERF-36 | Same on SQLite with `EXPLAIN QUERY PLAN` | Run | Index usage | **RUNTIME** |
| PERF-37 | N+1 query detection on list endpoints | Count queries per request | Bounded | **RUNTIME** |
| PERF-38 | Pagination performance at depth (cursor far in) | Request page 1 000 | Constant-ish | **RUNTIME** |
| PERF-39 | Migration duration on a production-size table | Time it | Within a maintenance window | **RUNTIME** |
| PERF-40 | Connection pool saturation under 200 concurrent requests | k6 + pg logs | Queuing behaviour documented | **RUNTIME** |

### 6.6 Capacity envelope and cost

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| PERF-41 | State docs/day capacity on the reference hardware | From PERF-25 | A number | **WRITE** |
| PERF-42 | State concurrent-user capacity | From PERF-22/23 | A number | **WRITE** |
| PERF-43 | State storage growth per 1 000 documents | Measure | A number | **WRITE** |
| PERF-44 | State the hardware profile measured | Record CPU/RAM/disk | Reproducible | **WRITE** |
| PERF-45 | Identify the **first component to scale** | From PERF-28 | Named, with a trigger metric | **WRITE** |
| PERF-46 | Cost per 1 000 documents (CPU time + storage + optional cloud AI) | Compute | A number | **WRITE** |

---

## 7. Known performance risks to confirm or refute

| Risk | Statement | Severity |
|------|-----------|----------|
| **R-12 (MEDIUM)** | Batch uploads buffer up to `MAX_BATCH_FILES × MAX_UPLOAD_MB` in memory | MEDIUM |
| **R-13 (MEDIUM)** | DASH-001's 2-second target has never been measured | MEDIUM |
| R-18 | `AttemptLimiter` map is unbounded and grows under abuse | MEDIUM |
| R-11 | No `/metrics`, so saturation is invisible in production | MEDIUM |
| R-24 | `node:sqlite` is synchronous and experimental | LOW/MEDIUM |
| — | Argon2id at 64 MiB/t=3 is deliberately expensive: concurrent logins are a CPU DoS surface | Assess |

---

## 8. Questions you must answer

1. **What is the measured p95 for the dashboard, and does it meet the 2-second claim?**
2. What is the first bottleneck under load, and at what concurrency does it appear?
3. Does a 100-file × 20 MB batch OOM the process before the cap is reached?
4. How many concurrent logins can one CPU core sustain given Argon2id's cost?
5. What is the capacity envelope in documents/day on the reference hardware?
6. How many SSE clients can one process hold?
7. Does anything grow without bound over a one-hour soak?

---

## 9. Commands to run

```bash
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund

# ---------- confirm R03 verdict FIRST ----------
grep -n "PostgreSQL verdict" docs/reviewers/evidence/R03/*.md 2>/dev/null || echo "R03 not done — static analysis only"

# ---------- static bottleneck checks ----------
grep -n "buffer\|Buffer" apps/backend/src/services/batch-service.ts | head
grep -n "MAX_BATCH_FILES" -r apps/backend/src
grep -n "WORKER_POLL_INTERVAL_MS\|DATABASE_POOL_SIZE\|MAX_UPLOAD_MB\|MAX_REQUEST_MB" apps/backend/src/config.ts
grep -n "execFile\|timeout\|maxBuffer" apps/backend/src/ai/providers/tesseract.ts
grep -n "pragma\|WAL\|busy_timeout" apps/backend/src/db/sqlite.ts
grep -n "hits\." apps/backend/src/auth/tokens.ts
sed -n '1,104p' apps/backend/src/realtime/hub.ts

# ---------- harness ----------
npm i -D autocannon k6 2>/dev/null   # or install k6 as a binary
npm run db:migrate && npm run db:seed
NODE_ENV=production JWT_SECRET=$(openssl rand -hex 32) CORS_ORIGINS=http://x \
  npm run dev:backend &

# ---------- latency ----------
npx autocannon -c 1 -d 10 http://127.0.0.1:4000/api/v1/health
npx autocannon -c 50 -d 30 http://127.0.0.1:4000/api/v1/documents -H "Authorization: Bearer $TOKEN"

# ---------- saturation: sign-in (Argon2id CPU) ----------
npx autocannon -c 50 -d 30 -m POST http://127.0.0.1:4000/api/v1/auth/login \
  -H 'content-type: application/json' -d '{"email":"owner@example.com","password":"demo-password-change-me"}'

# ---------- 100k-document dashboard ----------
node -e "/* seed 100k documents via SQL directly for speed */"
curl -s -o /dev/null -w "dashboard=%{time_total}s\n" http://127.0.0.1:4000/api/v1/dashboard -H "Authorization: Bearer $TOKEN"

# ---------- batch memory ----------
/usr/bin/time -v curl -s -X POST http://127.0.0.1:4000/api/v1/batches -H "Authorization: Bearer $TOKEN" \
  -F "files=@big1.jpg" -F "files=@big2.jpg" ... # up to the cap
# watch RSS:  ps -o rss= -p $(pgrep -f "tsx watch src/index")

# ---------- soak ----------
npx autocannon -c 20 -d 3600 http://127.0.0.1:4000/api/v1/health > /tmp/soak.log
ps -o rss= -p $(pgrep -f "tsx watch src/index")

# ---------- query plans ----------
DB_DRIVER=postgres DATABASE_URL=… psql "$DATABASE_URL" -c "EXPLAIN ANALYZE SELECT * FROM documents WHERE organisation_id='…' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 25;"
sqlite3 ./local-storage/idcp.db "EXPLAIN QUERY PLAN SELECT * FROM documents WHERE organisation_id='…' ORDER BY created_at DESC LIMIT 25;"
```

---

## 10. Tests to perform

| # | Test | Procedure | Pass criterion |
|---|------|-----------|----------------|
| T-01 | Latency baseline | 9 endpoints × 3 dataset sizes | p50/p95/p99 table |
| T-02 | Dashboard vs claim | 100k documents | Measured number vs 2 s |
| T-03 | Upload concurrency ramp | 10→1 000 | Throughput curve + saturation point |
| T-04 | Login concurrency | 50 concurrent | CPU saturation identified |
| T-05 | SSE scale | 10/100/500 clients | Memory per client |
| T-06 | Batch memory | 100 × 20 MB | RSS and outcome |
| T-07 | 1-hour soak | 20 conn/s | Flat memory |
| T-08 | Limiter growth | 100k keys | Measured delta |
| T-09 | Query plans | 8 hot queries, both drivers | Index usage |
| T-10 | Pool saturation | 200 concurrent | Documented behaviour |
| T-11 | Two replicas | Run both | Where state breaks |
| T-12 | 1M-row job table | Seed | Query time stable |

---

## 11. Evidence required

```
docs/reviewers/evidence/R17/
├── reference-hardware.md        # CPU/RAM/disk/OS/Node version measured
├── latency-baseline.md          # T-01, T-02
├── load-curves.md               # T-03, T-04, T-05, T-10
├── batch-memory.md              # T-06 with RSS samples
├── soak-report.md               # T-07, T-08
├── query-plans.md               # T-09
├── capacity-envelope.md         # PERF-41 … PERF-46
├── bottleneck-ranking.md        # PERF-28 + the scale-out order
├── commands.log
└── findings.md                  # PERF-### register
```

---

## 12. Passing conditions (chairs G6)

- [ ] **P1** R03's database verdict is known before any numbers are reported (PERF pre-condition).
- [ ] **P2** Every endpoint in §6.2 has a measured p50/p95/p99 on stated hardware (PERF-13 … PERF-21, T-01).
- [ ] **P3** The 2-second dashboard claim is either met or restated with the measured value (PERF-17, T-02).
- [ ] **P4** The batch memory path is measured and bounded, or capped so it cannot OOM (PERF-01, PERF-02, T-06).
- [ ] **P5** The first bottleneck is identified and named with a trigger metric (PERF-28, PERF-45, T-03, T-04).
- [ ] **P6** A one-hour soak shows no unbounded growth (PERF-29 … PERF-32, T-07).
- [ ] **P7** Hot queries use indexes on both drivers (PERF-35, PERF-36, T-09).
- [ ] **P8** A capacity envelope exists in documents/day, concurrent users and storage growth (PERF-41 … PERF-44).
- [ ] **P9** Cost per 1 000 documents is estimated (PERF-46).
- [ ] **P10** Multi-replica behaviour is documented, including which in-process state fails first (PERF-26, T-11).

---

## 13. Blocked items

| Item ID | Blocker | What unblocks it | Owner |
|---------|---------|------------------|-------|
| ALL runtime items | R03 has not confirmed the PostgreSQL path | R03 finishing DB-AC-08 | R03 |
| PERF-10+ | No production-like hardware | Provision a representative VM | R19 |

---

## 14. Findings register

| ID | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
|----|----------|-----------|---------|----------------|-----------|---------------|-------|
| PERF-001 | | | | | | | |

---

## 15. Reviewer sign-off

| Field | Value |
|-------|-------|
| Reviewer name | |
| Date started | |
| Date completed | |
| **Gate G6 result** | ☐ Pass ☐ Fail |
| Dashboard p95 measured | |
| First bottleneck | |
| Capacity (docs/day) | |
| Conditions failed (IDs) | |
| Reviewed commit | `43d384b` |
| Statement | *I waited for R03's database verdict before measuring, and every number in this report was produced on the stated hardware with the stated driver.* |
| Signature | |
