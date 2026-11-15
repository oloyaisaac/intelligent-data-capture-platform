# REVIEWER 06 — AUTHORISATION & MULTI-TENANCY ENGINEER

| Field              | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| **Reviewer ID**    | R06                                                                |
| **Title**          | Authorisation & Multi-Tenancy Engineer                             |
| **Board**          | B — Identity, security & privacy                                   |
| **Wave**           | 2 (weeks 3–5)                                                      |
| **Effort**         | 10 person-days                                                     |
| **Gate chaired**   | none                                                               |
| **Co-signs**       | G3                                                                 |
| **Evidence to**    | G1, G2 (contributes findings, not an approver)                     |
| **Finding prefix** | `TEN-###`                                                          |
| **Upstream**       | R02 (route matrix), R03 (table inventory)                          |
| **Downstream**     | R07, R08, R15, R21                                                 |
| **Status**         | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Determine whether **tenant A can ever see, change or delete tenant B's data**, and whether a user can ever
grant themselves more privilege than the organisation intended. You are the reviewer responsible for the
sentence _"every row belongs to exactly one organisation, and no query forgets it."_

**Scope boundary (deliberate overlap):**

- **R05** owns credential strength and lifecycle.
- **You** own **who may do what to whose row** — the 5-role matrix, `organisation_id` scoping across all 32 tables, and privilege escalation.
- **R07** owns the attacker's view — bypassing the guard entirely, SSRF, upload tricks.

You and R07 both examine `guards.ts`. Your failure criterion is _"another tenant's row is reachable by a
legitimately authenticated user"_; R07's is _"the guard can be defeated without a valid credential at all."_

**Specific to this repository:** authorisation is split between `guards.requireRole` (route-level) and
`guards.resolveActor` (which re-reads membership on every request — a strong design). The risk is not the
guard; it is the **13 repositories**, where a single missing `organisation_id` predicate is a data breach.
This must be checked table by table, method by method — not sampled.

---

## 2. Required expertise

- RBAC and ABAC design; role hierarchies
- Multi-tenant isolation patterns (shared schema + tenant discriminator)
- IDOR / BOLA (OWASP API Security #1 and #5)
- Privilege escalation and confused-deputy problems
- Invitation/membership lifecycle and its edge cases
- Writing and running cross-tenant test suites

---

## 3. Repository context (self-contained)

**Product.** IDCP is a multi-tenant SaaS. Organisations contain users (5 roles), documents, extractions,
reviews, templates, connectors, exports, batches, projects, workflows, API keys, devices and audit logs.

**Roles** (`packages/shared/src/constants.ts`):

```
ROLES = ['owner', 'admin', 'reviewer', 'operator', 'viewer']
roleAtLeast(role, required)  // hierarchy comparison
```

**Three credential types** (`http/guards.ts`):

| Credential        | Header                  | Actor type | Role source                            |
| ----------------- | ----------------------- | ---------- | -------------------------------------- |
| User access token | `Authorization: Bearer` | `user`     | membership re-read per request         |
| Paired device     | `X-Device-Credential`   | `device`   | owner's membership re-read per request |
| API key           | `X-API-Key`             | `api_key`  | key record                             |

**Critical design detail to verify, not assume:** `resolveActor` calls
`MembershipsRepository.findForUser(claims.sub)` on **every** request and returns
`organisationId: membership.organisation_id, role: membership.role` — the `org` and `role` claims inside the
JWT are **ignored**. This means a demotion takes effect on the next request. Confirm it holds on every path.

**Data model:** 32 tables, 29 indexes, all tenant-owned tables carry `organisation_id`.

**Documented policy:** `SECURITY.md` §5; `ARCHITECTURE.md` §5 security zones (Public / Authenticated /
Privileged / Machine). `packages/shared/src/errors.ts` deliberately returns **404, not 403**, for another
tenant's record so existence is not disclosed.

---

## 4. Exact files and components to examine

### 4.1 Must read in full

| #   | File                                                  | Size | Why                                               |
| --- | ----------------------------------------------------- | ---- | ------------------------------------------------- |
| 1   | `apps/backend/src/http/guards.ts`                     | 107  | The single authorisation choke point              |
| 2   | `packages/shared/src/constants.ts`                    | 196  | `ROLES`, `roleAtLeast`, thresholds                |
| 3   | `packages/shared/src/errors.ts`                       | 73   | 404-not-403 disclosure policy                     |
| 4   | `apps/backend/src/repositories/auth-repo.ts`          | 477  | Memberships, invitations, roles                   |
| 5   | `apps/backend/src/services/organisation-service.ts`   | 349  | Member CRUD, role changes, invitations, retention |
| 6   | `apps/backend/src/http/routes/organisation-routes.ts` | 137  | 14 routes — the privilege surface                 |
| 7   | `apps/backend/src/services/api-key-service.ts`        | 178  | Machine principals                                |
| 8   | `apps/backend/src/services/pairing-service.ts`        | 198  | Device → owner delegation                         |
| 9   | `apps/backend/src/http/routes/review-routes.ts`       | 78   | Bulk operations worth abusing                     |
| 10  | `apps/backend/src/http/routes/privacy-routes.ts`      | 45   | `/me/export`, `/me/erase`                         |

### 4.2 Must read **all 13 repositories**, method by method

`auth-repo.ts` (477) · `document-repo.ts` (380) · `connector-repo.ts` (325) · `system-repo.ts` (203) ·
`review-repo.ts` (216) · `workflow-repo.ts` (227) · `device-repo.ts` (172) · `project-repo.ts` (164) ·
`template-repo.ts` (142) · `marketplace-repo.ts` (115) · `batch-repo.ts` (83) · `apikey-repo.ts` (82) ·
`types.ts` (332)

For **each public method**, record: does it take `organisationId`? does the SQL predicate include it? is any
id-only lookup preceded by an org-scoped fetch?

### 4.3 Services whose authorisation semantics matter

`document-service.ts` · `review-service.ts` · `connector-service.ts` · `export-service.ts` · `batch-service.ts` ·
`template-service.ts` · `workflow-service.ts` · `project-service.ts` · `marketplace-service.ts` · `privacy-service.ts`

### 4.4 Route files — enumerate the guard on every route

All 16 files in `apps/backend/src/http/routes/` (101 routes).

### 4.5 Tests you must read

`security.test.ts` (214) · `teams.test.ts` (228) · `privacy.test.ts` (202) · `devapi.test.ts` (222) ·
`pairing.test.ts` (211) · `review.test.ts` (315) · `documents.test.ts` (274)

### 4.6 Explicit non-goals

Password/token mechanics → R05 · offensive bypass, crypto, SSRF, upload → R07 · DSAR completeness → R08.

---

## 5. Upstream artefacts required

| From | Artefact                       | Why                                                     |
| ---- | ------------------------------ | ------------------------------------------------------- |
| R02  | `evidence/R02/guard-matrix.md` | Starting point — you must verify and extend it          |
| R03  | `evidence/R03/schema.md`       | The 32-table inventory with `organisation_id` per table |

---

## 6. Checklist

### 6.1 The complete matrix (primary deliverable)

| ID     | Item                                                 | How to verify                                                                             | Expected                                                           | Type      |
| ------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------- |
| TEN-01 | Build **resource × role** matrix                     | 16 resource types × 5 roles                                                               | Every cell: allowed / denied / n/a, with the file that enforces it | **WRITE** |
| TEN-02 | Build **resource × actor** matrix                    | user / device / api_key / public                                                          | Every cell justified                                               | **WRITE** |
| TEN-03 | Map every one of the 101 routes to its required role | Cross-reference route files                                                               | No route with an unexplained guard                                 | **WRITE** |
| TEN-04 | Identify all genuinely public routes                 | Public list should equal: login, register, forgot, reset, pairing complete, legal, health | Any extra is a finding                                             | STATIC    |

### 6.2 Tenant scoping — method by method

| ID     | Item                                                      | How to verify                                                                                               | Expected                                                        | Type        |
| ------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------- |
| TEN-05 | Every repository method names its scoping predicate       | Create `evidence/R06/repo-scoping.md`: method → SQL predicate                                               | Every method either takes `organisationId` or documents why not | **WRITE**   |
| TEN-06 | Every id-only lookup is preceded by an org-scoped fetch   | Read `document-repo.ts` `updateStatus`, `softDelete`, `updateAnyDocumentType`; `auth-repo.ts` by-id methods | Caller validates ownership first — prove per call site          | STATIC      |
| TEN-07 | No query uses a client-supplied organisation id           | `grep -rn "organisationId" apps/backend/src/http/routes`                                                    | Org always comes from `actor`, never from body/query            | STATIC      |
| TEN-08 | Cross-tenant reads are impossible for every resource type | Run T-01 against all 16 resource types                                                                      | 404/empty for every one                                         | **RUNTIME** |
| TEN-09 | Cross-tenant writes are impossible                        | T-02                                                                                                        | 404/403 for every one                                           | **RUNTIME** |
| TEN-10 | Cross-tenant deletes are impossible                       | T-03                                                                                                        | 404/403 for every one                                           | **RUNTIME** |
| TEN-11 | Junction/child tables are scoped via their parent         | `documents`, `extractions`, `document_pages`, `batch_items`, `audit_logs`, `review_corrections`             | No child can be reached without its parent's org check          | STATIC      |
| TEN-12 | Storage keys embed the tenant                             | `buildStorageKey` → `org/<orgId>/…`                                                                         | Confirmed; a foreign key cannot be guessed                      | STATIC      |

### 6.3 Role hierarchy and privilege escalation

| ID     | Item                                                                           | How to verify                                                                          | Expected                                 | Type        |
| ------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------- | ----------- |
| TEN-13 | `roleAtLeast` is correct for all 25 role pairs                                 | Read + unit-test the function                                                          | Strict hierarchy, no accidental equality | STATIC      |
| TEN-14 | A user cannot change their own role                                            | Read `PATCH /organisation/members/:id`                                                 | Self-role change blocked                 | STATIC      |
| TEN-15 | A user cannot promote anyone above themselves                                  | Read the service                                                                       | Enforced                                 | STATIC      |
| TEN-16 | The last owner cannot be removed or demoted                                    | Read the service + `privacy-service.ts` (multi-owner erasure refusal)                  | Enforced                                 | STATIC      |
| TEN-17 | Role change takes effect on the **next** request                               | T-04: demote, retry with the same access token                                         | Denied immediately                       | **RUNTIME** |
| TEN-18 | Mass assignment cannot raise role/plan/retention                               | Try sending `role`, `plan`, `retentionDays`, `organisationId` in profile-update bodies | Ignored or rejected                      | **RUNTIME** |
| TEN-19 | A `viewer` cannot perform any write                                            | Sweep every mutating route as `viewer`                                                 | All denied                               | **RUNTIME** |
| TEN-20 | An `operator` cannot approve/review unless intended                            | Verify the intended role semantics against `SECURITY.md`                               | Documented                               | STATIC      |
| TEN-21 | Only `owner`/`admin` reach retention, members, connector credentials, API keys | Route matrix                                                                           | Enforced                                 | STATIC      |

### 6.4 Device credential semantics

| ID     | Item                                                                  | How to verify                  | Expected                   | Type        |
| ------ | --------------------------------------------------------------------- | ------------------------------ | -------------------------- | ----------- |
| TEN-22 | A device acts as its owner with the owner's current role              | `guards.ts` device branch      | Confirmed                  | STATIC      |
| TEN-23 | A revoked device is rejected immediately                              | T-05                           | 401 on the next request    | **RUNTIME** |
| TEN-24 | If the owner is removed from the org, the device dies                 | T-06                           | 401 (`membership` missing) | **RUNTIME** |
| TEN-25 | A device cannot be paired to another organisation                     | Read the pairing flow          | Bound to the creating org  | STATIC      |
| TEN-26 | A device credential cannot be used to create API keys or change roles | Route matrix as `device` actor | Denied                     | **RUNTIME** |

### 6.5 API-key semantics

| ID     | Item                                                                            | How to verify                       | Expected                                   | Type        |
| ------ | ------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------ | ----------- |
| TEN-27 | A key carries an explicit role or scope set                                     | `api-key-service.ts`                | Documented                                 | STATIC      |
| TEN-28 | A key cannot exceed its creator's role                                          | Read the key model + `resolveActor` | Enforced at use time, not only at creation | STATIC      |
| TEN-29 | A key is bound to exactly one organisation                                      | Read storage + guard                | Enforced                                   | STATIC      |
| TEN-30 | A revoked key is rejected immediately                                           | T-07                                | 401                                        | **RUNTIME** |
| TEN-31 | A key cannot manage members, retention or other keys unless explicitly intended | Sweep                               | Denied                                     | **RUNTIME** |

### 6.6 Invitations and membership lifecycle

| ID     | Item                                                                                       | How to verify                              | Expected                  | Type        |
| ------ | ------------------------------------------------------------------------------------------ | ------------------------------------------ | ------------------------- | ----------- |
| TEN-32 | Invitation tokens are random, hashed, single-use and expire                                | `auth-repo.ts` + `organisation-service.ts` | Confirmed (7-day default) | STATIC      |
| TEN-33 | An invitation is bound to the invited email                                                | Read the accept flow                       | Confirmed                 | STATIC      |
| TEN-34 | An invitation is bound to one organisation                                                 | Confirmed                                  | STATIC                    |
| TEN-35 | A used invitation cannot be replayed                                                       | T-08                                       | Rejected                  | **RUNTIME** |
| TEN-36 | An expired invitation is rejected with a clear message                                     | T-09                                       | 410/400                   | **RUNTIME** |
| TEN-37 | Accepting an invitation for an existing account does not leak whether the account exists   | Read the flow                              | No enumeration            | STATIC      |
| TEN-38 | A user in organisation A cannot be invited into B without consent semantics being explicit | Read + document                            | Documented                | STATIC      |

### 6.7 Disclosure policy

| ID     | Item                                                     | How to verify           | Expected                  | Type        |
| ------ | -------------------------------------------------------- | ----------------------- | ------------------------- | ----------- |
| TEN-39 | Another tenant's record returns 404, not 403             | T-01 output             | 404 consistently          | **RUNTIME** |
| TEN-40 | A non-existent id and a foreign id are indistinguishable | Compare responses       | Identical body and status | **RUNTIME** |
| TEN-41 | Error messages never echo another tenant's identifier    | Read error construction | Clean                     | STATIC      |
| TEN-42 | List endpoints cannot be filtered to reveal foreign ids  | Read filters            | Enforced                  | STATIC      |

---

## 7. Known authorisation risks to confirm or refute

| Risk            | Statement                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **R-06 (HIGH)** | A single missing `organisation_id` predicate in one of 13 repositories is a cross-tenant breach                                          |
| R-17            | API-key blast radius is unclear because keys may carry only a role                                                                       |
| R-08            | `AUDIT-2026-10.md` claims "Tenant isolation — every repository query is scoped by organisation_id". **Verify this claim independently.** |
| R-24            | Roles are compared by string; a typo in a role literal silently denies or over-grants                                                    |

---

## 8. Questions you must answer

1. **Can a legitimately authenticated user of organisation A read, modify or delete any row belonging to B?** Prove the answer for each of the 16 resource types.
2. Which repository methods take only an `id` and no `organisationId`, and is every caller safe?
3. Does a demotion take effect immediately, and is that true for the device and API-key paths too?
4. What is the highest-privilege action a `viewer` can perform today?
5. Can a user be a member of two organisations, and if so, how is the "current" one chosen?
6. Is a 404-vs-403 policy applied consistently, or do some endpoints leak existence?

---

## 9. Commands to run

```bash
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund
npm run db:migrate && npm run db:seed
npm run dev:backend &

# --- scoping census: every repo method and its predicate ---
grep -rn "async .*(" apps/backend/src/repositories/*.ts | sed 's/:.*async/: async/'
grep -rn "organisation_id" apps/backend/src/repositories/*.ts | wc -l
grep -rn "WHERE id = ?" apps/backend/src/repositories/*.ts

# --- organisation id provenance (must never come from client input) ---
grep -rn "organisationId" apps/backend/src/http/routes | grep -v "actor\."
grep -rn "organisationId: request\|organisationId: body\|organisationId: query" apps/backend/src

# --- guard coverage per route ---
for f in apps/backend/src/http/routes/*.ts; do
  echo "== $f"; grep -nE "app\.(get|post|put|patch|delete)\(" "$f" | wc -l
  grep -c "guards.authenticate\|requireRole" "$f"
done

# --- role hierarchy ---
grep -n "ROLES\|roleAtLeast" -A6 packages/shared/src/constants.ts

# --- two tenants: seed a second org, then attack ---
#  (create org B + user B via the API, collect tokens A and B, then:)
A_DOC=$(curl -s -H "Authorization: Bearer $TOKEN_A" http://127.0.0.1:4000/api/v1/documents | jq -r '.items[0].id')
curl -s -o /dev/null -w "read=%{http_code}\n"   -H "Authorization: Bearer $TOKEN_B" http://127.0.0.1:4000/api/v1/documents/$A_DOC
curl -s -o /dev/null -w "delete=%{http_code}\n" -X DELETE -H "Authorization: Bearer $TOKEN_B" http://127.0.0.1:4000/api/v1/documents/$A_DOC
curl -s -o /dev/null -w "patch=%{http_code}\n"  -X PATCH -H "Authorization: Bearer $TOKEN_B" \
  -H 'content-type: application/json' -d '{"name":"x"}' http://127.0.0.1:4000/api/v1/documents/$A_DOC
# expected: 404 404 404
```

---

## 10. Tests to perform

| #    | Test                      | Scope                                     | Pass criterion      |
| ---- | ------------------------- | ----------------------------------------- | ------------------- |
| T-01 | Cross-tenant read sweep   | 16 resource types × GET by id             | 404 for all         |
| T-02 | Cross-tenant write sweep  | 16 resource types × PATCH/POST            | 404/403 for all     |
| T-03 | Cross-tenant delete sweep | Every DELETE route                        | 404/403 for all     |
| T-04 | Immediate demotion        | Demote, retry with the pre-demotion token | Denied              |
| T-05 | Revoked device            | Revoke, retry                             | 401                 |
| T-06 | Owner removed             | Remove owner from org, retry device       | 401                 |
| T-07 | Revoked API key           | Revoke, retry                             | 401                 |
| T-08 | Invitation replay         | Accept twice                              | Second rejected     |
| T-09 | Expired invitation        | Manipulate `expires_at`, accept           | Rejected            |
| T-10 | Viewer sweep              | All mutating routes as `viewer`           | All denied          |
| T-11 | Self-promotion            | Try to set own role/plan/retention        | Rejected or ignored |
| T-12 | Last-owner protection     | Remove the only owner                     | Refused             |
| T-13 | List filtering leak       | Filter lists by a foreign id              | Empty, no leak      |
| T-14 | 404/403 consistency       | Non-existent vs foreign id                | Identical responses |

---

## 11. Evidence required

```
docs/reviewers/evidence/R06/
├── matrix-resource-role.md       # 16 resources × 5 roles
├── matrix-resource-actor.md      # 16 resources × 4 actor types
├── route-role-map.csv            # 101 routes × required role × enforcement file
├── repo-scoping.md               # all 13 repos, every method, predicate or justification
├── escalation-tests.md           # T-04, T-10, T-11, T-12 results
├── cross-tenant-suite/           # T-01 … T-03 raw transcripts
├── commands.log
└── findings.md                   # TEN-### register
```

---

## 12. Passing conditions (co-signs G3)

- [ ] **P1** The resource×role and resource×actor matrices are complete with every cell justified (TEN-01 … TEN-03).
- [ ] **P2** Every repository method's scoping predicate is documented; every id-only lookup has a proven safe caller (TEN-05, TEN-06).
- [ ] **P3** `organisationId` always originates from the authenticated actor, never from client input (TEN-07).
- [ ] **P4** Cross-tenant read, write and delete are impossible for all 16 resource types (TEN-08 … TEN-10, T-01 … T-03).
- [ ] **P5** Demotion, device revocation, owner removal and API-key revocation all take effect on the next request (TEN-17, TEN-23, TEN-24, TEN-30, T-04 … T-07).
- [ ] **P6** No privilege-escalation path exists (TEN-14 … TEN-16, T-11, T-12).
- [ ] **P7** Invitations are hashed, single-use, expiring, email- and org-bound (TEN-32 … TEN-37, T-08, T-09).
- [ ] **P8** The 404-not-403 policy is applied consistently (TEN-39 … TEN-42, T-14).
- [ ] **P9** The `AUDIT-2026-10.md` tenant-isolation claim is independently re-verified, not trusted.

---

## 13. Blocked items

| Item ID | Blocker | What unblocks it | Owner |
| ------- | ------- | ---------------- | ----- |
|         |         |                  |       |

---

## 14. Findings register

| ID      | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
| ------- | -------- | --------- | ------- | -------------- | --------- | ------------- | ----- |
| TEN-001 |          |           |         |                |           |               |       |

---

## 15. Reviewer sign-off

| Field                   | Value                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reviewer name           |                                                                                                                                                                                |
| Date started            |                                                                                                                                                                                |
| Date completed          |                                                                                                                                                                                |
| **G3 co-sign result**   | ☐ Pass ☐ Fail ☐ Abstain                                                                                                                                                        |
| Cross-tenant result     | ☐ Isolated ☐ **Leak found**                                                                                                                                                    |
| Conditions failed (IDs) |                                                                                                                                                                                |
| Reviewed commit         | `43d384b`                                                                                                                                                                      |
| Statement               | _I read `guards.ts`, all 13 repositories method by method, and the organisation/invitation services, and I executed a cross-tenant attack suite across all 16 resource types._ |
| Signature               |                                                                                                                                                                                |
