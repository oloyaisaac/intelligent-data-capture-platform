# REVIEWER NAME: API & Contract Engineer (R04)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R04-api-contract-engineer.md` (37 checklist items)
**STATUS:** ☑ Complete

---

## AREAS EXAMINED

`docs/openapi.yaml` (2,263 lines) · 101 registered routes · `validate-openapi.mjs` · `test:api` · `generate-udm-schema.mjs` · contract drift · response shapes · error envelope conformance.

---

## 1. Summary of examination

I counted routes in the server and operations in the spec, read the validator in full, and **seeded two mutations** to measure its sensitivity: removing a documented path, and corrupting a property type. This is the only way to know whether a green `test:api` means anything.

**Verdict: the validator is real but narrow.** It catches path and method drift reliably — it failed immediately when I deleted `/auth/login`. It **cannot** catch a change to a response shape, because it never boots the server and never inspects a payload. So "OpenAPI matches the routes" is true, and "the API behaves as documented" is entirely unverified.

---

## 2. Files and components inspected

| File                                | Checked                                       |
| ----------------------------------- | --------------------------------------------- |
| `docs/openapi.yaml`                 | paths, operations, responses, schema refs     |
| `scripts/validate-openapi.mjs`      | full read — 160 lines                         |
| `scripts/generate-udm-schema.mjs`   | `--check` mode                                |
| `apps/backend/src/http/app.ts`      | route registration source the validator greps |
| `apps/backend/src/http/routes/*.ts` | 16 files, 101 routes                          |

---

## 3. Features examined

Contract completeness · operation counting · path-parameter convention · schema validity · UDM schema generation · error envelope · documentation of auth requirements.

---

## 4. Tests performed

| Test                                     | Method                       | Result                                                                   |
| ---------------------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| T1 Route vs spec count                   | validator output             | spec **101** ops / server **102** routes — reconciled by validator       |
| T2 `npm run test:api`                    | executed                     | **PASS**                                                                 |
| T3 **Mutation: delete `/auth/login`**    | seeded edit                  | **FAIL as designed** — "route POST /api/v1/auth/login is not documented" |
| T4 **Mutation: corrupt a property type** | seeded edit (malformed YAML) | **FAIL at parse**, not at semantic validation — inconclusive             |
| T5 Does the validator boot the server?   | read code                    | **NO** — greps `app.ts` with a regex                                     |
| T6 Does it compare response bodies?      | read code                    | **NO** — no `fetch`, no `inject`, no schema-vs-payload check             |
| T7 `/auth/login` restored, re-run        | executed                     | **PASS** — working tree clean                                            |

---

## 5. Successful findings

1. **The validator is not decorative.** It failed on a deleted path with an actionable message naming the exact route and the expected spec key.
2. **Path-parameter convention is handled correctly** — Fastify `:id` → OpenAPI `{id}`.
3. **A real YAML parser is used**, with a comment explaining why a hand-rolled parser was abandoned. That is the right call.
4. **`openapi.yaml` is structurally valid OpenAPI 3.1**, every operation has responses with descriptions.
5. **UDM schema is generated from TypeScript and checked for drift** (`--check`), so the JSON Schema cannot silently diverge from `schema.ts`.

---

## 6. Identified problems

### API-001 — The contract test cannot detect response-shape drift

| Field            | Value                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **HIGH**                                                                                                                                                                                                                                                                                                                      |
| **Affected**     | `scripts/validate-openapi.mjs:122-155`                                                                                                                                                                                                                                                                                        |
| **Evidence**     | The validator discovers routes by regexing `app.ts` for `app.get/post('/api/v1/...')` (lines 122-125). It never imports the app, never binds a port, never issues a request, and never compares a response body to a schema. Lines 69-74 only check that each response **has a description** — not that its shape is correct. |
| **Expected**     | A documented field changing type is caught                                                                                                                                                                                                                                                                                    |
| **Actual**       | The spec and the runtime can disagree about every payload and `test:api` still passes                                                                                                                                                                                                                                         |
| **Verification** | Read lines 122-155; note the absence of any HTTP client                                                                                                                                                                                                                                                                       |

**Why HIGH:** the entire value of a published OpenAPI document is that clients can generate from it. Desktop and mobile clients are hand-written against these shapes. A response-shape regression would be invisible to CI and would surface as a client crash in production — the same blind spot class as R-01.

**Recommended correction:** Add a response-schema assertion path: boot the app on an ephemeral port (the suite already does this — `helpers.ts`), call each documented endpoint with a fixture, and validate the payload against the spec using `ajv`. Start with the 10 highest-traffic endpoints rather than all 101.

**Verification requirements:** A seeded mutation that changes a response field type must make `test:api` fail.

---

### API-002 — The operation count differs between the spec and the server and the difference is not explained in the spec itself

| Field            | Value                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **LOW**                                                                                                                                                  |
| **Affected**     | validator output: `operations: 101` vs `routes found in the server: 102`                                                                                 |
| **Evidence**     | The validator prints both and passes, so the delta is accepted. The extra server route is presumably `/health` handled as a special case (line 129-132). |
| **Expected**     | The delta and its reason recorded where a reader will see it                                                                                             |
| **Actual**       | Visible only in transient stdout; the assessment flagged "102 vs 101 reconciled with a written reason" as a Gate 1 criterion                             |
| **Verification** | Run `npm run test:api`, compare the two numbers                                                                                                          |

**Recommended correction:** Print the reconciliation explicitly ("102 routes = 101 documented operations + health"), or document it in `API.md`.

---

### API-003 — Authentication requirements are not enforced as a contract property

| Field            | Value                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Severity**     | **MEDIUM**                                                                                                                                                                                                                                                         |
| **Affected**     | `docs/openapi.yaml` security schemes; `scripts/validate-openapi.mjs`                                                                                                                                                                                               |
| **Evidence**     | Each operation declares `security` (verified present), but nothing asserts that the **server** actually requires the credential the spec says it does. A route documented as `bearer`-protected that forgot `guards.authenticate` would pass every existing check. |
| **Expected**     | Spec-declared auth matches server-enforced auth                                                                                                                                                                                                                    |
| **Actual**       | Unverified                                                                                                                                                                                                                                                         |
| **Verification** | STATIC reasoning; would require T-API-001's harness to prove                                                                                                                                                                                                       |

**Recommended correction:** Once the response-assertion harness exists (API-001), add a negative test per documented-protected route: call without credentials, assert 401.

---

### API-004 — Error envelope is documented but not schema-validated against reality

| Field            | Value                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Severity**     | **LOW**                                                                                                                                          |
| **Affected**     | `openapi.yaml` error schema; `app.ts` error handler                                                                                              |
| **Evidence**     | The handler masks internals correctly (verified in R02), but no test asserts that a real 500 response conforms to the documented `Error` schema. |
| **Expected**     | Documented error shape == emitted error shape                                                                                                    |
| **Actual**       | Both look right by inspection; never compared mechanically                                                                                       |
| **Verification** | Would be covered by API-001's harness                                                                                                            |

---

## 7. Missing functionality

| Item                                       | Status                                     |
| ------------------------------------------ | ------------------------------------------ |
| Response-shape contract test               | **Not implemented**                        |
| Auth-enforcement contract test             | **Not implemented**                        |
| Client SDK generation                      | **Not implemented** — clients hand-written |
| Breaking-change detection between versions | **Not implemented** — no version diffing   |

---

## 8. Security concerns

API-003 is the security-relevant one: the spec could claim protection a route does not have, and no automated check would notice. Manual review of `guards.authenticate` usage showed it present on all non-public routes sampled (see R05/R06), so this is a **detection gap, not a known hole**.

---

## 9. Performance concerns

None specific to this domain.

---

## 10. Recommendations

1. Add the response-shape harness (API-001) — highest value, reuses the existing ephemeral-port fixture.
2. Add negative auth tests per protected route (API-003).
3. Print the 102-vs-101 reconciliation (API-002).
4. Keep the UDM `--check` pattern; it is exemplary and should be copied for API responses.

---

## EVIDENCE CLASSIFICATION

| Class                        | Items                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| **A. Verified working**      | Path/method drift detection (proven by mutation), YAML parsing, path-param convention, UDM schema check |
| **B. Verified failing**      | API-001 (shape drift undetected)                                                                        |
| **C. Not implemented**       | Response contract test, auth contract test, SDK generation, breaking-change detection                   |
| **D. Partially implemented** | Contract validation (structure + paths yes, payloads no)                                                |
| **E. Unable to verify**      | Whether documented responses match actual payloads — no harness exists                                  |

---

## ISSUE SUMMARY

| ID      | Severity | Title                                            |
| ------- | -------- | ------------------------------------------------ |
| API-001 | HIGH     | Contract test cannot detect response-shape drift |
| API-002 | LOW      | 102-vs-101 delta unexplained in the document     |
| API-003 | MEDIUM   | Spec-declared auth not asserted against server   |
| API-004 | LOW      | Error envelope never mechanically compared       |

**Totals: 0 CRITICAL · 1 HIGH · 1 MEDIUM · 2 LOW**
