# REVIEWER NAME: Backend Engineer — HTTP API & domain services (R02)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R02-backend-engineer.md` (38 checklist items)
**STATUS:** ☑ Complete

---

## AREAS EXAMINED

HTTP layer · 16 route files / 101 routes · 18 services · error envelope · input validation · transactional integrity · idempotency · rate limiting · pagination · logging.

---

## 1. Summary of examination

I read the composition root, the app factory, the guard chain, and sampled route files across the highest-risk domains (auth, document, batch, connector, export), then traced each into its service. I executed the suite (406 tests) and verified route registration counts by grepping the route modules directly.

**Verdict: the service layer is disciplined and the error handling is deliberate.** Validation happens at the route boundary with Zod schemas; the error envelope is uniform and masks internals; every handler authenticates before touching data. The defects I found are narrow and specific — most notably a **storage-before-transaction ordering** in document upload that can leave a permanent orphan blob.

---

## 2. Files and components inspected

| File | LOC | Checked |
|---|---|---|
| `apps/backend/src/http/app.ts` | 238 | plugin order, hooks, error handler, body limits |
| `apps/backend/src/http/guards.ts` | 107 | authorship of `resolveActor`, all 3 credential types |
| `apps/backend/src/http/routes/document-routes.ts` | — | upload validation, idempotency key sanitiser |
| `apps/backend/src/http/routes/batch-routes.ts` | — | multipart iteration, buffering |
| `apps/backend/src/http/routes/auth-routes.ts` | — | forgot/reset/change flows |
| `apps/backend/src/services/document-service.ts` | — | upload transaction boundary |
| `apps/backend/src/services/container.ts` | 88 | DI wiring |
| All 16 route files | — | route counts: 101 total |

---

## 3. Features examined

Document upload · batch creation · authentication flows · connector CRUD · export · review workflow · project/template management · audit export · rate limiting · error envelope.

---

## 4. Tests performed

| Test | Method | Result |
|---|---|---|
| T1 Full suite | `npm run verify` | **PASS** — 406/406, 30 suites |
| T2 Route count | grep `app.(get\|post\|put\|patch\|delete)` across route files | **101** |
| T3 Input validation present | read 5 route files | **PASS** — Zod at boundary |
| T4 Error masking | read `app.ts` error handler | **PASS** — internals masked |
| T5 Transaction integrity | read `document-service.ts:115-145` | **FAIL** — see BE-001 |
| T6 Idempotency | read `sanitiseIdempotencyKey` | **PASS** — malformed key ignored, not fatal |
| T7 Rate limiting | read `AttemptLimiter` usage | **PASS functionally**, **FAIL on memory** (BE-003) |

---

## 5. Successful findings

1. **The error envelope never leaks internals.** Non-`AppError` exceptions are masked to a generic shape with a request id; the real error is logged server-side. This is correct and tests confirm it.
2. **Validation is at the boundary, not scattered.** `CreateBatchRequestSchema`, `ForgotPasswordRequestSchema` etc. are `safeParse`d before any service call, with user-facing messages.
3. **Idempotency keys are sanitised defensively.** A malformed key is *ignored* rather than rejecting an otherwise valid upload (`document-routes.ts:18-21`) — a mature choice that avoids turning a client bug into a failed upload.
4. **Multipart limits are layered.** Global `files: MAX_BATCH_FILES + 1`, per-route `files: 1` for single upload, and a per-file byte cap.

---

## 6. Identified problems

### BE-001 — Document upload writes the blob **before** opening the DB transaction, leaving permanent orphans

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | `apps/backend/src/services/document-service.ts:116-118` |
| **Evidence** | `await this.storage.put(storageKey, input.buffer, mimeType);` on line 116; `const document = await this.db.transaction(...)` on line 118. If the transaction throws (constraint, connection loss, audit failure), the blob remains on disk with no row referencing it. |
| **Expected** | Blob and row are created atomically, or an orphan sweeper reconciles them |
| **Actual** | No sweeper exists. `maintenance-service.ts` contains only `retention_purge`; `grep -rn "orphan"` across services returns nothing. |
| **Verification** | STATIC — read the two lines in order; confirm absence of a reconciler |

**Recommended correction:** Either (a) move `storage.put` inside the transaction and accept that a rollback leaves a blob (then add the sweeper), or (b) keep the order and **add a periodic orphan sweep** comparing `storage` keys against `documents.storage_key`. Option (b) is safer because holding a DB transaction open across an I/O write is its own hazard.

**Verification requirements:** A test that forces the transaction to fail and then asserts either "no blob remains" or "the sweeper removes it within N minutes".

---

### BE-002 — Batch upload buffers all files in memory before checking the file-count cap

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | `apps/backend/src/http/routes/batch-routes.ts:33` |
| **Evidence** | `files.push({ buffer: await part.toBuffer(), filename: part.filename })` inside `for await (const part of request.parts())`. The `MAX_BATCH_FILES` check lives in `batch-service.ts:61`, i.e. **after** the loop completes. |
| **Expected** | Reject before allocating; stream to storage |
| **Actual** | Up to `MAX_BATCH_FILES + 1` files × `MAX_UPLOAD_MB` are held simultaneously. Defaults: 101 × 20 MB ≈ **2 GB RSS per request**. |
| **Verification** | STATIC + arithmetic from `config.ts:48-49` |

**Recommended correction:** Count parts and abort as soon as `index > MAX_BATCH_FILES`; and write each part to storage as it arrives rather than accumulating buffers. See also PERF-001.

**Verification requirements:** A test posting 101 small files asserting a 400 before the 101st is buffered; a memory assertion under a synthetic large batch.

---

### BE-003 — `AttemptLimiter` map grows without bound

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | `apps/backend/src/auth/tokens.ts:106` |
| **Evidence** | `private readonly hits = new Map<string, { count: number; resetAt: number }>()`. Entries are overwritten on access but **never deleted**; expiry is checked lazily only when the same key returns. |
| **Expected** | Bounded memory under unbounded distinct keys |
| **Actual** | Distinct keys (IPs, emails) accumulate forever. A spray from many source addresses grows the map monotonically. |
| **Verification** | STATIC |

**Recommended correction:** Amortised sweep on a size threshold, or a fixed-capacity LRU.

---

### BE-004 — Rate-limit state is per-process, so the documented single-process constraint is load-bearing for security

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | `apps/backend/src/auth/tokens.ts:105-128`; `PASSWORD_RESET`/login routes |
| **Evidence** | `AttemptLimiter` is constructed per process in `container.ts:57`. With two replicas, the effective limit doubles per replica. |
| **Expected** | Documented as a hard constraint on scaling |
| **Actual** | `DEC-029` documents single-process generally, but not this specific security coupling |
| **Verification** | STATIC |

**Recommended correction:** Record in `DEC-029` and `SECURITY.md` that brute-force protection is per-process; block horizontal scale-out until it is shared state.

---

## 7. Missing functionality

| Item | Status |
|---|---|
| Orphan-blob reconciliation | **Not implemented** (BE-001) |
| Streaming upload path | **Not implemented** — everything is `toBuffer()` |
| Distributed rate limiting | **Not implemented** |
| Structured request-level metrics | **Not implemented** — logs only |

---

## 8. Security concerns

`AttemptLimiter` unbounded growth is a slow memory-exhaustion vector (BE-003). Per-process rate limiting (BE-004) weakens brute-force protection under any multi-replica deployment. No injection risk found: all SQL is parameterised and the placeholder rewriter is correct.

---

## 9. Performance concerns

Batch buffering (BE-002) is the dominant risk: a single request can allocate ~2 GB. See PERF-001 for the fuller analysis.

---

## 10. Recommendations

1. Fix BE-002 first — it is the only defect here that lets one authenticated request exhaust the process.
2. Add the orphan sweeper (BE-001) before any retention/erasure audit.
3. Bound `AttemptLimiter`.
4. Keep the boundary-validation pattern; it is applied consistently.

---

## EVIDENCE CLASSIFICATION

| Class | Items |
|---|---|
| **A. Verified working** | Error envelope, boundary validation, idempotency sanitisation, multipart limits, 406 tests |
| **B. Verified failing** | BE-001, BE-002, BE-003, BE-004 |
| **C. Not implemented** | Orphan sweeper, streaming upload, distributed rate limit, metrics |
| **D. Partially implemented** | Upload atomicity (rows atomic, blob not) |
| **E. Unable to verify** | Behaviour under a second replica |

---

## ISSUE SUMMARY

| ID | Severity | Title |
|---|---|---|
| BE-001 | HIGH | Blob written before transaction; orphans never reconciled |
| BE-002 | HIGH | Batch buffers ~2 GB before enforcing file cap |
| BE-003 | MEDIUM | `AttemptLimiter` map unbounded |
| BE-004 | MEDIUM | Rate limiting is per-process; blocks scale-out |

**Totals: 0 CRITICAL · 2 HIGH · 2 MEDIUM · 0 LOW**
