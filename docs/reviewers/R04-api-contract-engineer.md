# REVIEWER 04 — API & CONTRACT ENGINEER

| Field              | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| **Reviewer ID**    | R04                                                                |
| **Title**          | API & Contract Engineer                                            |
| **Board**          | A — Architecture & core domain                                     |
| **Wave**           | 1 (weeks 1–2)                                                      |
| **Effort**         | 6 person-days                                                      |
| **Gate chaired**   | none                                                               |
| **Co-signs**       | G1, G5                                                             |
| **Evidence to**    | G2, G3 (contributes findings, not an approver)                     |
| **Finding prefix** | `API-###`                                                          |
| **Upstream**       | R01 (layer map), R02 (route matrix)                                |
| **Downstream**     | R15 (connector contract), R20 (documentation)                      |
| **Status**         | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Determine whether the API is a **contract** or merely a set of endpoints: whether every operation is
documented, whether the documentation cannot silently drift from the code, whether the Universal Data
Model is versioned and stable, and whether a third-party developer could integrate against this API
without reading the source.

**Specific to this repository:** the developer API (DEVAPI-001) is a marketed product surface, and
`docs/openapi.yaml` (85 paths, 102 operations) is checked by `scripts/validate-openapi.mjs` in CI. The
critical question is **what that validator actually compares** — paths only, or operations, requests and
responses. A contract test that only checks that a path exists will happily pass while every response
shape changes.

---

## 2. Required expertise

- OpenAPI 3.0/3.1 authoring and tooling
- Backward compatibility and semantic versioning for APIs
- JSON Schema and Zod-to-JSON-Schema generation
- Contract testing (consumer-driven and provider-side)
- Developer-experience design for public APIs (auth, pagination, errors, rate limits, idempotency)

---

## 3. Repository context (self-contained)

**Product.** IDCP converts photographed business documents into structured records. The API is consumed by
three first-party clients (desktop renderer, mobile app, connector runtime) **and** by third parties
through API keys (DEVAPI-001).

**Contract artefacts:**

| Artefact                 | Path                                             | Size                            |
| ------------------------ | ------------------------------------------------ | ------------------------------- |
| OpenAPI document         | `docs/openapi.yaml`                              | 85 paths / **102 operations**   |
| Route count in code      | `apps/backend/src/http/routes/*.ts`              | **101 registrations**           |
| Request/response schemas | `packages/shared/src/contracts.ts`               | 966 LOC                         |
| UDM schema (TS)          | `packages/shared/src/udm/schema.ts`              | 234 LOC                         |
| UDM schema (JSON)        | `docs/udm-1.0.schema.json`                       | generated                       |
| PRD schema               | `docs/prd.schema.json`                           | generated                       |
| UDM generator            | `scripts/generate-udm-schema.mjs`                | `--check` mode runs in CI       |
| OpenAPI validator        | `scripts/validate-openapi.mjs`                   | runs in CI (`npm run test:api`) |
| Error model              | `packages/shared/src/errors.ts`                  | 73 LOC, stable codes            |
| API-key routes           | `apps/backend/src/http/routes/api-key-routes.ts` | 3 routes                        |
| API-key service          | `apps/backend/src/services/api-key-service.ts`   | 178 LOC                         |

**Documented API conventions:** `API.md` (29 KB) describes HTTP + realtime contract; `ARCHITECTURE.md` §5
defines security zones; `AGENT_STATE.md` notes `GET /api/v1/health` (there is **no** bare `/health`).

---

## 4. Exact files and components to examine

### 4.1 Must read in full

| #   | File                                             | What you are looking for                                                                   |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 1   | `docs/openapi.yaml`                              | Every one of the 102 operations: request body, all responses, error codes, security scheme |
| 2   | `scripts/validate-openapi.mjs`                   | **What exactly does it compare?** Paths only? Operations? Request/response schemas?        |
| 3   | `packages/shared/src/contracts.ts`               | Every request/response schema and its `.strict()` behaviour                                |
| 4   | `packages/shared/src/udm/schema.ts`              | UDM structure, version stamping, extension points                                          |
| 5   | `packages/shared/src/errors.ts`                  | Error codes, HTTP mapping, envelope                                                        |
| 6   | `packages/shared/src/constants.ts`               | `LIMITS`, `ERROR_CODES`, role list                                                         |
| 7   | `scripts/generate-udm-schema.mjs`                | How `--check` detects drift                                                                |
| 8   | `docs/udm-1.0.schema.json`                       | Generated output — does it match the TS schema?                                            |
| 9   | `scripts/validate-prd.mjs`                       | Contract enforcement for PRD                                                               |
| 10  | `API.md`                                         | The prose contract to reconcile against `openapi.yaml`                                     |
| 11  | `apps/backend/src/http/routes/api-key-routes.ts` | Public developer credential surface                                                        |
| 12  | `apps/backend/src/services/api-key-service.ts`   | Key creation, hashing, scopes, revocation                                                  |
| 13  | `apps/backend/src/repositories/apikey-repo.ts`   | Storage of keys                                                                            |
| 14  | `apps/backend/test/devapi.test.ts`               | What is actually asserted about the developer API                                          |

### 4.2 Must cross-reference

- `apps/backend/src/http/routes/*.ts` — all 16 files, to compare registered routes against documented operations.
- `apps/backend/src/http/app.ts` — error envelope, security headers, CORS.
- `packages/connectors/src/contract.ts` — the connector contract (a second public contract).
- `apps/desktop/src/api/client.ts` (960 LOC) and `apps/mobile/src/api/client.ts` (388 LOC) — the _de facto_
  consumers; any mismatch between what they expect and what is documented is a finding.

### 4.3 Explicit non-goals

Route validation correctness → R02 · tenant/role enforcement → R06 · performance of the API → R17 ·
prose documentation accuracy outside the API → R20.

---

## 5. Upstream artefacts required

| From | Artefact                        | Why                                               |
| ---- | ------------------------------- | ------------------------------------------------- |
| R02  | `evidence/R02/route-matrix.csv` | The authoritative list of 101 routes to reconcile |
| R01  | `evidence/R01/layer-map.md`     | Confirms contracts live in `packages/shared`      |

---

## 6. Checklist

### 6.1 Contract coverage

| ID        | Item                                                                            | How to verify                                                                  | Expected                                           | Type      |
| --------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------- | --------- |
| API-AC-01 | Every one of the 101 routes appears in `openapi.yaml`                           | Diff the route list against the 85 documented paths                            | Written reconciliation of the 101 vs 102 delta     | **WRITE** |
| API-AC-02 | Each operation documents its **request**                                        | Read each operation's `requestBody` / `parameters`                             | Present and schema-typed; no free-form objects     | STATIC    |
| API-AC-03 | Each operation documents **all** response codes it can return (2xx + 4xx + 5xx) | Cross-reference the route's `AppError` throws against the documented responses | Every throw site has a documented response         | STATIC    |
| API-AC-04 | Every operation declares its security requirement                               | `security:` per operation or global                                            | Public operations explicitly marked `security: []` | STATIC    |
| API-AC-05 | Error responses all use the shared envelope schema                              | `$ref` to one `ErrorEnvelope`                                                  | No bespoke error shapes                            | STATIC    |
| API-AC-06 | Pagination is documented identically wherever it exists                         | `limit` / `cursor` parameters                                                  | Same names, same bounds in the document as in code | STATIC    |
| API-AC-07 | Rate-limited operations document 429 and `Retry-After`                          | Search for limiter call sites                                                  | Documented per operation                           | STATIC    |
| API-AC-08 | Idempotency is documented where supported                                       | Upload route + `Idempotency-Key` header                                        | Header documented with semantics                   | STATIC    |

### 6.2 Drift detection — does the CI gate actually work?

| ID        | Item                                             | How to verify                                                     | Expected                                              | Type        |
| --------- | ------------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------- | ----------- |
| API-AC-09 | What does `validate-openapi.mjs` compare?        | Read the script end-to-end                                        | State precisely: paths / operations / schemas / none  | STATIC      |
| API-AC-10 | Prove it catches route removal                   | Delete one route registration temporarily, run `npm run test:api` | Fails                                                 | **RUNTIME** |
| API-AC-11 | Prove it catches **response shape** change       | Add a field to a 200 response body; run `test:api`                | **Expected to pass — that is the finding.** Record it | **RUNTIME** |
| API-AC-12 | Prove it catches request schema looseness        | Make a field optional in `contracts.ts`; run `test:api`           | Record pass/fail                                      | **RUNTIME** |
| API-AC-13 | `generate-udm-schema.mjs --check` fails on drift | Edit `udm/schema.ts`, run `npm run test:api`, revert              | Fails                                                 | **RUNTIME** |
| API-AC-14 | The generated JSON Schema matches the TS schema  | Regenerate, `git diff`                                            | No diff                                               | **RUNTIME** |

### 6.3 Universal Data Model

| ID        | Item                                                  | How to verify                                                        | Expected                                                              | Type   |
| --------- | ----------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- | ------ |
| API-AC-15 | UDM is explicitly versioned                           | `udm/schema.ts` — a version field/constant                           | Named (e.g. `1.0`) and embedded in stored records                     | STATIC |
| API-AC-16 | A compatibility policy is written                     | Search `API.md`/`DECISIONS.md` for change rules                      | Additive-only, or a documented breaking-change process                | STATIC |
| API-AC-17 | Extension fields are namespaced                       | Read the schema for an extension mechanism                           | Unknown keys rejected or quarantined deliberately                     | STATIC |
| API-AC-18 | Every stored UDM validates against the schema         | Find the persistence path; check validation happens **before** write | Confirmed by a malformed-provider-response test (coordinate with R14) | STATIC |
| API-AC-19 | Confidence and review fields are part of the contract | `review.ts`, UDM schema                                              | Thresholds documented, not magic numbers in code                      | STATIC |

### 6.4 Developer API (DEVAPI-001)

| ID        | Item                                        | How to verify                              | Expected                                                                                   | Type        |
| --------- | ------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ | ----------- |
| API-AC-20 | API keys are hashed at rest                 | `apikey-repo.ts` — `key_hash` only         | No plaintext key stored                                                                    | STATIC      |
| API-AC-21 | Keys are shown exactly once at creation     | Read `api-key-service.ts` + route          | Returned on create only                                                                    | STATIC      |
| API-AC-22 | **Scopes exist and are enforced**           | Read the key model                         | If keys carry only a role, a key can do everything its owner can — record the blast radius | STATIC      |
| API-AC-23 | Revocation is immediate                     | Revoke then reuse                          | 401                                                                                        | **RUNTIME** |
| API-AC-24 | `last_used_at` is recorded                  | `apikey-repo.ts`                           | Updated on use                                                                             | STATIC      |
| API-AC-25 | Key usage is rate-limited and audited       | Check limiter + audit entries              | Both present or recorded as gaps                                                           | STATIC      |
| API-AC-26 | An API key cannot exceed its creator's role | Read `guards.resolveActor` + key principal | Demonstrated (coordinate with R06)                                                         | STATIC      |

### 6.5 Versioning and compatibility

| ID        | Item                                                           | How to verify                                                     | Expected                                                       | Type   |
| --------- | -------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------- | ------ |
| API-AC-27 | `/api/v1` is the only version surface                          | `grep -rn "/api/v" apps/backend/src`                              | Single prefix, centrally applied                               | STATIC |
| API-AC-28 | No response field is optional today that might become required | Read `contracts.ts` response types                                | Stable                                                         | STATIC |
| API-AC-29 | Enum additions are non-breaking                                | Check every discriminant enum (status, documentType, error codes) | Clients tolerate unknown values or the document says otherwise | STATIC |
| API-AC-30 | Deprecation policy exists                                      | Search docs                                                       | Present or recorded missing                                    | STATIC |
| API-AC-31 | The document has an `info.version` and it moves with the code  | Read `openapi.yaml` info block                                    | Meaningful version                                             | STATIC |

### 6.6 Second contract: connectors

| ID        | Item                                               | How to verify                                 | Expected                                       | Type   |
| --------- | -------------------------------------------------- | --------------------------------------------- | ---------------------------------------------- | ------ |
| API-AC-32 | Connector contract is versioned and documented     | `packages/connectors/src/contract.ts`         | Manifest declares version + capabilities       | STATIC |
| API-AC-33 | Third-party connector authors have a specification | Search `docs/` for a connector SDK guide      | Present or recorded missing                    | STATIC |
| API-AC-34 | The contract is testable by a third party          | `packages/connectors/test/connectors.test.ts` | A conformance harness exists or is recommended | STATIC |

### 6.7 Client conformance

| ID        | Item                                                        | How to verify                                      | Expected                                      | Type   |
| --------- | ----------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------- | ------ |
| API-AC-35 | Desktop client types match documented responses             | `apps/desktop/src/api/client.ts` vs `contracts.ts` | No hand-rolled duplicate types that can drift | STATIC |
| API-AC-36 | Mobile client types match documented responses              | `apps/mobile/src/api/client.ts`                    | Same                                          | STATIC |
| API-AC-37 | Neither client depends on an undocumented endpoint or field | Grep their request paths against the OpenAPI doc   | Zero undocumented usage                       | STATIC |

---

## 7. Known contract risks to confirm or refute

| Risk | Statement                                                                                     |
| ---- | --------------------------------------------------------------------------------------------- |
| R-21 | Documentation drift: `API.md` may describe routes that changed                                |
| R-08 | `DEVAPI-001` is a marketed story; verify its acceptance criteria are met rather than asserted |
| R-26 | Duplicated contract-like definitions across `contracts.ts`, OpenAPI and client types          |

---

## 8. Questions you must answer

1. **What exactly does the CI OpenAPI validator protect?** Answer with the script's behaviour, not its comment.
2. If a developer changed a 200 response body tomorrow, would CI catch it? Demonstrate.
3. Does the UDM have a real version policy, or only a version string?
4. Can a third party build an integration from `docs/openapi.yaml` alone? Name every gap they would hit.
5. What is the blast radius of a leaked API key today?
6. Are the desktop and mobile clients using only documented surface? List every violation.

---

## 9. Commands to run

```bash
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund

# --- contract gates ---
npm run test:api
npm run test:prd
npm run schema:udm -- --check 2>/dev/null || node scripts/generate-udm-schema.mjs --check

# --- coverage diff ---
grep -oE "^\s{2}/[a-z0-9/{}._-]+:" docs/openapi.yaml | wc -l
grep -cE "^\s+(get|post|put|patch|delete):" docs/openapi.yaml
grep -rcE "\.(get|post|put|patch|delete)\(" apps/backend/src/http/routes/*.ts

# --- drift experiments (do these in a scratch branch, then revert) ---
git checkout -b scratch/api-drift
#  (a) delete one route registration → npm run test:api   → expect FAIL
#  (b) add a field to a success response → npm run test:api → expect ??? record result
#  (c) loosen a request schema            → npm run test:api → expect ??? record result
git checkout main -- . ; git checkout arena/bc459461-intelligent-data-capture-platf

# --- UDM regeneration diff ---
node scripts/generate-udm-schema.mjs && git diff --stat docs/

# --- developer API behaviour ---
npm run dev:backend &
curl -s -X POST http://127.0.0.1:4000/api/v1/api-keys -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"review"}'
# use the returned key, then revoke it and retry
```

---

## 10. Tests to perform

| #    | Test                    | Procedure                                                                | Pass criterion                                          |
| ---- | ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------- |
| T-01 | Full coverage diff      | 101 routes vs 102 operations                                             | Every delta explained in writing                        |
| T-02 | Route-removal gate      | API-AC-10                                                                | CI fails                                                |
| T-03 | Response-drift gate     | API-AC-11                                                                | **Record actual behaviour** — the finding is the answer |
| T-04 | Schema-loosening gate   | API-AC-12                                                                | Record actual behaviour                                 |
| T-05 | UDM drift gate          | Edit schema, run `--check`                                               | Fails                                                   |
| T-06 | Third-party walkthrough | Build a minimal integration from `openapi.yaml` alone (no source access) | List every blocker encountered                          |
| T-07 | API-key lifecycle       | Create → use → revoke → retry                                            | 201 → 200 → 401                                         |
| T-08 | Unknown-field behaviour | Send an extra body field to 5 routes                                     | Consistent behaviour across all                         |
| T-09 | Enum tolerance          | Send an unknown `documentType`                                           | Documented rejection, not a crash                       |

---

## 11. Evidence required

```
docs/reviewers/evidence/R04/
├── coverage-diff.md             # 101 routes vs 102 operations, delta explained
├── validator-capability.md      # exactly what the CI gate protects + the 3 drift experiments
├── udm-contract.md              # version, compatibility policy, extension points
├── devapi-review.md             # key lifecycle, scopes, blast radius
├── third-party-walkthrough.md   # gaps found integrating from the document alone
├── commands.log
└── findings.md                  # API-### register
```

---

## 12. Passing conditions (co-signs G1, G5)

- [ ] **P1** 101 routes vs 102 operations fully reconciled, with no undocumented route (API-AC-01).
- [ ] **P2** Every operation documents request, all responses and security (API-AC-02 … API-AC-04).
- [ ] **P3** The CI contract gate is proven to fail on **behavioural** drift, not only route removal — or the limitation is recorded as a finding with the fix specified (API-AC-10 … API-AC-12).
- [ ] **P4** UDM is versioned with a written compatibility policy (API-AC-15, API-AC-16).
- [ ] **P5** UDM schema generation cannot drift past CI (API-AC-13, API-AC-14, T-05).
- [ ] **P6** API keys are hashed, shown once, revocable, and their blast radius is documented (API-AC-20 … API-AC-26).
- [ ] **P7** Both clients use only documented API surface (API-AC-35 … API-AC-37).
- [ ] **P8** A third party could integrate from the document alone, or every blocker is listed (T-06).

---

## 13. Blocked items

| Item ID | Blocker | What unblocks it | Owner |
| ------- | ------- | ---------------- | ----- |
|         |         |                  |       |

---

## 14. Findings register

| ID      | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
| ------- | -------- | --------- | ------- | -------------- | --------- | ------------- | ----- |
| API-001 |          |           |         |                |           |               |       |

---

## 15. Reviewer sign-off

| Field                   | Value                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewer name           |                                                                                                                                                       |
| Date started            |                                                                                                                                                       |
| Date completed          |                                                                                                                                                       |
| **G1 co-sign result**   | ☐ Pass ☐ Fail ☐ Abstain                                                                                                                               |
| **G5 co-sign result**   | ☐ Pass ☐ Fail ☐ Abstain                                                                                                                               |
| Co-sign G1 / G5         | ☐ ☐                                                                                                                                                   |
| Validator verdict       | ☐ Protects behaviour ☐ Protects paths only ☐ Protects nothing                                                                                         |
| Conditions failed (IDs) |                                                                                                                                                       |
| Reviewed commit         | `43d384b`                                                                                                                                             |
| Statement               | _I read the entire OpenAPI document and the validator script, ran the three drift experiments, and reconciled all 101 routes against 102 operations._ |
| Signature               |                                                                                                                                                       |
