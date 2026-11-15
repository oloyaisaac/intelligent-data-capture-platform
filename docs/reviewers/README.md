# IDCP Reviewer Programme — Index

**Purpose.** Twenty-two independent specialist reviews of `intelligent-data-capture-platform` (IDCP).
Each reviewer has **one self-contained Markdown brief** in this directory. A brief can be handed to an
agent or a human with no other document: it names every file, every checklist item, every command,
every test, the evidence required and the exact conditions for passing.

**Parent document:** [`../ASSESSMENT-2026-11.md`](../ASSESSMENT-2026-11.md) — the full assessment,
feature matrix, risk register (R-01 … R-26), production gates and effort model.
This directory is the *executable* half of that report.

**Baseline commit:** `43d384b` on branch `arena/bc459461-intelligent-data-capture-platf`.
All line references and counts in these briefs were measured against that commit.

---

## 1. How to use a brief

1. Read §3 (Repository context) — every brief repeats it so it stands alone.
2. Work §6 (Checklist) top to bottom. Every item has an ID unique across the whole programme (`ARC-AC-01`, `SEC-03`, `DESK-012`, …). Do not skip an item;
   if an item cannot be completed, record it under **Blocked** with the reason and what unblocks it.
3. Run §9 (Commands) and record real output. **Inspection alone is not evidence** for any item marked
   `[RUNTIME]`.
4. Produce §11 (Evidence) as files under `docs/reviewers/evidence/R##/`.
5. Sign §15 only if every item in §12 (Passing conditions) is true.

**Rule that governs all 22 reviews:** a successful build, a green test suite, or a passing lint run is
evidence that *the code is syntactically coherent* — never that a feature works. This repository already
demonstrates why: 406 tests pass while the packaged desktop application cannot reach its own backend
(see `R09`, finding R-01).

---

## 2. The register

| # | Reviewer | Board | Wave | Effort | Items | P's | Chairs | Co-signs | Brief |
|---|----------|-------|------|--------|-------|-----|--------|----------|-------|
| 01 | Software Architect | A — Architecture & core domain | 1 | 6 d | 42 | 12 | G1 | G8 | [R01](R01-software-architect.md) |
| 02 | Backend Engineer | A | 1 | 12 d | 38 | 11 | — | G1, G2 | [R02](R02-backend-engineer.md) |
| 03 | Database Engineer / Data Integrity | A | 1 | 14 d | 50 | 11 | G4 | G1, G6, G10 | [R03](R03-database-engineer.md) |
| 04 | API & Contract Engineer | A | 1 | 6 d | 37 | 8 | — | G1, G5 | [R04](R04-api-contract-engineer.md) |
| 05 | Authentication Engineer | B — Identity, security & privacy | 2 | 9 d | 60 | 10 | — | G3 | [R05](R05-authentication-engineer.md) |
| 06 | Authorisation & Multi-Tenancy | B | 2 | 10 d | 42 | 9 | — | G3 | [R06](R06-authorisation-multi-tenancy.md) |
| 07 | Application Security (offensive) | B | 2 | 15 d | 80 | 11 | G3 | G5 | [R07](R07-application-security.md) |
| 08 | Privacy Engineer / DPO | B | 2 | 8 d | 62 | 10 | — | G3 | [R08](R08-privacy-dpo.md) |
| 09 | Desktop Renderer Engineer | C — Client platforms & experience | 3 | 12 d | 52 | 10 | — | G2 | [R09](R09-desktop-renderer.md) |
| 10 | Electron Platform & Packaging | C | 3 | 12 d | 65 | 9 | — | — | [R10](R10-electron-platform-packaging.md) |
| 11 | Mobile Engineer | C | 3 | 12 d | 55 | 9 | — | G2 | [R11](R11-mobile-engineer.md) |
| 12 | UX / Product Design | C | 3 | 8 d | 55 | 10 | G7 | G9 | [R12](R12-ux-product-design.md) |
| 13 | Accessibility & i18n | C | 3 | 8 d | 60 | 11 | — | G7 | [R13](R13-accessibility-i18n.md) |
| 14 | AI / Document Intelligence | D — AI & integrations | 4 | 15 d | 54 | 9 | — | G9 | [R14](R14-ai-extraction.md) |
| 15 | Integration / Connectors | D | 4 | 16 d | 56 | 9 | G5 | — | [R15](R15-integration-connectors.md) |
| 16 | QA Lead & Test Architecture | E — Quality, performance & reliability | 4 | 12 d | 60 | 10 | G2, G8 | — | [R16](R16-qa-test-architecture.md) |
| 17 | Performance & Scalability | E | 4 | 10 d | 46 | 10 | G6 | — | [R17](R17-performance-scalability.md) |
| 18 | Reliability & Observability | E | 4 | 8 d | 63 | 11 | — | G4, G6, G10 | [R18](R18-reliability-observability.md) |
| 19 | DevOps / SRE | F — Operations & delivery | 5 | 12 d | 78 | 10 | G10 | G4 | [R19](R19-devops-sre.md) |
| 20 | Documentation & Traceability | F | 5 | 6 d | 49 | 10 | — | G1 | [R20](R20-documentation-traceability.md) |
| 21 | Compliance & Legal-Technical | G — Business, legal & acceptance | 5 | 8 d | 52 | 11 | — | G3 | [R21](R21-compliance-legal.md) |
| 22 | UAT & Commercial Readiness | G | 5 | 15 d | 50 | 10 | G9 | G2, G7 | [R22](R22-uat-commercial-readiness.md) |


**Total: 22 reviewers · ≈224 person-days · ≈45 person-weeks · 1 206 checklist items · 221 passing conditions.**
*Every count in the two right-hand columns was measured from the briefs themselves, not estimated.*

---

## 3. Wave plan and hard dependencies

```
Wave 1 (wk 1–2)   01 Architecture · 02 Backend · 03 Database · 04 API
                        │
        ┌───────────────┴───────────────┐
Wave 2 (wk 3–5)  05 Authn · 06 Authz · 07 AppSec · 08 Privacy
Wave 3 (wk 3–5)  09 Renderer · 10 Electron · 11 Mobile · 12 UX · 13 A11y/i18n
                        │
Wave 4 (wk 6–8)  14 AI · 15 Connectors · 16 QA · 17 Performance · 18 Reliability
                        │
Wave 5 (wk 9–13) 19 DevOps · 20 Docs · 21 Compliance · 22 UAT
```

- **Wave 1 first.** Reviewer 03 must settle R-04 (PostgreSQL) before Reviewer 17 measures anything;
  a broken production database invalidates every performance number.
- **Waves 2 and 3 run concurrently.** They share no files. Both must be green before Wave 4, because
  Wave 4 needs packaged builds and working identity.
- **Wave 5 last.** Running the UAT pilot (22) before Gates 1–8 are green spends operator goodwill
  rediscovering known defects.

---

## 4. Gate ownership

| Gate | Name | Chair | Co-signers |
|------|------|-------|-----------|
| G1 | Architecture approval | 01 | 02, 03, 04, 20 |
| G2 | Functional correctness | 16 | 02, 09, 11, 22 |
| G3 | Security & privacy approval | 07 | 05, 06, 08, 21 |
| G4 | Database & data integrity | 03 | 19, 18 |
| G5 | Integration approval | 15 | 04, 07 |
| G6 | Performance & reliability | 17 | 18, 03 |
| G7 | UI/UX & accessibility | 12 | 13, 22 |
| G8 | Automated testing approval | 16 | 01 |
| G9 | Real-world user acceptance | 22 | 12, 14 |
| G10 | Deployment & operational readiness | 19 | 18, 03 |

**G3 is never waivable. G10 cannot be declared before G8.**

---

## 5. Severity scale (shared by all reviewers)

Use this vocabulary in every finding so 22 reviews can be merged into one register.

| Level | Meaning | Release effect |
|-------|---------|----------------|
| **CRITICAL** | A customer cannot lawfully or practically use the product; data loss; cross-tenant leak; shipped artefact cannot function | Blocks release |
| **HIGH** | A promise the product makes is false at runtime; a security control is absent but reachable | Blocks release unless owner signs a dated exception |
| **MEDIUM** | A gap a buyer's reviewer will find; degraded behaviour with a workaround | Must have an owner and a date |
| **LOW** | Polish, consistency, documentation drift | Tracked only |

Every finding must carry: **ID · severity · file:line · what is wrong · why it matters · how to reproduce ·
suggested fix · owner reviewer**.

---

## 6. Finding ID convention

Each reviewer owns a block of 100 IDs so findings never collide when merged:

| Reviewer | Finding IDs | Checklist IDs | Reviewer | Finding IDs | Checklist IDs |
|----------|-------------|---------------|----------|-------------|---------------|
| 01 | ARC-001… | ARC-AC-01…42 | 12 | UX-001… | UX-01…55 |
| 02 | BE-001… | BE-AC-01…38 | 13 | A11Y-001… | A11Y-01…60 |
| 03 | DB-001… | DB-AC-01…50 | 14 | AIX-001… | AIX-01…54 |
| 04 | API-001… | API-AC-01…37 | 15 | CONX-001… | CONX-01…56 |
| 05 | AUTH-001… | AUTH-01…60 | 16 | QA-001… | QA-01…60 |
| 06 | TEN-001… | TEN-AC-01…42 | 17 | PERF-001… | PERF-01…46 |
| 07 | SEC-001… | SEC-01…80 | 18 | REL-001… | REL-01…63 |
| 08 | PRIV-001… | PRIV-AC-01…62 | 19 | OPS-001… | OPS-01…78 |
| 09 | DESK-001… | DESK-01…52 | 20 | DOCS-001… | DOCS-01…49 |
| 10 | ELEC-001… | ELEC-01…65 | 21 | COMP-001… | COMP-01…52 |
| 11 | MOB-001… | MOB-01…55 | 22 | UAT-001… | UAT-01…50 |

**Two namespaces, deliberately separate.** A checklist item (`SEC-27`) is a *question you must answer*.
A finding (`SEC-001`) is a *defect you confirm*. Do not reuse a checklist ID as a finding ID — a review that
answers 80 questions will not produce 80 findings, and the merge in §9 must be able to tell them apart.

> Note: `PRD.json` already uses story IDs in the same shape (`DESK-001`, `CON-002`, `AI-002`, `SEC-001`, `DOC-001`).
> This is why R14 uses **`AIX-`**, R15 uses **`CONX-`** and R20 uses **`DOCS-`** rather than `AI-`, `CON-`, `DOC-`.
> When a finding refers to a PRD story, write it as `ARC-012 (refs PRD DESK-001)` to avoid ambiguity.

---

## 7. Environment facts that every reviewer needs

Measured on the assessment environment (Node 22.22.3, npm 10.9.8):

| Fact | Value |
|------|-------|
| Tracked files | 245 |
| First-party LOC | ≈41,300 (backend 18,451 · desktop 10,008 · mobile 5,029 · shared 4,864 · connectors 2,936) |
| HTTP routes registered | 101 |
| OpenAPI operations | 102 across 85 paths |
| Tables / indexes | 32 / 29, one forward-only migration set (`migrations.ts`, 528 LOC) |
| PRD stories | 45, all `done`, **11 carry `verification` blocks** |
| Tests | 406 in 30 suites, all passing |
| Coverage | statements 74.47 %, **branches 58.75 %**, functions 66.2 %, lines 76.88 % |
| Advisories | `npm audit` 23 total; `npm audit --omit=dev` 8 (1 critical, 5 high) |
| E2E tooling | **none** (no Playwright / Detox / Maestro / Cypress) |
| `tesseract` binary | **absent** in this environment |
| Mail transport | **absent** in the repository |
| PostgreSQL / MySQL | **not available** in this environment |

Full setup: [`../../ENVIRONMENT.md`](../../ENVIRONMENT.md). Test doctrine: [`../../TESTING.md`](../../TESTING.md).

---

## 8. Files that must not be edited by a reviewer

A reviewer produces **findings and evidence**, not code. Implementation happens after the register is
complete. Exception: a reviewer may create files **only** under `docs/reviewers/evidence/R##/`.
Any code change must be raised as a finding and executed in a separate, scoped implementation task.

---

## 9. Merging 22 reviews

When all briefs are returned:

1. Concatenate §14 (Findings) into one register, sorted CRITICAL → HIGH → MEDIUM → LOW.
2. De-duplicate using the cross-references each brief declares in §3 (Upstream/Downstream).
3. Check every finding has an owner and a target gate.
4. Re-run Gate sign-off (§4) with the chairs.
5. Only then open implementation work, ordered by the critical path in
   `../ASSESSMENT-2026-11.md` §12.

---

## 10. Verification of this brief set

Before the briefs were handed over, the following were checked **programmatically** against the files
themselves — not asserted from memory. Re-run the commands to confirm.

| Check | Command | Result |
|-------|---------|--------|
| All 22 briefs exist and are indexed | `ls R[0-9][0-9]-*.md \| wc -l` | 22 |
| Every brief has all 15 sections in the same order | see script below | 22/22 |
| No duplicate checklist ID within a brief | see script below | 0 duplicates |
| Gate chairs and co-signs match `ASSESSMENT-2026-11.md` §11 | see script below | 22/22 |
| Every brief carries the `43d384b` commit stamp | `grep -c 'Reviewed commit' R*.md` | 22 |
| Every brief names its own evidence directory | `grep -l 'docs/reviewers/evidence/R' R*.md \| wc -l` | 22 |
| Every brief contains the bootstrap commands | see script below | 22/22 |
| Every internal Markdown link resolves | `for f in $(grep -oE '\]\(R[0-9]{2}-[^)]+' README.md \| tr -d ']( '); do test -f "$f" \|\| echo "MISSING $f"; done` | 0 missing |

**Totals measured from the briefs:** 8 338 lines · **1 206 checklist items** · **221 passing conditions**.

### Re-run the structural audit

```bash
cd docs/reviewers
python3 - <<'PY'
import re, glob
SEC=["Mission","Required expertise","Repository context","Exact files","Upstream","Checklist","Known",
     "Questions","Commands to run","Tests to perform","Evidence required","Passing conditions",
     "Blocked items","Findings register","Reviewer sign-off"]
APPROVERS={'G1':['R01','R02','R03','R04','R20'],'G2':['R16','R02','R09','R11','R22'],
 'G3':['R07','R05','R06','R08','R21'],'G4':['R03','R19','R18'],'G5':['R15','R04','R07'],
 'G6':['R17','R18','R03'],'G7':['R12','R13','R22'],'G8':['R16','R01'],
 'G9':['R22','R12','R14'],'G10':['R19','R18','R03']}
CHAIR={g:v[0] for g,v in APPROVERS.items()}
CO={g:[r for r in v if r!=CHAIR[g]] for g,v in APPROVERS.items()}
errs=[]; tI=tP=0
for i in range(1,23):
    f=glob.glob(f'R{i:02d}-*.md')[0]; s=open(f).read()
    h=[l for l in s.split('\n') if l.startswith('## ')]
    if len(h)!=15: errs.append(f"{f}: {len(h)} sections")
    for k,nm in enumerate(SEC):
        if k<len(h) and not re.match(rf'^## {k+1}\. .*{re.escape(nm)}',h[k]):
            errs.append(f"{f}: §{k+1} {nm}")
    pfx=re.search(r'\| \*\*Finding prefix\*\* \| `?([A-Z][A-Z0-9]{1,4})-',s).group(1)
    a=re.search(r'^## 6\. ',s,re.M); b=re.search(r'^## 7\. ',s,re.M)
    ids=re.findall(rf'^\| \*?\*?({pfx}-AC-\d{{2,3}}|{pfx}-\d{{2,3}}) \|',s[a.end():b.start()],re.M)
    if len(ids)!=len(set(ids)): errs.append(f"{f}: duplicate ids")
    tI+=len(ids)
    a2=re.search(r'^## 12\. ',s,re.M); b2=re.search(r'^## 13\. ',s,re.M)
    tP+=len(re.findall(r'^- \[ \] \*\*P\d+\*\*',s[a2.end():b2.start()],re.M))
    ch=set(re.findall(r'G\d+',re.search(r'\| \*\*Gate chaired\*\* \|(.*)\|',s).group(1)))
    co=set(re.findall(r'G\d+',re.search(r'\| \*\*Co-signs\*\* \|(.*)\|',s).group(1)))
    if ch!={g for g in APPROVERS if CHAIR[g]==f[:3]}: errs.append(f"{f}: chairs")
    if co!={g for g in APPROVERS if f[:3] in CO[g]}: errs.append(f"{f}: co-signs")
    if 'npm ci' not in s: errs.append(f"{f}: no bootstrap")
print(f"files=22 items={tI} conditions={tP} errors={len(errs)}")
for e in errs: print(" !", e)
PY
```

Expected output: `files=22 items=1206 conditions=221 errors=0`.
