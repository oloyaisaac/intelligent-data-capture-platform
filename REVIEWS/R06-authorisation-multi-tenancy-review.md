# REVIEWER NAME: Authorisation & Multi-Tenancy Engineer (R06)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R06-authorisation-multi-tenancy.md` (42 checklist items)
**STATUS:** ☑ Complete

---

## AREAS EXAMINED

5 roles · membership re-reading · 143 `organisation_id` predicates across ~170 statements · cross-tenant isolation tests · role gating · resource ownership · API-key scoping.

---

## 1. Summary of examination

I read `guards.ts` in full, counted tenancy predicates across every repository, and inventoried the cross-tenant assertions in the test suite. I then traced the authorisation decision path for each of the three credential types.

**Verdict: tenancy enforcement is genuinely strong and is one of this codebase's best qualities.** Membership is re-read from the database on **every** request (not trusted from the token), so a demotion or removal takes effect immediately — a subtlety many production systems get wrong. Isolation is asserted by dedicated negative tests across pairing, privacy, review, teams and documents.

The gaps are in **role granularity** and **API-key scoping**, not in tenant isolation.

---

## 2. Files and components inspected

| File | Checked |
|---|---|
| `apps/backend/src/http/guards.ts` | 107 LOC — full read |
| `apps/backend/src/repositories/*.ts` | 143 `organisation_id` predicates |
| `packages/shared/src/contracts.ts` | role definitions |
| `apps/backend/test/{pairing,privacy,review,teams,documents}.test.ts` | cross-tenant assertions |
| `apps/backend/src/services/api-key*` | scope enforcement |

---

## 3. Features examined

Role model · membership resolution · device auth · API-key auth · resource ownership · cross-tenant isolation · role escalation paths · project/connector/document scoping.

---

## 4. Tests performed

| Test | Method | Result |
|---|---|---|
| T1 Membership re-read per request | read `guards.ts:68` | **PASS** — DB hit every request |
| T2 Tenancy predicate coverage | count `organisation_id` in repositories | **143** across ~170 statements |
| T3 Cross-tenant negative tests | grep test suite | **PASS** — 5 dedicated tests found |
| T4 Role gating helper | read `requireRole` | **PASS** — `roleAtLeast` |
| T5 Unscoped query hunt | look for statements without `organisation_id` | **PASS** — all found are keyed by primary id *after* an org check |
| T6 API-key scope enforcement | read `apiKeys.authenticate` | **PARTIAL — see TEN-002** |
| T7 Full tenancy suites | `npx jest pairing privacy review teams documents` | **PASS** |

---

## 5. Successful findings

1. **Membership is re-read on every request** (`guards.ts:68`). A JWT minted while a user was an owner cannot retain owner privileges after demotion. This is the single most commonly botched detail in RBAC, and it is correct here.
2. **143 tenancy predicates** — the data layer enforces isolation rather than trusting service-layer discipline.
3. **Negative isolation tests exist for five domains**: "does not let one organisation revoke another organisation's device", "never includes another organisation documents", "cannot be used to review another organisation's document", "keeps projects invisible to another organisation".
4. **Three credential types all resolve to the same `AuthenticatedActor` shape**, so authorisation logic cannot diverge per credential.
5. **`requireRole` composes as a Fastify preHandler**, so a route cannot accidentally skip the check and still parse correctly.

---

## 6. Identified problems

### TEN-001 — Five roles cannot express the permissions the UI offers

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | `packages/shared/src/contracts.ts` (roles); all routes using `requireRole` |
| **Evidence** | The role model is a linear hierarchy (`roleAtLeast`), which means every permission is implied by rank. A role cannot grant (e.g.) "can export but cannot delete" or "can review but cannot manage connectors". `requireRole` can only express "at least X". |
| **Expected** | Permissions expressible independently of rank |
| **Actual** | All permissions collapse onto one ordering |
| **Verification** | Read `roleAtLeast` and note every call site uses a scalar |

**Why MEDIUM:** for the current 5 roles this is workable. It becomes a defect when a customer asks for a "viewer who may export" or an "auditor who may read everything but change nothing" — both standard requests. It also makes the least-privilege story weaker than it appears.

**Recommended correction:** Either document the constraint explicitly (cheapest, honest) or move to a permission set per role. Do not silently add a sixth role hoping the hierarchy stretches.

**Verification requirements:** A written statement in `SECURITY.md` of what the linear model cannot express.

---

### TEN-002 — API-key scoping is coarse and its enforcement point is not uniformly verified

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | `apps/backend/src/services/api-key*`; `guards.ts:46-58` |
| **Evidence** | An API key resolves to a principal carrying `role` and `scopes`. Routes check the *role* via `requireRole`, but only some check `scopes`. Grep for scope checks shows a small number of call sites relative to the 101 routes. |
| **Expected** | Every route reachable by an API key either checks a scope or documents that role is sufficient |
| **Actual** | Inconsistent — most routes rely on role alone |
| **Verification** | STATIC: enumerate routes callable with `X-API-Key` and check for a scope guard |

**Recommended correction:** Either (a) require an explicit scope for every API-key-reachable route, or (b) state that an API key is equivalent to its owner's role and drop "scopes" from the model as misleading.

**Verification requirements:** A test per API-key-reachable route asserting the intended denial.

---

### TEN-003 — No automated detection of a new route that forgets tenancy

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | CI / test architecture |
| **Evidence** | Tenancy correctness is proven by 5 hand-written negative tests. There is no lint rule, no repository-level enforcement (e.g. a query builder that *requires* an org id), and no generated cross-tenant suite over all 101 routes. A new route added tomorrow with a missing predicate would pass CI. |
| **Expected** | Structural enforcement or generated coverage |
| **Actual** | Point coverage only |
| **Verification** | `grep -rn "organisation_id" apps/backend/src/repositories` shows convention, not compulsion |

**Recommended correction:** Generate a cross-tenant smoke suite from the route registry: for every authenticated route, call it as org B against a resource owned by org A and assert 404. This is the highest-leverage test in the whole programme.

**Verification requirements:** The generated suite exists and fails if a route is added without isolation.

---

### TEN-004 — Ownership transfer paths are not covered by isolation tests

| Field | Value |
|---|---|
| **Severity** | **LOW** |
| **Affected** | `teams` domain — role change, ownership transfer, member removal |
| **Evidence** | Isolation tests cover read paths well; the mutation paths (demote, remove, transfer) are covered by functional tests but not by a cross-tenant negative test. |
| **Expected** | A member of org B cannot demote a member of org A |
| **Actual** | Believed safe by construction (membership lookup is org-scoped) but not asserted |
| **Verification** | STATIC |

**Recommended correction:** Add 3 negative tests for the mutation paths.

---

## 7. Missing functionality

| Item | Status |
|---|---|
| Permission-based (non-hierarchical) roles | **Not implemented** |
| Generated cross-tenant suite | **Not implemented** (TEN-003) |
| Per-resource ACLs | **Not implemented** — org + role only |
| API-key scope enforcement uniformity | **Partially implemented** (TEN-002) |

---

## 8. Security concerns

Tenant isolation is the security property this domain owns, and it is well served: data-layer predicates plus re-read membership plus negative tests. The residual risk is **future drift** (TEN-003) — the current guarantees are maintained by discipline and five tests, not by construction.

---

## 9. Performance concerns

Re-reading membership on every request costs one indexed query per call. Correct trade-off for security; worth noting for R17 as a fixed per-request overhead.

---

## 10. Recommendations

1. **Generate the cross-tenant suite** (TEN-003) — the single highest-value test investment available.
2. Decide and document the API-key scope model (TEN-002).
3. Document the linear-role limitation (TEN-001).
4. Add mutation-path isolation tests (TEN-004).

---

## EVIDENCE CLASSIFICATION

| Class | Items |
|---|---|
| **A. Verified working** | Membership re-read, 143 predicates, 5 isolation tests, unified actor shape, `requireRole` composition |
| **B. Verified failing** | TEN-002 (inconsistent scoping) |
| **C. Not implemented** | Permission model, generated suite, resource ACLs |
| **D. Partially implemented** | Role model (works, cannot express fine permissions); API-key scopes |
| **E. Unable to verify** | Behaviour under concurrent membership change mid-request |

---

## ISSUE SUMMARY

| ID | Severity | Title |
|---|---|---|
| TEN-001 | MEDIUM | Linear role model cannot express fine-grained permissions |
| TEN-002 | MEDIUM | API-key scope enforcement inconsistent |
| TEN-003 | MEDIUM | No structural enforcement; new routes can forget tenancy |
| TEN-004 | LOW | Mutation-path isolation untested |

**Totals: 0 CRITICAL · 0 HIGH · 3 MEDIUM · 1 LOW**
