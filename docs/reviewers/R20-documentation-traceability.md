# REVIEWER 20 — DOCUMENTATION & TRACEABILITY ENGINEER

| Field | Value |
|-------|-------|
| **Reviewer ID** | R20 |
| **Title** | Documentation & Traceability Engineer |
| **Board** | F — Operations & delivery |
| **Wave** | 5 (weeks 9–13) |
| **Effort** | 6 person-days |
| **Gate chaired** | none |
| **Co-signs** | G1 |
| **Evidence to** | G2, G4, G10 (contributes findings, not an approver) |
| **Finding prefix** | `DOCS-###` (use `DOCS-###` to avoid collision with PRD `DOC-001`) |
| **Upstream** | All reviewers — you verify their findings are reflected in the docs |
| **Downstream** | G1, and the accuracy of every future handover |
| **Status** | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Establish whether every factual claim in the repository's documentation is **true of the code at this commit**,
and build the traceability that lets someone verify the product's status without reading 41 000 lines.

**This repository has an unusual documentation-to-code ratio:** 24 Markdown files (~250 KB) against ~41 300
lines of code, plus a 49 KB `PRD.json`, a 44 KB `DATABASE.md`, a 43 KB `DECISIONS.md` and a 29 KB `API.md`.
That discipline is a genuine strength — it is *why* this assessment could be precise. But documentation at this
volume **drifts**, and it has already drifted in at least five measurable places.

**Known drift at commit `43d384b` — verify each, do not simply copy:**

| # | Document | Claim | Reality |
|---|----------|-------|---------|
| 1 | `ARCHITECTURE.md` §8 | "No application code, so none of the above is implemented." | ~41 300 LOC exist |
| 2 | `ARCHITECTURE.md` §6 | "Target repository layout" includes `apps/backend/prisma/` | No `prisma/` directory exists; the project uses hand-written migrations |
| 3 | `ARCHITECTURE.md` §5 | A "connector sandbox" | Connectors run **in-process**; there is no sandbox |
| 4 | `AGENT_STATE.md` ops gap 4 / `AUDIT-2026-10.md` §4.2 | "9 advisories (1 critical, 2 high…)", "all transitive or build-time", "`zod` … transitive" | `npm audit` = **23** total, **8** production; `zod` is a **direct** production dependency |
| 5 | `DEPLOYMENT.md` line 104 | "`API_BASE_URL` baked per build environment" | **No build-time injection exists**; the renderer uses a hardcoded relative default (R-01) |
| 6 | `TASKS.md` | Notes that `DATABASE.md` once claimed the schema was unimplemented and DEC-013 was missing while being cited | Verify those fixes held and that no new citation drift exists |
| 7 | `legal/*` | Company identity | `[COMPANY NAME]`, `[ADDRESS]`, `[REGISTRATION NO.]` placeholders remain |

---

## 2. Required expertise

- Requirements traceability (story → code → test → evidence)
- Documentation-as-code and doc/contract drift detection
- Technical writing and information architecture (deleting duplication, naming a canonical source)
- Architecture Decision Record hygiene
- Changelog and release-note discipline
- Verifying that a validator actually enforces what it claims

---

## 3. Repository context (self-contained)

**Product.** IDCP — a three-platform, multi-tenant document-capture product.

**Documentation inventory (24 Markdown files + 3 JSON/schema artefacts):**

| Document | Size | Purpose | Verify |
|----------|------|---------|--------|
| `README.md` | 13.3 KB | Entry point, features, status | Feature claims vs code |
| `ARCHITECTURE.md` | 12.8 KB | Technical blueprint | **Contains known drift (1–3)** |
| `DATABASE.md` | 44.8 KB | Data model | vs `migrations.ts` |
| `API.md` | 29.2 KB | HTTP + realtime contract | vs `openapi.yaml` + routes |
| `SECURITY.md` | 13.9 KB | Security rulebook | vs implemented controls |
| `TESTING.md` | 20.3 KB | Test doctrine + §3.1 verification-block kinds | vs the suite |
| `DEPLOYMENT.md` | 19.1 KB | Go-live + §11 gap table | **Contains known drift (5)** |
| `ENVIRONMENT.md` | 12.5 KB | Dev setup | Reproduce it |
| `REQUIREMENTS.md` | 13.2 KB | Business → technical | vs PRD |
| `DECISIONS.md` | 43.8 KB | DEC-001…DEC-034+ | Citation integrity |
| `CHANGELOG.md` | 22.1 KB | History | vs git log |
| `AGENT_STATE.md` | 12.1 KB | Handover | **Contains known drift (4)** |
| `TASKS.md` | 6.3 KB | Current work queue | vs reality |
| `CONTRIBUTING.md` | 5.2 KB | Contribution rules | Enforced? |
| `AI.md` | 8.1 KB | Agent behaviour rules | Followed? |
| `AUDIT-2026-10.md` | 17.8 KB | Prior audit | **Contains known drift (4)** |
| `PRD.json` | 49.8 KB | 45 stories, 15 epics, 4 open questions | Status accuracy |
| `ASSESSMENT-2026-11.md` | — | The parent assessment | Consistency with this programme |
| `legal/{PRIVACY,TERMS,DPA,SUBPROCESSORS,SECURITY,README}.md` | 496 lines | Legal pack | Placeholders; vs code |
| `docs/openapi.yaml` | 2 263 lines | API contract | vs routes (R04) |
| `docs/{udm-1.0,prd}.schema.json` | — | Generated schemas | Regeneration diff |
| `uploads/{PRD.md, requirements-1.md}` | — | Original source documents | Scope deviations |

**Validators (prove each bites):** `scripts/validate-prd.mjs`, `validate-openapi.mjs`,
`validate-packaging.mjs`, `validate-legal.mjs`, `generate-udm-schema.mjs --check`
(wired to `npm run test:prd`, `test:api`, `test:packaging`, `test:legal`).

---

## 4. Exact files and components to examine

### 4.1 Every document above, in full

You must read all 24 Markdown files end to end. This is the one review where skimming is disqualifying: drift
hides in a single sentence.

### 4.2 Every validator, in full

`scripts/*.mjs` — read the actual comparison logic, not the comment above it.

### 4.3 Code surfaces to cross-check claims against

`apps/backend/src/config.ts` (env claims) · `apps/backend/src/db/migrations.ts` (DATABASE.md) ·
`apps/backend/src/http/routes/*.ts` (API.md) · `packages/shared/src/contracts.ts` ·
`apps/backend/src/services/crypto.ts` + `auth/*` (SECURITY.md) · `package.json` scripts (README/ENVIRONMENT) ·
`.github/workflows/ci.yml` (README "the same command CI runs") · `jest.config.cjs` (TESTING.md).

### 4.4 Explicit non-goals

Feature correctness → owning reviewers · legal sufficiency → R21 · API contract depth → R04 ·
performance numbers → R17.

---

## 5. Upstream artefacts required

| From | Artefact | Why |
|------|----------|-----|
| All | Every `findings.md` | You must reflect each confirmed finding in the docs |
| R04 | `evidence/R04/coverage-diff.md` | For API.md reconciliation |

---

## 6. Checklist

### 6.1 The traceability matrix (primary deliverable)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DOCS-01 | Build a matrix: **45 PRD stories → implementing files → covering tests → evidence** | Read `PRD.json`; map each story | `evidence/R20/traceability-matrix.csv` with no blank row | **WRITE** |
| DOCS-02 | Flag every story marked `done` with **no** covering test | From the matrix | A list | **WRITE** |
| DOCS-03 | Flag every test that covers **no** story | Reverse-map the matrix | A list | **WRITE** |
| DOCS-04 | Flag every story whose acceptance criteria are not met | Cross-reference the 11 `verification` blocks (R16's audit) | A list | **WRITE** |
| DOCS-05 | Verify the 15 epics and 45 stories are internally consistent | Read `PRD.json` | No orphan stories, no missing epics | STATIC |
| DOCS-06 | Verify the 4 open questions (`Q-001`…`Q-004`) are still genuinely open and blocking what they claim | Read | Accurate | STATIC |
| DOCS-07 | Verify `REQUIREMENTS.md` and `uploads/PRD.md` are reflected in `PRD.json` | Sample 20 requirements | Each traced or explicitly dropped | STATIC |
| DOCS-08 | Verify `AI.md` rules were actually followed by the code | Read `AI.md`, spot-check 5 rules | Followed or the rule is stale | STATIC |

### 6.2 Known drift — confirm and correct

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DOCS-09 | `ARCHITECTURE.md` §8 "No application code…" | Read + `git ls-files \| wc -l` | **False — correct it** | STATIC |
| DOCS-10 | `ARCHITECTURE.md` §6 cites `prisma/` | `ls apps/backend/prisma` | **Does not exist — correct it** | STATIC |
| DOCS-11 | `ARCHITECTURE.md` §5 "connector sandbox" | `packages/connectors/src` | **No sandbox — correct it or implement one** | STATIC |
| DOCS-12 | Advisory counts in `AGENT_STATE.md` and `AUDIT-2026-10.md` §4.2 | `npm audit` | **Wrong — correct with the real numbers and the direct/transitive split** | **RUNTIME** |
| DOCS-13 | `DEPLOYMENT.md` "API_BASE_URL baked per build environment" | `vite.config.ts`, `App.tsx` | **No such mechanism — correct it** | STATIC |
| DOCS-14 | `README.md` "406 tests in 30 suites" | `npm test` | Verify the current number and make the doc say "as of <commit>" | **RUNTIME** |
| DOCS-15 | `README.md` "all 45 planned stories are built" | The verification blocks | True only with caveats — ensure the caveat is prominent, not buried | STATIC |
| DOCS-16 | `README.md` "the same command CI runs" | `ci.yml` | Verify equivalence | STATIC |
| DOCS-17 | `README.md` technology versions | `package-lock.json`, `node --version` | Accurate | STATIC |
| DOCS-18 | `AGENT_STATE.md` "Last updated 2026-10-27" and its "current task" | Compare with the actual HEAD state | Accurate or stale | STATIC |
| DOCS-19 | `TASKS.md` "Nothing open: all 45 stories are done" | Cross-check against known open items (R-01, R-02, CON-002) | **Misleading — correct it** | STATIC |
| DOCS-20 | `CHANGELOG.md` matches `git log --oneline` for the last 20 commits | Compare | Consistent | STATIC |

### 6.3 Citation integrity

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DOCS-21 | Every `DEC-###` cited anywhere exists in `DECISIONS.md` | `comm` of cited vs defined | Empty diff (precedent: DEC-013 was once missing) | **RUNTIME** |
| DOCS-22 | Every `DEC-###` defined is cited somewhere, or is explicitly standalone | Reverse check | Justified | STATIC |
| DOCS-23 | Every `DECISIONS.md` entry records the actual decision, the alternative, and the consequence | Read all | Complete; a decision without a consequence is a wish | STATIC |
| DOCS-24 | No decision is contradicted by the code without a superseding entry | Cross-check DEC-013, DEC-016, DEC-029, DEC-031, DEC-034 | Consistent or superseded | STATIC |
| DOCS-25 | Every file referenced by path in any document exists | Extract paths, `test -f` each | All exist | **RUNTIME** |
| DOCS-26 | Every internal Markdown link resolves | Link check | Zero broken | **RUNTIME** |
| DOCS-27 | Every external URL is reachable or marked as a placeholder | Check | Placeholders flagged | STATIC |

### 6.4 Validators — do they bite?

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DOCS-28 | `validate-prd.mjs` fails on an empty `verification` block | Seeded edit | Fails | **RUNTIME** |
| DOCS-29 | `validate-prd.mjs` fails on an invalid story field | Seeded edit | Fails | **RUNTIME** |
| DOCS-30 | `validate-openapi.mjs` fails on a removed route | Seeded edit | Fails | **RUNTIME** |
| DOCS-31 | `validate-openapi.mjs` fails on a response-shape change | Seeded edit | **Record result** (likely passes — hand to R04/R16) | **RUNTIME** |
| DOCS-32 | `validate-legal.mjs` fails on a retention-figure mismatch | Seed drift | Fails | **RUNTIME** |
| DOCS-33 | `validate-legal.mjs` fails on a placeholder in a shipping document | Seed drift | Record whether placeholders are gated | **RUNTIME** |
| DOCS-34 | `validate-packaging.mjs` fails on a broken target | Seeded edit | Fails | **RUNTIME** |
| DOCS-35 | `generate-udm-schema.mjs --check` fails on schema drift | Seeded edit | Fails | **RUNTIME** |
| DOCS-36 | Every validator prints an actionable error | Read outputs | Names file + fix | STATIC |

### 6.5 Claim audit — security, privacy and capability

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DOCS-37 | Every control claimed in `SECURITY.md` exists in code | Table each claim → implementation | Gaps listed (coordinate with R07/R08) | **WRITE** |
| DOCS-38 | `SECURITY.md` makes no claim about encryption at rest for filesystem storage that the code does not implement | Read | Correct or disclosed | STATIC |
| DOCS-39 | `legal/PRIVACY.md` retention figures match `config.ts` | Cross-check | Match | STATIC |
| DOCS-40 | `legal/SUBPROCESSORS.md` lists every actual recipient | vs connectors + AI | Complete | STATIC |
| DOCS-41 | `legal/*` placeholders are enumerated and gated | `grep "\["` | Listed; coordinated with R21 | STATIC |
| DOCS-42 | No document promises a capability that does not exist (billing, SSO, updates, email) | Sweep | Zero, or listed | STATIC |
| DOCS-43 | `TESTING.md` §3.1's explanation of verification-block kinds matches how the 11 blocks are actually used | Cross-check | Consistent | STATIC |

### 6.6 Structural quality

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DOCS-44 | Identify duplicated facts stated in multiple documents | Read all | A table: fact → documents → canonical source | **WRITE** |
| DOCS-45 | Name a single canonical source per fact and delete the copies | Proposal | A documentation map | **WRITE** |
| DOCS-46 | No document is over-long for its purpose (e.g. `DATABASE.md` 44 KB) | Assess | Structure improved or justified | STATIC |
| DOCS-47 | Every document states its **own currency** (commit/date it was verified) | Read | Present or added | STATIC |
| DOCS-48 | A newcomer can go from zero to a running system using `README` + `ENVIRONMENT` alone | Follow it literally on a clean machine | Works | **RUNTIME** |
| DOCS-49 | The `ASSESSMENT-2026-11.md` and this reviewer directory are internally consistent with R01–R22 | Cross-check | Consistent | STATIC |

---

## 7. Known documentation risks to confirm or refute

| Risk | Statement |
|------|-----------|
| **R-21 (LOW)** | Documentation drift in at least 7 places, including a document that denies the code exists |
| **R-08 (MEDIUM)** | 11 stories marked `done` with unverified criteria; `TASKS.md` says "Nothing open" |
| **R-26 (LOW)** | Duplicated contracts and specs across multiple documents |
| R-14 | Legal placeholders |
| R-05 | Advisory counts understated in two documents |

---

## 8. Questions you must answer

1. **Which document can a new engineer trust as the truth about this system, sentence for sentence?**
2. Which of the 45 stories has no test that would fail if its feature broke?
3. Do the five validators prevent drift, or only presence?
4. Which facts are stated in three places and will therefore diverge?
5. Does `SECURITY.md` describe implemented controls or aspirational ones?
6. Can someone follow `ENVIRONMENT.md` literally on a clean machine and succeed?

---

## 9. Commands to run

```bash
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund

# ---------- inventory ----------
ls -1 *.md legal/*.md docs/* | xargs wc -c | sort -rn | head -30

# ---------- DEC citation integrity ----------
grep -ohE "DEC-[0-9]{3}" -r . --include=*.md | sort -u > /tmp/cited.txt
grep -oE "^#+ *DEC-[0-9]{3}|^\| *DEC-[0-9]{3}" DECISIONS.md | grep -oE "DEC-[0-9]{3}" | sort -u > /tmp/defined.txt
echo "--- cited but NOT defined ---"; comm -23 /tmp/cited.txt /tmp/defined.txt
echo "--- defined but NOT cited ---"; comm -13 /tmp/cited.txt /tmp/defined.txt

# ---------- referenced paths exist? ----------
grep -ohE '`[a-zA-Z0-9_./-]+\.(ts|tsx|json|md|yaml|mjs|js)`' -r *.md | tr -d '`' | sort -u | while read p; do
  [ -e "$p" ] || echo "MISSING: $p"
done

# ---------- internal links ----------
npx --yes markdown-link-check@3 README.md ARCHITECTURE.md 2>/dev/null | tail -20

# ---------- drift checks ----------
grep -n "No application code" ARCHITECTURE.md
grep -n "prisma" ARCHITECTURE.md
grep -n "sandbox" ARCHITECTURE.md
grep -n "9 advisories\|advisories" AGENT_STATE.md AUDIT-2026-10.md
grep -n "API_BASE_URL" DEPLOYMENT.md
npm audit --omit=dev --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).metadata.vulnerabilities))"

# ---------- story/test traceability scaffold ----------
node -e "const p=require('./PRD.json');p.stories.forEach(s=>console.log(s.id+'\t'+s.status+'\t'+s.title))" > /tmp/stories.tsv
npx jest --listTests | sed 's|.*/||' > /tmp/suites.txt

# ---------- validators ----------
npm run test:prd && npm run test:api && npm run test:packaging && npm run test:legal
# then seed one drift into each and re-run
```

---

## 10. Tests to perform

| # | Test | Procedure | Pass criterion |
|---|------|-----------|----------------|
| T-01 | Clean-machine setup | Follow `ENVIRONMENT.md` literally | Works without improvisation |
| T-02 | Traceability matrix | 45 stories | No blank row |
| T-03 | DEC citation integrity | `comm` | Empty diff |
| T-04 | Path references | Test every referenced path | All exist |
| T-05 | Link check | Markdown link checker | Zero broken |
| T-06 | Validator sensitivity ×5 | Seed drift per validator | Each fails on its class |
| T-07 | Drift confirmation | The 7 known items | Each confirmed/refuted |
| T-08 | Claims audit | `SECURITY.md` → code | Gaps listed |
| T-09 | Duplication map | Read all docs | Table produced |
| T-10 | Placeholder inventory | Grep legal/ | Complete list |

---

## 11. Evidence required

```
docs/reviewers/evidence/R20/
├── traceability-matrix.csv      # 45 stories → files → tests → evidence
├── untested-stories.md          # DOCS-02
├── drift-register.md            # the 7 known + any new, with corrected text
├── dec-integrity.txt            # comm output
├── reference-check.txt          # missing paths
├── link-check.txt
├── validator-sensitivity.md     # T-06
├── claims-to-controls.md        # DOCS-37 … DOCS-43
├── duplication-map.md           # DOCS-44, DOCS-45
├── canonical-sources.md         # one source of truth per fact
├── commands.log
└── findings.md                  # DOCS-### register
```

---

## 12. Passing conditions (co-signs G1)

- [ ] **P1** The 45-story traceability matrix is complete with no blank row (DOCS-01).
- [ ] **P2** Every `done` story has a covering test, or is listed as unsupported (DOCS-02).
- [ ] **P3** All 7 known drift items are confirmed and corrected in the documents themselves (DOCS-09 … DOCS-20).
- [ ] **P4** Zero dangling `DEC-###` citations (DOCS-21, T-03).
- [ ] **P5** Every referenced file path and internal link resolves (DOCS-25, DOCS-26, T-04, T-05).
- [ ] **P6** Every validator is proven to fail on its own drift class, and response-shape drift is either covered or recorded (DOCS-28 … DOCS-36, T-06).
- [ ] **P7** Every security/privacy claim maps to an implemented control (DOCS-37 … DOCS-43).
- [ ] **P8** Duplicated facts are mapped and a canonical source is named for each (DOCS-44, DOCS-45).
- [ ] **P9** A newcomer can reach a running system from `README` + `ENVIRONMENT` alone (DOCS-48, T-01).
- [ ] **P10** Each document states the commit/date it was last verified (DOCS-47).

---

## 13. Blocked items

| Item ID | Blocker | What unblocks it | Owner |
|---------|---------|------------------|-------|
| DOCS-12 | Advisory numbers change as dependencies are fixed | Re-run after the zod migration | R07 |

---

## 14. Findings register

| ID | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
|----|----------|-----------|---------|----------------|-----------|---------------|-------|
| DOCS-001 | | | | | | | |

---

## 15. Reviewer sign-off

| Field | Value |
|-------|-------|
| Reviewer name | |
| Date started | |
| Date completed | |
| **G1 co-sign result** | ☐ Pass ☐ Fail ☐ Abstain |
| Stories without a covering test | |
| Drift items corrected | /7 |
| Conditions failed (IDs) | |
| Reviewed commit | `43d384b` |
| Statement | *I read all 24 Markdown documents end to end, built the 45-story traceability matrix, and seeded drift into each of the five validators to prove they bite.* |
| Signature | |
