# REVIEWER NAME: Integration / Connectors Engineer (R15)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R15-integration-connectors.md` (56 checklist items)
**STATUS:** ☑ Complete — **7 of 8 connectors never run against a live server**

---

## AREAS EXAMINED

8 connectors (CSV, SQLite, Postgres, MySQL, Google Sheets, HubSpot, Odoo, QuickBooks) · registry · contract · mapping · idempotency · credential handling · marketplace signing.

---

## 1. Summary of examination

I enumerated the registry, read the CRM HTTP layer and the Sheets connector, and inspected how each is tested. The critical question was: which connectors have demonstrably worked?

**Answer: one.** The SQLite connector is exercised against a real file on disk. The CSV connector is exercised in memory. The other six — Postgres, MySQL, Google Sheets, HubSpot, Odoo, QuickBooks — are tested exclusively against injected `fetchImpl` mocks. **No network call to any external system has ever been made by this codebase's tests.**

**Correction to the parent assessment:** it stated the SQLite connector was "verified live". That is accurate — `connectors.test.ts:160-166` creates a real temp file with `DatabaseSync` and writes to it. The claim holds for SQLite and only SQLite.

---

## 2. Files and components inspected

| File | LOC | Checked |
|---|---|---|
| `packages/connectors/src/registry.ts` | 65 | all 8 registered |
| `packages/connectors/src/contract.ts` | 204 | interface, mapping |
| `packages/connectors/src/google-sheets-connector.ts` | 193 | token handling |
| `packages/connectors/src/crm/http.ts` | 228 | URL validation, retry |
| `packages/connectors/src/sqlite-connector.ts` | 234 | real file I/O |
| `packages/connectors/src/{postgres,mysql}-connector.ts` | — | connection handling |
| `packages/connectors/test/connectors.test.ts` | 627 | **all network mocked** |

---

## 3. Features examined

Connector selection · credential storage · field mapping · write idempotency · retry · error surfacing · marketplace install · signature verification.

---

## 4. Tests performed

| # | Test | Result |
|---|---|---|
| T1 | `npx jest connectors` | **PASS** |
| T2 | SQLite against real file | **PASS** — `mkdtemp` + `DatabaseSync` |
| T3 | CSV in memory | **PASS** |
| T4 | Postgres live | **NOT RUN** — no server |
| T5 | MySQL live | **NOT RUN** — no server |
| T6 | Google Sheets live | **NOT RUN** — no OAuth client |
| T7 | HubSpot / Odoo / QuickBooks live | **NOT RUN** — no sandbox accounts |
| T8 | All CRM tests inject `fetchImpl` | **CONFIRMED** — `fetchImpl` at lines 243, 266, 273, … |
| T9 | Marketplace signature | **PRESENT** — `verifyPackageSignature` with `timingSafeEqual` |
| T10 | Signature key in config schema | **FAIL — not present** (see CONX-003) |

---

## 5. Successful findings

1. **SQLite is genuinely integration-tested** against a real database file, including schema validation and a real write.
2. **Field mapping is a first-class abstraction** (`contract.ts`, `MAP-001`) with its own test group — mapping is testable without any network.
3. **URL validation rejects non-https** and permits plain http only for literal loopback (`crm/http.ts:46-50`).
4. **`timingSafeEqual` is used for signature comparison**, with a length check first — correct constant-time comparison, not `===`.
5. **Retry and idempotency are designed in** at the connector contract level rather than bolted on per connector.
6. **Unknown connector types produce an actionable error naming what is supported**, not a stack trace.

---

## 6. Identified problems

### CONX-001 — Six of eight connectors have never contacted a real server

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | `postgres-connector`, `mysql-connector`, `google-sheets-connector`, `crm/{hubspot,odoo,quickbooks}` |
| **Evidence** | Every CRM and cloud test injects `fetchImpl` (lines 243+). No test opens a socket to any external service. Postgres/MySQL connectors validate a connection string but never connect. |
| **Expected** | Each connector exercised against a real instance or explicitly marked unverified |
| **Actual** | Six connectors are shipped as features on the strength of mock tests |
| **Verification** | Read `connectors.test.ts`; every network interaction is an injected function |

**Why HIGH:** integration code fails in exactly the places mocks cannot reach — auth handshakes, pagination, rate limits, date/binary encodings, error-body shapes. A mock asserts the code matches the author's understanding of the API, not the API.

**Recommended correction:** For each connector, either (a) run a contract test against a live/sandbox instance in a nightly job, or (b) mark it beta and say so in the UI. Postgres and MySQL can be tested cheaply with service containers.

**Verification requirements:** A recorded live run per connector with a transcript, or an explicit "unverified" label in the marketplace.

---

### CONX-002 — Google Sheets tokens expire and nothing refreshes them

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | `packages/connectors/src/google-sheets-connector.ts`; `connector-service` |
| **Evidence** | The connector takes an `accessToken` from encrypted credentials. There is **no OAuth flow and no refresh logic** — nothing obtains or renews a token. Google access tokens last ~1 hour. `PRD.json` `CON-002.verification.notVerified` states this verbatim. |
| **Expected** | A destination that keeps working unattended |
| **Actual** | A Sheets destination stops working roughly an hour after it is configured |
| **Verification** | Read the connector; `grep -rn "refresh" packages/connectors/src/google-sheets-connector.ts` → only a comment saying refresh "is the backend's job", and no backend code does it |

**Recommended correction:** Implement the OAuth installed-app flow and store the refresh token; refresh on demand with a short-lived access-token cache. Or remove Google Sheets from the product until it exists.

---

### CONX-003 — Marketplace signing key has a hardcoded default and is absent from the config schema

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | `apps/backend/src/marketplace/catalog.ts:41`; `config.ts` |
| **Evidence** | `return process.env.MARKETPLACE_SIGNING_KEY ?? 'idcp-first-party-catalogue-key';` — the default is committed. `grep MARKETPLACE_SIGNING_KEY apps/backend/src/config.ts` → **not present**, so production validation never checks it. |
| **Expected** | Required and validated in production, like `JWT_SECRET` |
| **Actual** | Silently defaults to a public string |
| **Verification** | Read line 41; grep config |

**Important scoping — this is not a critical vulnerability as it stands.** The catalogue is **first-party only**: 5 packages, all signed in-process by `signed()` at module load. There is no third-party publisher whose signature could be forged, so the HMAC is effectively an integrity checksum, and `verifyPackageSignature` will always agree with `signPackage` because both run in the same process with the same key.

**Why MEDIUM rather than CRITICAL:** the risk materialises only if third-party publishing is added. At that moment, a public default key plus in-process signing would be a **complete signature bypass** — the "signature" would prove nothing.

**Recommended correction:** Add `MARKETPLACE_SIGNING_KEY` to the config schema as required in production, and record in `DECISIONS.md` that the current scheme is first-party integrity only, not a trust boundary.

---

### CONX-004 — Synthetic verification cannot detect drift in either direction

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | All six mocked connectors |
| **Evidence** | Because the expected value is computed by the same function that computes the actual, and because every HTTP response is a fixture, a vendor changing a field name would break production and nothing in the suite. |
| **Expected** | Some contact with reality |
| **Actual** | None |
| **Verification** | Static reasoning over the test harness |

---

### CONX-005 — Connector execution is unisolated (shared with ARC-003)

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | `apps/backend/src/services/connector-service.ts` |
| **Evidence** | Connectors run in the backend process with full `process.env` and filesystem access. `ARCHITECTURE.md` §5 calls this a "sandbox". |
| **Expected** | Documentation matches reality |
| **Actual** | It does not |
| **Verification** | `grep -rn "worker_threads\|child_process" packages/connectors` → zero |

---

## 7. Missing functionality

| Item | Status |
|---|---|
| OAuth flow + token refresh | **Not implemented** |
| Live contract tests | **Not implemented** |
| Connector isolation | **Not implemented** |
| Sandbox credentials in CI | **Not configured** |
| Marketplace third-party publishing | **Not implemented** |
| Rate-limit handling verification | **Unverified** |

---

## 8. Security concerns

Connector credentials are encrypted at rest with the shared `JWT_SECRET` (see AUTH-001) — a rotation hazard. `timingSafeEqual` usage is correct. SSRF is limited to protocol validation (SEC-004).

---

## 9. Performance concerns

Retry/backoff exists. No connector has been measured against a slow or rate-limited real API. Deferred to R17.

---

## 10. Recommendations

1. **Live-test Postgres and MySQL first** — cheapest, and they matter most for data export.
2. **Fix CON-002** or withdraw Sheets from the marketplace.
3. Register `MARKETPLACE_SIGNING_KEY` in config (CONX-003).
4. Label unverified connectors as beta (CONX-001).

---

## EVIDENCE CLASSIFICATION

| Class | Items |
|---|---|
| **A. Verified working** | SQLite (real file), CSV, mapping, URL validation, `timingSafeEqual`, actionable unknown-type error |
| **B. Verified failing** | CONX-002 (Sheets expiry) |
| **C. Not implemented** | OAuth refresh, live tests, isolation, third-party publishing |
| **D. Partially implemented** | Signature (present, first-party only, unvalidated key) |
| **E. Unable to verify** | **6 of 8 connectors** — no servers, no credentials, no sandbox accounts |

---

## ISSUE SUMMARY

| ID | Severity | Title |
|---|---|---|
| CONX-001 | **HIGH** | 6/8 connectors never contacted a real server |
| CONX-002 | **HIGH** | Sheets token expires; no refresh |
| CONX-003 | MEDIUM | Signing key not in config; public default |
| CONX-004 | MEDIUM | Mocked tests cannot detect vendor drift |
| CONX-005 | MEDIUM | Connectors unisolated despite "sandbox" docs |

**Totals: 0 CRITICAL · 2 HIGH · 3 MEDIUM · 0 LOW**
