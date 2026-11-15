# REVIEWER 15 — INTEGRATION / CONNECTOR ENGINEER

| Field | Value |
|-------|-------|
| **Reviewer ID** | R15 |
| **Title** | Integration / Connector Engineer |
| **Board** | D — AI & integrations |
| **Wave** | 4 (weeks 6–8) |
| **Effort** | 16 person-days |
| **Gate chaired** | **G5 — Integration approval** |
| **Co-signs** | none |
| **Evidence to** | G2 (contributes findings, not an approver) |
| **Finding prefix** | `CONX-###` (use `CONX-###` to avoid collision with PRD story IDs `CON-001`…`CON-003`) |
| **Upstream** | R03 (DB), R14 (extraction output) |
| **Downstream** | R22 (pilot), G5 |
| **Status** | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Determine whether the product can actually **deliver data into a customer's business system** — reliably,
idempotently, and without leaking credentials. This is the final step of the product promise: an extracted,
reviewed record must land in Excel, Sheets, a SQL database, a CRM or an accounting system and stay correct.

**Two facts that define your review:**

1. **`CON-002` is the one admitted functional hole.** The Google Sheets connector is handed a pasted
   `accessToken`; there is **no OAuth flow and no token refresh**. A Sheets destination therefore works for
   roughly **one hour** after setup and then fails. `PRD.json` records this as a `verification` block and
   `AGENT_STATE.md` names it "the one real functional hole". It is your headline finding.
2. **Four of eight connectors have never touched a live server.** The test suite runs against recorded
   responses. Only SQLite executes for real. MySQL, PostgreSQL, Google Sheets, HubSpot, Odoo and QuickBooks
   are **unverified against reality** — their auth, pagination, rate limiting, error envelopes and type
   coercion are all assumptions.

---

## 2. Required expertise

- Connector/SDK architecture and capability contracts
- OAuth 2.0 (authorization code, refresh, token storage) — mandatory for the Sheets finding
- Third-party API semantics: HubSpot, Odoo, QuickBooks Online
- SQL dialect differences: SQLite, PostgreSQL, MySQL (placeholders, identifiers, types, upserts)
- Field mapping and transformation design
- Duplicate detection and merge policy
- Idempotency of outbound writes and retry safety

---

## 3. Repository context (self-contained)

**Product.** IDCP extracts records from documents; a "connector" pushes approved records into a destination.

**Connector package (`packages/connectors`), 8 implementations + SDK:**

| Connector | File | LOC | Live-server verified? |
|-----------|------|-----|-----------------------|
| SDK contract | `src/contract.ts` | 204 | n/a |
| Registry | `src/registry.ts` | 65 | n/a |
| CSV file | `src/csv-connector.ts` | 164 | Local file — effectively yes |
| SQLite | `src/sqlite-connector.ts` | 234 | **Yes** (real DB in tests) |
| PostgreSQL | `src/postgres-connector.ts` | 240 | **No** |
| MySQL | `src/mysql-connector.ts` | 242 | **No** |
| Google Sheets | `src/google-sheets-connector.ts` | 193 | **No — and `CON-002`** |
| CRM HTTP transport | `src/crm/http.ts` | 228 | n/a |
| HubSpot | `src/crm/hubspot-connector.ts` | 211 | **No** |
| Odoo | `src/crm/odoo-connector.ts` | 263 | **No** |
| QuickBooks | `src/crm/quickbooks-connector.ts` | 225 | **No** |

**Backend integration:** `services/connector-service.ts` (566) · `repositories/connector-repo.ts` (325) ·
`http/routes/connector-routes.ts` (113, **12 routes**) · `services/export-service.ts` (228) ·
`services/marketplace-service.ts` (254) · `marketplace/catalog.ts` (145) ·
`services/workflow-service.ts` (347).

**Tests:** `packages/connectors/test/connectors.test.ts` (627) · `apps/backend/test/connector.test.ts` (460) ·
`apps/backend/test/marketplace.test.ts` (276) · `apps/backend/test/workflows.test.ts` (341) ·
`apps/backend/test/export.test.ts` (235).

**Connector contract (verify each member exists and is used):** manifest, capabilities
(`create`/`read`/`update`/`search`), schema discovery, health check, `validateConfig`.

**Credential storage:** `SecretBox` (AES-256-GCM, per-record IV, organisation bound as AAD) via
`services/crypto.ts`, stored on the connector row.

**Duplicate policy (`DUP-001`):** `skip` / `update` / `merge` / `append`, with a side-effect-free preview.

**Documented gap (`CON-002`), quoting `AGENT_STATE.md`:**
> "No OAuth consent flow and no refresh for Google Sheets: a Sheets destination works for about an hour per
> pasted token. Recorded as a `verification` block in `PRD.json`."

---

## 4. Exact files and components to examine

### 4.1 Must read in full

Every file in `packages/connectors/src/` (14 files, 2 936 LOC) — **including the full `contract.ts`**, since
it defines what a third-party connector author must implement. Then:
`apps/backend/src/services/connector-service.ts` · `apps/backend/src/repositories/connector-repo.ts` ·
`apps/backend/src/http/routes/connector-routes.ts` · `apps/backend/src/services/export-service.ts` ·
`apps/backend/src/services/marketplace-service.ts` · `apps/backend/src/marketplace/catalog.ts` ·
`apps/backend/src/services/crypto.ts` · `apps/backend/src/services/workflow-service.ts`.

### 4.2 Must cross-check

- `apps/backend/src/services/document-service.ts` — how approved records become connector inputs.
- `packages/shared/src/dedupe.ts` (214) and `money.ts` (101) — the transforms used by mapping.
- `apps/backend/src/db/migrations.ts` — `connectors`, `connector_runs`, `mappings`, `marketplace_*` tables.
- `DECISIONS.md` DEC-026 (workflows), DEC-010/029 (storage/scale), and whatever governs connectors.
- `apps/backend/package.json` — **connectors ship as workspace packages**; confirm how they are bundled.

### 4.3 Explicit non-goals

SQL injection and SSRF offensive testing → R07 (you assess integration correctness; R07 assesses attack) ·
AI extraction accuracy → R14 · export file formatting → R02 · UI for connectors → R09/R12.

---

## 5. Upstream artefacts required

| From | Artefact | Why |
|------|----------|-----|
| R03 | `evidence/R03/schema.md` | Connector and run tables |
| R14 | `evidence/R14/benchmark-report.md` | The field values you will push to destinations |
| R07 | `evidence/R07/ssrf-assessment.md` | The egress risk you must document for tenants |

---

## 6. Checklist

### 6.1 THE `CON-002` FINDING (Google Sheets OAuth)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| CONX-01 | The Sheets connector consumes a caller-supplied `accessToken` | `google-sheets-connector.ts` | Confirmed | STATIC |
| CONX-02 | There is no OAuth consent flow | `grep -rniE "oauth\|authorize\|consent\|client_id" packages/connectors apps/backend/src` | Absent | STATIC |
| CONX-03 | There is no refresh-token storage | `connectors` table has no refresh column | Absent — confirm | STATIC |
| CONX-04 | There is no refresh call before a run | Read the run path | Absent | STATIC |
| CONX-05 | `GOOGLE_CLIENT_ID`/`SECRET` are absent from config | `config.ts` | Absent | STATIC |
| CONX-06 | Demonstrate the failure: a token expires and the run breaks | Use an expired token | 401 surfaced with an unhelpful/actionable message — record which | **RUNTIME** |
| CONX-07 | Specify the fix precisely: consent flow, encrypted refresh token on the connector row, refresh-before-run, expiry handling | Design | A complete, implementable design in the report | **WRITE** |
| CONX-08 | Decide the product stance: fix, or **withdraw Google Sheets from the feature list** | Recommendation | Explicit, with reasoning | **WRITE** |

### 6.2 LIVE VERIFICATION of every connector

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| CONX-09 | SQLite create/read/update/search works against a real file | Live run | Pass | **RUNTIME** |
| CONX-10 | PostgreSQL connector works against a real PG server | Live run | Pass — **or record failure** | **RUNTIME** |
| CONX-11 | MySQL connector works against a real MySQL/MariaDB | Live run | Pass or failure | **RUNTIME** |
| CONX-12 | Google Sheets works with a valid token | Live run | Pass | **RUNTIME** |
| CONX-13 | Google Sheets **after expiry** | Wait/force expiry | Fails per `CON-002` | **RUNTIME** |
| CONX-14 | HubSpot sandbox: create/update/search | Live run | Pass or failure | **RUNTIME** |
| CONX-15 | Odoo: create/update/search | Live run | Pass or failure | **RUNTIME** |
| CONX-16 | QuickBooks sandbox: create/update/search | Live run | Pass or failure | **RUNTIME** |
| CONX-17 | CSV export opens correctly in Excel, Numbers and Google Sheets | Open all three | Correct encoding/quoting | **RUNTIME** |
| CONX-18 | Every connector's `health()` reflects reality | Break credentials | Reports unhealthy | **RUNTIME** |
| CONX-19 | Schema discovery returns the destination's real fields | Inspect | Accurate | **RUNTIME** |
| CONX-20 | Rate limiting from the destination is respected | Drive requests | Backoff, no ban | **RUNTIME** |
| CONX-21 | Pagination in `search()` is correct | Large result set | Complete and non-duplicating | **RUNTIME** |
| CONX-22 | Timeouts are configured and honoured | Simulate a slow destination | Bounded | STATIC |
| CONX-23 | Errors are mapped to user-actionable messages | Force each error class | Actionable | STATIC |
| CONX-24 | The test suite's recorded responses match the live API's actual shape | Compare a live response to the fixture | Match, or fixtures are stale — record | **RUNTIME** |

### 6.3 Idempotency and retry safety

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| CONX-25 | A connector run is idempotent across job retry | Kill mid-run, let it retry | No duplicate record in the destination | **RUNTIME** |
| CONX-26 | The duplicate check runs **before** the write | Read the flow | Correct order | STATIC |
| CONX-27 | A timeout after a successful write does not duplicate | Simulate a lost ACK | Detection strategy exists (natural key lookup) | STATIC |
| CONX-28 | `update` is implemented for every connector that advertises it | Compare `capabilities` with implemented methods | Honest capability declarations | STATIC |
| CONX-29 | `merge` never overwrites a human-approved value silently | Read `dedupe.ts` `mergeRecord` | Reports refusals | STATIC |
| CONX-30 | The duplicate preview is side-effect free | Read the preview path | Zero writes | **RUNTIME** |
| CONX-31 | Run outcomes are recorded per item, including failures | `connector_runs` | Per-item success/failure | STATIC |

### 6.4 Credentials

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| CONX-32 | Credentials are encrypted with AES-256-GCM + org-bound AAD | `crypto.ts` + `connector-repo.ts` | Confirmed | STATIC |
| CONX-33 | No route ever returns a stored credential | Read all 12 connector routes + `connector-service` response mapping | Never echoed | STATIC |
| CONX-34 | Credentials never appear in logs or error messages | Force a failure | Clean | **RUNTIME** |
| CONX-35 | A ciphertext moved between tenants fails to decrypt | Copy a row across orgs in a test DB | Fails | **RUNTIME** |
| CONX-36 | Rotating `JWT_SECRET` behaviour is understood | `SecretBox` derivation | All connector credentials become unreadable — documented | STATIC |
| CONX-37 | Only owner/admin can write connector credentials | Route matrix | Enforced | STATIC |
| CONX-38 | Connector deletion removes the encrypted blob | Delete + inspect the row | Removed | STATIC |

### 6.5 Field mapping

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| CONX-39 | Mapping profiles model source UDM field → destination field + transform | Read the mapping model | Complete | STATIC |
| CONX-40 | Transform functions are deterministic and unit-tested | Read + run | Tested | STATIC |
| CONX-41 | Type coercion to destination types is correct (dates, money, booleans) | Live run to each destination | Correct, or documented loss | **RUNTIME** |
| CONX-42 | Unmapped required destination fields are rejected before the write | Try an incomplete mapping | Rejected early | **RUNTIME** |
| CONX-43 | Mapping is tenant-scoped and versioned/replaceable | Read | Scoped | STATIC |
| CONX-44 | A mapping change does not corrupt prior sends | Change and re-send | No retroactive effect | STATIC |
| CONX-45 | Money precision survives the round trip | `1 234,56` → destination | Exact, no float drift | **RUNTIME** |

### 6.6 Marketplace and third-party code

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| CONX-46 | The catalogue is signed and the signature is verified before install | `marketplace-service.ts`, `catalog.ts` | Verified | STATIC |
| CONX-47 | A tampered package is rejected | Modify a package | Rejected | **RUNTIME** |
| CONX-48 | Permissions are disclosed before install | Read the install UX/API | Disclosed | STATIC |
| CONX-49 | Rollback restores the previous version | Install → rollback | Correct | **RUNTIME** |
| CONX-50 | **Connectors run in-process with no sandbox** | Confirm | Record the supply-chain risk (R-16) | STATIC |
| CONX-51 | A third-party connector author has a written contract test | Search docs | Present or recommended | STATIC |

### 6.7 Workflows that trigger connectors

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| CONX-52 | A rule can trigger a connector run on approval | Read `workflow-service.ts` | Works | **RUNTIME** |
| CONX-53 | Destructive actions require per-run approval | Read | Enforced | STATIC |
| CONX-54 | `notify` records an output but **sends nothing** | Confirm (no mail transport) | Documented honestly | STATIC |
| CONX-55 | Rules cannot branch (single AND-list) | Confirm + document the limitation | Documented (`DEC-026`) | STATIC |
| CONX-56 | A failed rule run is visible to the operator | Run log + SSE | Visible | STATIC |

---

## 7. Known integration risks to confirm or refute

| Risk | Statement | Severity |
|------|-----------|----------|
| **R-07 (HIGH)** | `CON-002`: Google Sheets dies after ~1 hour — a flagship destination is unusable | HIGH |
| **R-16 (MEDIUM)** | No connector sandbox; Marketplace code executes in-process | MEDIUM |
| — | 4 of 8 connectors have never been run against a live server | HIGH (unverified) |
| **R-19** | SSRF: tenant-controlled endpoints reach internal networks | MEDIUM |
| R-25 | Credential encryption key derives from `JWT_SECRET` | LOW/MEDIUM |

---

## 8. Questions you must answer

1. **Which of the 8 connectors actually work against a live system?** Give a pass/fail table with evidence.
2. What exactly breaks in Google Sheets, and what is the smallest correct fix?
3. Can a retried run create a duplicate record anywhere?
4. Is any stored credential ever returned to a client or written to a log?
5. Does mapping preserve money and date fidelity into each destination?
6. Is the Marketplace safe to enable, given in-process execution?

---

## 9. Commands to run

```bash
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund
npm run db:migrate && npm run db:seed
npm run dev:backend &

# ---------- CON-002 evidence ----------
grep -n "accessToken\|refresh\|oauth\|Bearer" packages/connectors/src/google-sheets-connector.ts
grep -rniE "oauth|authorize|client_id|refresh_token" packages/connectors/src apps/backend/src | head
grep -n "GOOGLE" apps/backend/src/config.ts .env.example

# ---------- connectors package tests ----------
npx jest --config jest.config.cjs --selectProjects connectors --runInBand --coverage
npx jest --config jest.config.cjs --selectProjects backend --runInBand -t "connector|marketplace|mapping|duplicate"

# ---------- identifier safety ----------
grep -n "assertIdentifier" -A10 packages/connectors/src/sqlite-connector.ts
grep -rn "assertIdentifier" packages/connectors/src

# ---------- capability honesty ----------
grep -rn "capabilities" packages/connectors/src
grep -rn "async update(\|async create(\|async search(\|async health(\|async discover" packages/connectors/src

# ---------- credential handling ----------
grep -rn "SecretBox\|encrypt\|decrypt" apps/backend/src/services/connector-service.ts apps/backend/src/repositories/connector-repo.ts

# ---------- live runs ----------
docker run -d --name pg  -e POSTGRES_PASSWORD=pg  -p 5432:5432 postgres:16
docker run -d --name my  -e MYSQL_ROOT_PASSWORD=my -p 3306:3306 mysql:8
# then configure a connector of each type through the API and push a record:
curl -s -X POST http://127.0.0.1:4000/api/v1/connectors -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"type":"postgres","name":"pg","config":{"connectionString":"postgres://…","table":"records"}}'
# Google Sheets: create a service-account token, use it, then let it expire and retry
```

---

## 10. Tests to perform

| # | Test | Procedure | Pass criterion |
|---|------|-----------|----------------|
| T-01 | Live connector matrix | 8 connectors × create/read/update/search/health | Table of pass/fail |
| T-02 | Sheets expiry | Use an expired token | Failure reproduced and documented |
| T-03 | Retry duplication | Kill mid-run, allow retry | No duplicate at the destination |
| T-04 | Lost-ACK duplication | Timeout after a successful write | Detection or documented gap |
| T-05 | Credential echo | Every connector route, inspect responses | No secret returned |
| T-06 | Cross-tenant ciphertext | Copy an encrypted blob across orgs | Decryption fails |
| T-07 | Mapping fidelity | Push dates/money/booleans to each destination | Exact round trip |
| T-08 | Marketplace tamper | Modified package | Rejected |
| T-09 | Rollback | Install → rollback | Correct version restored |
| T-10 | Rate-limit respect | Drive requests to a CRM sandbox | Backoff, no ban |
| T-11 | Fixture staleness | Compare a recorded response to the live shape | Match, or listed drift |

---

## 11. Evidence required

```
docs/reviewers/evidence/R15/
├── connector-matrix.md          # 8 × capabilities × live-pass/fail/stub-only
├── con002-analysis.md           # the OAuth gap + the full fix design + product recommendation
├── idempotency-tests.md         # T-03, T-04
├── credential-review.md         # T-05, T-06, rotation consequences
├── mapping-fidelity.md          # T-07
├── marketplace-review.md        # signature, permissions, rollback, sandbox risk
├── fixture-drift.md             # T-11
├── commands.log
└── findings.md                  # CONX-### register
```

---

## 12. Passing conditions (chairs G5)

- [ ] **P1** Every connector is exercised against a live server, or is withdrawn from the product (CONX-09 … CONX-19, T-01).
- [ ] **P2** **`CON-002` is fixed (OAuth + encrypted refresh + refresh-before-run) or Google Sheets is removed from the feature list, marketplace and docs** (CONX-01 … CONX-08, T-02).
- [ ] **P3** Connector runs are idempotent across retries; no duplicate write is possible or the gap is documented (CONX-25 … CONX-31, T-03, T-04).
- [ ] **P4** No credential is ever returned by an API or written to a log (CONX-32 … CONX-38, T-05).
- [ ] **P5** Mapping preserves date and money fidelity into every destination (CONX-39 … CONX-45, T-07).
- [ ] **P6** The Marketplace signature is verified and a tampered package is rejected; the in-process execution risk is documented (CONX-46 … CONX-51, T-08).
- [ ] **P7** Capability declarations match implementations (CONX-28).
- [ ] **P8** Recorded test fixtures match the live API shape, or drift is catalogued (CONX-24, T-11).
- [ ] **P9** Workflow-triggered runs are visible and approvals are enforced (CONX-52 … CONX-56).

---

## 13. Blocked items

| Item ID | Blocker | What unblocks it | Owner |
|---------|---------|------------------|-------|
| CONX-14 … CONX-16 | No HubSpot/Odoo/QuickBooks sandbox accounts | Provision developer sandboxes | R19 |
| CONX-12, CONX-13 | No Google OAuth client | Create a Google Cloud project + OAuth client | R19 |
| CONX-10, CONX-11 | No MySQL/PostgreSQL servers | Provision (docker locally) | R19 |

---

## 14. Findings register

| ID | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
|----|----------|-----------|---------|----------------|-----------|---------------|-------|
| CONX-001 | | | | | | | |

---

## 15. Reviewer sign-off

| Field | Value |
|-------|-------|
| Reviewer name | |
| Date started | |
| Date completed | |
| **Gate G5 result** | ☐ Pass ☐ Fail |
| Connectors live-verified | /8 |
| **CON-002 disposition** | ☐ Fixed ☐ Sheets withdrawn ☐ Open (blocks G5) |
| Conditions failed (IDs) | |
| Reviewed commit | `43d384b` |
| Statement | *I read all 14 connector files and the connector service, and I executed every connector against a live system where one could be provisioned, recording pass/fail rather than assuming the recorded-response tests were representative.* |
| Signature | |
