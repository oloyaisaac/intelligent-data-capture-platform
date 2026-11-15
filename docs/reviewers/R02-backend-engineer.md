# REVIEWER 02 — BACKEND ENGINEER (HTTP API & domain services)

| Field | Value |
|-------|-------|
| **Reviewer ID** | R02 |
| **Title** | Backend Engineer — HTTP API & domain services |
| **Board** | A — Architecture & core domain |
| **Wave** | 1 (weeks 1–2) |
| **Effort** | 12 person-days |
| **Gate chaired** | none |
| **Co-signs** | G1, G2 |
| **Finding prefix** | `BE-###` |
| **Upstream** | R01 (layer map) — can start in parallel, finalise after R01's map lands |
| **Downstream** | R04, R05, R06, R07, R16, R18 |
| **Status** | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Determine whether every one of the **101 HTTP routes** behaves correctly, validates its input, authorises
its caller, fails safely and is covered by a test that would actually catch a regression. You are the
reviewer responsible for the statement *"the API does what it says"*.

**Specific to this repository:** the route layer is thin and delegates to 18 services. The trap is
assuming that because a route is registered, it validates and authorises. Several routes read
`request.body as X` and rely on the service to validate; several public routes (by design) have no guard.
Your job is to prove the boundary for each one, not to sample.

---

## 2. Required expertise

- Fastify 5 plugin lifecycle, hooks, serializers, encapsulation
- Request validation with zod and the difference between *parse* and *cast*
- REST resource design, idempotency, pagination, optimistic concurrency
- Multipart upload handling and limits
- Transactional service design and failure atomicity
- Node.js error handling and unhandled rejection behaviour

---

## 3. Repository context (self-contained)

**Product.** IDCP turns photographed business documents into structured records that a human reviews and
then exports or pushes into external systems. The backend is a Fastify 5 API plus an in-process job
worker, one process (DEC-029).

**Route inventory — 101 registrations across 16 files:**

| File | Routes | Domain |
|------|--------|--------|
| `auth-routes.ts` | 19 | register, login, MFA, password reset, sessions, logout-all |
| `organisation-routes.ts` | 14 | org settings, members, invitations, retention |
| `connector-routes.ts` | 12 | connector CRUD, health, runs, mappings |
| `document-routes.ts` | 9 | upload, list, get, file, pages, delete |
| `review-routes.ts` | 8 | queue, approve, correct, bulk, stats |
| `batch-routes.ts` | 7 | batch upload, status, results |
| `workflow-routes.ts` | 7 | rules CRUD, runs, approvals |
| `pairing-routes.ts` | 6 | QR session, complete, devices |
| `template-routes.ts` | 6 | templates CRUD |
| `export-routes.ts` | 5 | create, list, download |
| `project-routes.ts` | 4 | projects CRUD |
| `api-key-routes.ts` | 3 | keys CRUD |
| `marketplace-routes.ts` | 3 | catalogue, install, rollback |
| `legal-routes.ts` | 2 | public legal documents |
| `privacy-routes.ts` | 2 | `GET /me/export`, `POST /me/erase` |
| `realtime-routes.ts` | 1 | `GET /events` (SSE) |

**Credential types accepted by `guards.ts`:** `Authorization: Bearer` (user), `X-Device-Credential`
(paired device), `X-API-Key` (machine client).

**Error model:** `packages/shared/src/errors.ts` `AppError` + `toErrorEnvelope` in `http/app.ts`.
Unknown errors are masked to `INTERNAL_ERROR` / "Something went wrong. Please try again."

---

## 4. Exact files and components to examine

### 4.1 Must read in full

| # | File | LOC | What you are looking for |
|---|------|-----|--------------------------|
| 1 | `apps/backend/src/http/app.ts` | 238 | Plugin order, error handler, headers, access log, `/api/v1` prefix, body limits |
| 2 | `apps/backend/src/http/guards.ts` | 107 | The three credential paths; `requireRole`; `uuidParam` |
| 3 | `apps/backend/src/http/routes/auth-routes.ts` | 257 | 19 routes — the highest-risk file |
| 4 | `apps/backend/src/http/routes/organisation-routes.ts` | 137 | Member/role/retention management |
| 5 | `apps/backend/src/http/routes/connector-routes.ts` | 113 | Credential handling |
| 6 | `apps/backend/src/http/routes/document-routes.ts` | 138 | Multipart limits, sniffing, file download |
| 7 | `apps/backend/src/http/routes/workflow-routes.ts` | 147 | Destructive action approval |
| 8 | `apps/backend/src/http/routes/review-routes.ts` | 78 | Bulk operations |
| 9 | `apps/backend/src/http/routes/realtime-routes.ts` | 86 | SSE auth via query token |
| 10 | `apps/backend/src/services/container.ts` | 146 | Wiring and limiter configuration |
| 11 | `packages/shared/src/contracts.ts` | 966 | The authoritative request/response schemas |
| 12 | `packages/shared/src/errors.ts` | 73 | Error codes and envelope |
| 13 | `packages/shared/src/constants.ts` | 196 | LIMITS, roles, thresholds |
| 14 | `apps/backend/test/helpers.ts` | 394 | How tests build an app and actor |

### 4.2 Must read in full — the 18 services

`auth-service.ts` (903) · `connector-service.ts` (566) · `review-service.ts` (397) · `organisation-service.ts`
(349) · `workflow-service.ts` (347) · `document-service.ts` (300) · `worker.ts` (282) · `marketplace-service.ts`
(254) · `privacy-service.ts` (240) · `export-service.ts` (228) · `batch-service.ts` (223) · `template-service.ts`
(215) · `pairing-service.ts` (198) · `maintenance-service.ts` (195) · `api-key-service.ts` (178) · `project-service.ts`
(126) · `container.ts` (146) · `crypto.ts` (54)

### 4.3 Remaining routes (read for validation + guard consistency)

`batch-routes.ts` (88) · `export-routes.ts` (40) · `legal-routes.ts` (66) · `marketplace-routes.ts` (41) ·
`pairing-routes.ts` (64) · `privacy-routes.ts` (45) · `project-routes.ts` (38) · `template-routes.ts` (56) ·
`api-key-routes.ts` (30)

### 4.4 Test suites you must read and extend mentally

`auth.test.ts` (206) · `auth-recovery.test.ts` (241) · `mfa.test.ts` (209) · `totp.test.ts` (84) ·
`documents.test.ts` (274) · `review.test.ts` (315) · `export.test.ts` (235) · `batches.test.ts` (203) ·
`connector.test.ts` (460) · `teams.test.ts` (228) · `templates.test.ts` (182) · `workflows.test.ts` (341) ·
`marketplace.test.ts` (276) · `privacy.test.ts` (202) · `maintenance.test.ts` (143) · `security.test.ts` (214) ·
`devapi.test.ts` (222) · `dashboard.test.ts` (127) · `terms.test.ts` (114) · `audit-export.test.ts` (81) ·
`web-surface.test.ts` (63) · `pairing.test.ts` (211) · `config.test.ts` (89) · `worker-recovery.test.ts` (108) ·
`ai.test.ts` (175)

### 4.5 Explicit non-goals

Schema/migration portability → R03 · role matrix and cross-tenant isolation → R06 · offensive testing and
dependency risk → R07 · performance measurement → R17 · job state machine → R18.

---

## 5. Upstream artefacts required

| From | Artefact | Needed by |
|------|----------|-----------|
| R01 | `evidence/R01/layer-map.md` | To confirm each route/service/repository belongs where it is |
| R01 | `evidence/R01/state-inventory.md` | To know which services hold in-process state |

If R01 is not finished, begin with §6.1–§6.3 (route inventory) which does not depend on it.

---

## 6. Checklist — every item must be answered

Legend: `[STATIC]` read/analyse · `[RUNTIME]` execute · `[WRITE]` produce a file.

### 6.1 Route inventory and validation

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| BE-AC-01 | Build the **101-row route matrix** | One row per registration: method, path, credential type, role required, request schema, response shape, error codes, test file | Every row filled; no blanks | **WRITE** |
| BE-AC-02 | Every mutating route validates its body | `grep -rn "request.body" apps/backend/src/http/routes` then read each hit | Either `Schema.safeParse` / `.parse`, or a documented service-level validation | STATIC |
| BE-AC-03 | No unvalidated cast reaches the database | Find `as Record<string, unknown>`, `as { … }`, `as any` in routes | Each one is followed by explicit field checks | STATIC |
| BE-AC-04 | Path params are validated as UUIDs | `guards.uuidParam` usage vs every `:id` route | Every `:id` route uses it or validates explicitly | STATIC |
| BE-AC-05 | Query params are validated and bounded | Read every `request.query` usage | Numeric limits clamped server-side | STATIC |
| BE-AC-06 | 101 registered routes vs 102 OpenAPI operations reconciled | `grep -cE "\.(get\|post\|put\|patch\|delete)\("` per file; compare with `docs/openapi.yaml` | Written reconciliation of the delta | STATIC |
| BE-AC-07 | No route is registered outside the `/api/v1` prefix | `http/app.ts` plugin registration | All 16 plugins inside the prefixed scope | STATIC |

### 6.2 Authorisation at the boundary

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| BE-AC-08 | Every route has an explicit auth decision | From the BE-AC-01 matrix, classify each as public or guarded | Public routes are only: login, register, password forgot/reset, pairing complete, legal, health | STATIC |
| BE-AC-09 | Every privileged route calls `requireRole` | Cross-reference matrix against `guards.requireRole` | Retention, member management, connector credentials, API keys, erasure = admin/owner | STATIC |
| BE-AC-10 | Role change takes effect on the next request | Read `guards.resolveActor` — it re-reads `memberships` | Confirmed by test (T-04) | STATIC+RUNTIME |
| BE-AC-11 | `guards.uuidParam` returns 404 (not 400) for a malformed id | Read implementation | `AppError('NOT_FOUND')` | STATIC |
| BE-AC-12 | API-key actor cannot exceed its scopes | `api-key-service.ts` + matrix | Documented scope model | STATIC |

### 6.3 Error handling and failure safety

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| BE-AC-13 | Every error path returns the standard envelope | Read `http/app.ts` `setErrorHandler`; check Fastify framework errors 400/404/413/415/429 | All mapped, none leak internals | STATIC |
| BE-AC-14 | Unknown 500 never leaks a message or stack | `toErrorEnvelope` unknown branch | Generic message + `requestId` only | STATIC |
| BE-AC-15 | No unhandled promise rejection can kill the process | `grep -rn "void \|\.catch(" apps/backend/src`; check fire-and-forget calls | Every detached promise handled | STATIC |
| BE-AC-16 | 429 responses set `Retry-After` | `pairing-routes.ts` does; check every limiter call site | Present wherever a limiter exists | STATIC |
| BE-AC-17 | Malformed JSON → `INVALID_JSON`, not 500 | Read the handler branch | Implemented | STATIC |
| BE-AC-18 | Truncated multipart fails closed with 413 | `document-routes.ts` + `document-service.ts` | `file.truncated` checked before storing | STATIC+RUNTIME |

### 6.4 Idempotency and concurrency

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| BE-AC-19 | Upload is idempotent per organisation + client key | `document-service.ts` `upload()`; the key is scoped per org | Replay returns the same document id | **RUNTIME** |
| BE-AC-20 | Missing/blank idempotency key does not create a duplicate on retry | Read the fallback | Documented behaviour | STATIC |
| BE-AC-21 | Bulk approve reports skipped items | `review-routes.ts` + `review-service.ts` | Partial results are explicit, never silently dropped | STATIC |
| BE-AC-22 | Batch upload isolates per-file failure | `batch-service.ts` | One bad file cannot abort the batch | STATIC |
| BE-AC-23 | Concurrent identical writes do not corrupt state | Two simultaneous approvals of one document (T-06) | One wins, one gets a conflict/no-op, no duplicate audit | **RUNTIME** |

### 6.5 Pagination and resource bounds

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| BE-AC-24 | Every list endpoint clamps `limit` | `grep -rn "limit" apps/backend/src/repositories` | `Math.min(..., max)` in every list query | STATIC |
| BE-AC-25 | Cursor pagination is stable under concurrent inserts | `document-repo.ts` `list()` uses `created_at` cursor | Documented ordering limitation | STATIC |
| BE-AC-26 | No endpoint returns an unbounded collection | Read every `list` call site | All bounded | STATIC |

### 6.6 Domain-service correctness

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| BE-AC-27 | Services enforce role checks, not just routes | Read each service's public methods for a role/membership assertion | Defence in depth present or explicitly delegated | STATIC |
| BE-AC-28 | Every privileged action writes an audit entry | `grep -rn "audit\." apps/backend/src/services` vs the privileged action list | Retention change, member change, credential write, erasure, export download, API-key create = audited | STATIC |
| BE-AC-29 | Multi-write operations are transactional | Look for `db.transaction` around document+job+audit | Atomic where correctness requires it | STATIC |
| BE-AC-30 | `auth-service.ts` (903 LOC) has no dead or duplicated branches | Read in full; look for copy-paste between login/MFA/reset paths | Single source of truth per outcome | STATIC |
| BE-AC-31 | `connector-service.ts` never returns a stored credential | Read every response mapping | Secrets never serialised | STATIC |
| BE-AC-32 | `export-service.ts` enforces the row cap and TTL | `listApproved` caps at 10 000; `EXPORTS_TTL_SECONDS` | Both enforced and tested | STATIC |

### 6.7 Realtime

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| BE-AC-33 | SSE auth accepts a query token only as a fallback | `realtime-routes.ts` lines ~30–50 | Header preferred, query token accepted, never logged | STATIC |
| BE-AC-34 | `GET /events` returns 501 for a non-SSE hub | `realtime-routes.ts` | No silent no-op | STATIC |
| BE-AC-35 | Event names match the client's list | `realtime/hub.ts` + `apps/desktop/src/lib/realtime.ts` (10 names) | Exact match | STATIC |

### 6.8 Test coverage of the API surface

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| BE-AC-36 | Every route has at least one test that would fail if it broke | Map matrix rows to test names | No untested route, or an explicit gap | STATIC |
| BE-AC-37 | Denial paths are tested, not only success | `grep -rn "403\|404\|401\|FORBIDDEN\|UNAUTHENTICATED" apps/backend/test` | At least one denial assertion per privileged route | STATIC |
| BE-AC-38 | Tests start a real listener (Fastify `inject()` is unusable here) | `test/helpers.ts` | Consistent harness; no `inject()` | STATIC |

---

## 7. Known backend risks to confirm or refute

| Risk | Statement | Where |
|------|-----------|-------|
| R-02 | Password reset stores a hashed token but **nothing delivers it** — no mail transport exists | `auth-service.ts`, `auth-routes.ts`; `grep -rniE "nodemailer\|smtp\|sendgrid\|mailgun\|resend" package.json apps/*/package.json` |
| R-08 | 11 PRD stories carry `verification` blocks; some are backend routes | `PRD.json` |
| R-12 | Batch upload buffers every file in memory (`Buffer` per file, ≤100 files) | `batch-service.ts` |
| R-17 | Access token appears in the SSE query string | `realtime-routes.ts`, `apps/desktop/src/lib/realtime.ts` `eventsUrl` |
| R-18 | `AttemptLimiter` is in-process and unbounded | `auth/tokens.ts` |

---

## 8. Questions you must answer

1. Which route is the single riskiest in the system, and why?
2. Name every route that accepts input without a shared schema. Justify each.
3. If a caller sends a valid body with an extra field, is it rejected or ignored — and is that consistent across all 101 routes?
4. What happens to an upload that is exactly at `MAX_UPLOAD_MB`? One byte over? Truncated mid-stream?
5. Does any service hold state between requests? If so, what breaks on a second replica?
6. Is there any endpoint that can be used to enumerate resources (ids, emails, orgs) belonging to another tenant?

---

## 9. Commands to run

```bash
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund
npm run db:migrate

# --- route census ---
grep -cE "\.(get|post|put|patch|delete)\(" apps/backend/src/http/routes/*.ts
grep -rhoE "app\.(get|post|put|patch|delete)\('[^']*'" apps/backend/src/http/routes | sort

# --- validation gaps ---
grep -rn "request.body" apps/backend/src/http/routes
grep -rn "request.query" apps/backend/src/http/routes
grep -rnE "as (Record<string, unknown>|any|\{)" apps/backend/src/http/routes

# --- guard coverage ---
grep -rn "requireRole\|guards.authenticate" apps/backend/src/http/routes | sort

# --- audit coverage ---
grep -rn "audit\." apps/backend/src/services | sort

# --- denial tests ---
grep -rnc "403\|FORBIDDEN\|ROLE_REQUIRED\|UNAUTHENTICATED" apps/backend/test/*.ts

# --- run the backend ---
npm run dev:backend &        # http://127.0.0.1:4000
curl -s http://127.0.0.1:4000/api/v1/health

# --- targeted suites ---
npx jest --config jest.config.cjs --selectProjects backend --runInBand
```

---

## 10. Tests to perform

| # | Test | Procedure | Pass criterion |
|---|------|-----------|----------------|
| T-01 | Route matrix completion | Build all 101 rows | No blank cell; each route has a test reference or a recorded gap |
| T-02 | Schema fuzz on every mutating route | For each: `{}`, wrong types, 10 MB string, unknown extra field, `null`, array-instead-of-object | Rejected with `FIELD_VALIDATION_FAILED`, never 500 |
| T-03 | Unauthenticated sweep | Call every non-public route with no header | 401/`UNAUTHENTICATED`; no data in the body |
| T-04 | Role demotion | Sign in as admin, demote self in another session, retry a privileged call **without** refreshing the token | Denied on the next request |
| T-05 | Idempotent upload replay | Same file + same `Idempotency-Key` twice | Same document id; one job; one audit row |
| T-06 | Concurrent approval | Two approvals of one document simultaneously | Exactly one state transition; no duplicated audit |
| T-07 | Boundary upload sizes | `MAX_UPLOAD_MB−1`, exactly, `+1`, and a truncated stream | 201 / 201 / 413 / 413; nothing stored on failure |
| T-08 | Rate limit behaviour | 6 failed logins (limit 5 per 15 min) | 5th may pass, 6th → 429 + `Retry-After` |
| T-09 | Malformed inputs | Bad JSON, wrong content-type, missing boundary, oversized header | `INVALID_JSON` / 415 / 400; never 500 or a stack trace |
| T-10 | SSE auth paths | `GET /events` with header, with query token, with neither | Live stream / live stream / 401 |

---

## 11. Evidence required

```
docs/reviewers/evidence/R02/
├── route-matrix.csv            # 101 rows × 9 columns
├── validation-gaps.md          # every unvalidated input, with justification or finding
├── guard-matrix.md             # route × credential × role
├── audit-coverage.md           # privileged action → audit entry
├── chatty-transcripts/         # raw HTTP request/response for T-02…T-10
├── commands.log
└── findings.md                 # BE-### register
```

---

## 12. Passing conditions (co-signs G1, G2)

- [ ] **P1** The 101-row route matrix is complete, with no blank cell (BE-AC-01).
- [ ] **P2** Every mutating route validates input through a shared schema, or carries a written justification (BE-AC-02, BE-AC-03).
- [ ] **P3** Every privileged route is role-guarded; the public-route list matches §6.2 exactly (BE-AC-08, BE-AC-09).
- [ ] **P4** No 500 leaks an internal message, SQL, path or stack (BE-AC-13, BE-AC-14, T-09).
- [ ] **P5** Upload idempotency is proven by replay (BE-AC-19, T-05).
- [ ] **P6** Every list endpoint is bounded (BE-AC-24 … BE-AC-26).
- [ ] **P7** Every privileged action writes an audit entry (BE-AC-28).
- [ ] **P8** Denial paths are tested for every privileged route (BE-AC-37).
- [ ] **P9** 101 routes vs 102 OpenAPI operations reconciled in writing (BE-AC-06).
- [ ] **P10** R-02 recorded as a CRITICAL functional gap with an owner (no password recovery delivery).
- [ ] **P11** All findings carry severity, file:line, reproduction and suggested fix.

---

## 13. Blocked items

| Item ID | Blocker | What unblocks it | Owner |
|---------|---------|------------------|-------|
| | | | |

---

## 14. Findings register

| ID | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
|----|----------|-----------|---------|----------------|-----------|---------------|-------|
| BE-001 | | | | | | | |

---

## 15. Reviewer sign-off

| Field | Value |
|-------|-------|
| Reviewer name | |
| Date started | |
| Date completed | |
| **G1 co-sign result** | ☐ Pass ☐ Fail ☐ Abstain |
| **G2 co-sign result** | ☐ Pass ☐ Fail ☐ Abstain |
| Conditions failed (IDs) | |
| Reviewed commit | `43d384b` |
| Statement | *I read all 16 route files and all 18 services in full, built the 101-row matrix, and executed T-01 … T-10 against a running server.* |
| Signature | |
