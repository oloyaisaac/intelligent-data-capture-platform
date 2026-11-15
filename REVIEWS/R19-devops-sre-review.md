# REVIEWER NAME: DevOps / SRE Engineer (R19)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R19-devops-sre.md` (78 checklist items)
**STATUS:** ☑ Complete — **no deployment performed** (no Docker, no target infrastructure)

---

## AREAS EXAMINED

CI pipeline (2 jobs, 10 steps) · absence of container artefacts · environment configuration · migration execution · secret management · proxy trust · runbooks · deployment documentation.

---

## 1. Summary of examination

I read `ci.yml` in full, checked for every artefact a deployment needs, and read `DEPLOYMENT.md` and `ENVIRONMENT.md` as if following them.

**Verdict: this project has a CI pipeline but no deployment story.** There is no Dockerfile, no compose file, no orchestration manifest, no deployment job, no environment promotion, and no rollback procedure. `DEPLOYMENT.md` describes *what a deployment should contain* without providing the means to perform one. The gap between "the tests pass" and "a customer can be served" is the largest structural gap in the repository after R-01.

---

## 2. Files and components inspected

| File | Checked |
|---|---|
| `.github/workflows/ci.yml` | 2 jobs, 10 steps — full read |
| `DEPLOYMENT.md` | 19 KB — claims vs artefacts |
| `ENVIRONMENT.md` | setup instructions |
| `package.json` | scripts (no deploy, no backup) |
| `apps/backend/src/config.ts` | production requirements |
| `apps/backend/src/http/app.ts` | `TRUST_PROXY`, headers |

---

## 3. Features examined

Build · test · lint · typecheck · secret scan · contracts · artefact production · environment config · migration path · process supervision · rollback.

---

## 4. Tests performed

| # | Test | Result |
|---|---|---|
| T1 | CI job count | **2** (`verify`, `secrets`) |
| T2 | CI step count | **10** |
| T3 | Dockerfile present | **NO** |
| T4 | `docker-compose.yml` present | **NO** |
| T5 | Deployment job in CI | **NO** |
| T6 | Environment promotion (staging→prod) | **NO** |
| T7 | Rollback procedure | **NO** |
| T8 | `db:backup` script | **NO** |
| T9 | Migration run in CI | **NO** — migrations only run via script, never in CI |
| T10 | `secrets` job | **PASS** — filename scan |
| T11 | Reproducible install | **PASS** — `npm ci` |
| T12 | Actual deployment | **NOT RUN** |
| T13 | Proxy trust configuration | **PRESENT** — `TRUST_PROXY` |

---

## 5. Successful findings

1. **CI is properly gated and fast.** 10 steps covering install → typecheck → lint → format → 4 contract validators → tests → renderer build → secret scan. Everything that matters before merge is checked.
2. **`npm ci` is used**, so installs are reproducible from the lockfile.
3. **A secret-scanning job exists** and fails the build on committed key material.
4. **Contract validators are first-class CI citizens** — PRD, OpenAPI, legal and packaging are all enforced.
5. **`TRUST_PROXY` is configurable rather than hardcoded**, which is the right shape for reverse-proxy deployments.
6. **`ENVIRONMENT.md` is accurate enough to follow** — I set up the repository from it without improvisation.

---

## 6. Identified problems

### OPS-001 — No Dockerfile, no compose, no deployment artefact of any kind

| Field | Value |
|---|---|
| **Severity** | **CRITICAL** |
| **Affected** | Repository root; deployment |
| **Evidence** | `ls Dockerfile docker-compose.yml .dockerignore` → all absent. No k8s manifests, no systemd units, no Procfile. `grep -nE "deploy\|release\|docker" .github/workflows/ci.yml` → nothing. |
| **Expected** | A buildable, runnable production artefact |
| **Actual** | None exists. `DEPLOYMENT.md` describes requirements without supplying the means. |
| **Verification** | `ls`; read `ci.yml` |

**Why CRITICAL:** this is the second half of the release-layer gap. R-01 means the desktop app cannot talk to the backend; OPS-001 means there is no backend to talk to. Together they are why the product has never been runnable outside a developer's machine. Note also that AIX-004 (missing `tesseract`) is unsolvable without an image to install it into.

**Recommended correction:** Add a multi-stage `Dockerfile` (build → runtime), a `docker-compose.yml` for local/production parity including PostgreSQL, and a CI job that builds the image. Document the run in `DEPLOYMENT.md`.

**Verification requirements:** `docker compose up` bringing a working stack with migrations applied; CI building the image on every push.

---

### OPS-002 — Migrations are never executed in CI, so DB-001 persists indefinitely

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | `.github/workflows/ci.yml` |
| **Evidence** | No step runs `npm run db:migrate`. No PostgreSQL service container is declared. |
| **Expected** | Migrations applied against both drivers in CI |
| **Actual** | Only the SQLite test path runs, and it builds schema in-memory |
| **Verification** | Read `ci.yml` — 10 steps, none touches the database |

**Recommended correction:** Add a `postgres:16` service container and a step running `DB_DRIVER=postgres npm run db:migrate && npm test`. This single change closes DB-001 permanently.

---

### OPS-003 — No rollback procedure and no versioned artefacts

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | `DEPLOYMENT.md` |
| **Evidence** | No rollback section that describes an executable procedure; nothing to roll back *to* because no versioned image is produced. |
| **Expected** | A documented, tested rollback |
| **Actual** | Forward-only migrations with no reverse path and no artefact history |
| **Verification** | Read `DEPLOYMENT.md`; there is no artefact registry |

**Recommended correction:** Version images, document rollback including the migration consideration (forward-only means rollback is code-only, which must be stated), and exercise it once.

---

### OPS-004 — No operational runbooks

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | Operations |
| **Evidence** | No runbook directory. No procedure for: queue backed up, connector failing, disk full, restore from backup, rotate credentials, investigate a suspect login. |
| **Expected** | One page per likely incident |
| **Actual** | None. Combined with REL-001/002 (no metrics, no alerts), an incident would be discovered by a customer. |
| **Verification** | Absence |

**Recommended correction:** Write the six runbooks named above. They are cheap and they are what a first hire needs.

---

### OPS-005 — Single process with no supervision strategy

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | Deployment |
| **Evidence** | `DEC-029` mandates a single process hosting API and worker. No process supervisor (systemd, PM2, container restart policy) is specified anywhere. |
| **Expected** | A restart policy and a health check wired to it |
| **Actual** | Unspecified |
| **Verification** | Read `DEPLOYMENT.md` |

**Recommended correction:** Specify the supervisor and wire it to `/health` (and `/ready` once REL-006 exists).

---

### OPS-006 — No environment separation

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | CI/CD |
| **Evidence** | No staging environment, no promotion, no environment-specific configuration mechanism. `DEPLOYMENT.md` implies build-time `API_BASE_URL` injection which does not exist (DESK-001). |
| **Expected** | At least dev/staging/prod |
| **Actual** | Only developer machines |

**Recommended correction:** Define the environments and how configuration differs.

---

### OPS-007 — `secrets` job matches filenames only, not content

| Field | Value |
|---|---|
| **Severity** | **LOW** |
| **Affected** | `ci.yml` secrets job |
| **Evidence** | The job greps tracked filenames for `.env`, `.pem`, `.p12`, `.key`, `id_rsa`. A token pasted into a `.ts` file would not be caught. |
| **Expected** | Entropy/pattern scanning of content |
| **Actual** | Filename matching |
| **Verification** | Read the job |

**Recommended correction:** Add gitleaks or trufflehog. Cheap and materially stronger.

---

## 7. Missing functionality

| Item | Status |
|---|---|
| Dockerfile | **Not implemented** |
| Compose / orchestration | **Not implemented** |
| Deployment pipeline | **Not implemented** |
| Rollback | **Not implemented** |
| Runbooks | **Not implemented** |
| Staging environment | **Not implemented** |
| Backup automation | **Not implemented** |
| Log aggregation | **Not implemented** |
| Content secret scanning | **Not implemented** |

---

## 8. Security concerns

`TRUST_PROXY` misconfiguration is a client-IP spoofing vector affecting rate limiting (which is IP-keyed). The default should be conservative and documented as such. Secret scanning is filename-only (OPS-007). No container means no image-scanning baseline.

---

## 9. Performance concerns

No deployment target means no capacity planning is possible. Cross-ref PERF-004.

---

## 10. Recommendations

1. **Build the Dockerfile and compose stack (OPS-001)** — unblocks AIX-004, DB-001 and any real deployment.
2. **Run migrations against PostgreSQL in CI (OPS-002)** — closes the most consequential unknown in the repository for the price of ~20 lines of YAML.
3. Document rollback and write six runbooks (OPS-003/004).
4. Upgrade secret scanning to content-based (OPS-007).

---

## EVIDENCE CLASSIFICATION

| Class | Items |
|---|---|
| **A. Verified working** | CI gating, `npm ci`, secret job, contract validators, `TRUST_PROXY` configurability, `ENVIRONMENT.md` accuracy |
| **B. Verified failing** | OPS-001 … OPS-007 |
| **C. Not implemented** | Docker, compose, deploy, rollback, runbooks, staging, backup, log aggregation |
| **D. Partially implemented** | Secret scanning (filename only); deployment docs (requirements without means) |
| **E. Unable to verify** | Any deployed behaviour — no infrastructure |

---

## ISSUE SUMMARY

| ID | Severity | Title |
|---|---|---|
| OPS-001 | **CRITICAL** | No deployable artefact exists |
| OPS-002 | **HIGH** | Migrations never run in CI; DB-001 persists |
| OPS-003 | **HIGH** | No rollback, no versioned artefacts |
| OPS-004 | **HIGH** | No operational runbooks |
| OPS-005 | MEDIUM | No process supervision strategy |
| OPS-006 | MEDIUM | No environment separation |
| OPS-007 | LOW | Secret scan is filename-only |

**Totals: 1 CRITICAL · 3 HIGH · 2 MEDIUM · 1 LOW**
