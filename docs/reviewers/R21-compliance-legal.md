# REVIEWER 21 — COMPLIANCE & LEGAL-TECHNICAL REVIEWER

| Field | Value |
|-------|-------|
| **Reviewer ID** | R21 |
| **Title** | Compliance & Legal-Technical Reviewer |
| **Board** | G — Business, legal & acceptance |
| **Wave** | 5 (weeks 9–13) |
| **Effort** | 8 person-days |
| **Gate chaired** | none |
| **Co-signs** | G3 |
| **Evidence to** | G10 (contributes findings, not an approver) |
| **Finding prefix** | `COMP-###` |
| **Upstream** | R08 (PII inventory, claims matrix), R07 (security evidence) |
| **Downstream** | G3, G10, and every sales conversation |
| **Status** | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Determine whether IDCP can be **sold and operated lawfully**, and whether every security and privacy claim it
makes can be evidenced in a procurement review. You are not the lawyer — you are the technical reviewer who
proves that each legal promise has an implemented control behind it, and who assembles the evidence pack.

**The headline problem.** The legal pack exists and is unusually well-drafted for a product at this stage. But:

| Blocker | Detail |
|---------|--------|
| **Placeholders** | `[COMPANY NAME]`, `[ADDRESS]`, `[REGISTRATION NO.]` in `legal/PRIVACY.md`, `TERMS.md`, `DPA.md`, `SUBPROCESSORS.md` — **5 occurrences across 4 documents** |
| **No advocate review** | The pack self-declares: *"needs review by a Ugandan advocate before it is relied on commercially"* |
| **No penetration test** | Named explicitly by the repository's own procurement analysis as the item that "changes a security question" |
| **No SSO/SAML** | Asked for by every enterprise buyer |
| **No SOC 2 / ISO 27001** | No attestation of any kind |
| **MFA not enforceable** | An organisation cannot require a second factor (`AUDIT-2026-10.md` §4.1) |
| **Licence undecided** | `Q-002` open; `LICENSE` says proprietary/all rights reserved, pending owner confirmation |

---

## 2. Required expertise

- Uganda Data Protection and Privacy Act 2019 (and its Regulations) — controllers, DPO, registration, data-subject rights, 72-hour breach notification
- GDPR and the DPA (Art. 28) — processor obligations, sub-processor governance, transfers
- Contract drafting review: liability, warranty, SLA, termination, data return
- Security questionnaires and audit-evidence assembly
- Standards literacy: ISO 27001 control themes, SOC 2 trust criteria (as a buyer's frame, not a certification)
- Records of processing and DPIAs

---

## 3. Repository context (self-contained)

**Product.** IDCP photographs and extracts business documents (receipts, invoices, delivery notes, IDs,
contracts). Multi-tenant SaaS. Organisations are controllers/processors for their own customers; IDCP is the
processor. Personal data is core to the product, not incidental.

**Legal and compliance artefacts:**

| Artefact | Path | Size |
|----------|------|------|
| Privacy policy | `legal/PRIVACY.md` | — |
| Terms of service | `legal/TERMS.md` | — |
| Data processing agreement | `legal/DPA.md` | — |
| Sub-processor list | `legal/SUBPROCESSORS.md` | — |
| Security summary | `legal/SECURITY.md` | — |
| Legal pack README + validator notes | `legal/README.md` | — |
| Legal contract validator | `scripts/validate-legal.mjs` | in `npm run test:legal` |
| Licence | `LICENSE` | 2 KB |
| Compliance analysis (prior) | `AUDIT-2026-10.md` §3 (perspectives) | — |
| Published at runtime | `GET /legal`, `GET /legal/{slug}` (allow-listed) | `legal-routes.ts` |

**Compliance-relevant implementation**

| Control | Where | State |
|---------|-------|-------|
| Data-subject access | `GET /me/export` | Implemented (completeness → R08) |
| Erasure | `POST /me/erase` (password + `confirm:"DELETE"`) | Implemented (residue → R08) |
| Retention | `retention_days` + `MaintenanceService` (24 h sweep) | Implemented; observability thin |
| Audit trail | `audit_logs` + `GET /audit-logs.csv` | Implemented; append-only |
| Terms acceptance | `terms_accepted_at`, `terms_version` (`DEC-032`) | Implemented |
| MFA | TOTP + recovery codes (`DEC-034`) | Implemented; **not enforceable by policy** |
| Password recovery | `DEC-030` | **No delivery mechanism (R-02)** |
| Encryption in transit | TLS at proxy | Proxy-dependent |
| Encryption at rest | Connector credentials + MFA secrets (AES-256-GCM) | **Filesystem document storage is NOT encrypted by the app** |
| Access logging | `onResponse` structured line | Implemented |
| Secret scanning | CI `secrets` job | Implemented |

**Documented retention figures to reconcile:** documents **90 days** (configurable), audit entries
**24 months**, exports **7 days**, password resets **1 hour**, sessions **refresh TTL 30 days**.

**Documented open questions:** `Q-001` AI providers/budget · `Q-002` licence · `Q-003` hosting region ·
`Q-004` standalone desktop mode.

---

## 4. Exact files and components to examine

### 4.1 Must read in full — the legal pack

`legal/PRIVACY.md` · `legal/TERMS.md` · `legal/DPA.md` · `legal/SUBPROCESSORS.md` · `legal/SECURITY.md` ·
`legal/README.md` · `LICENSE` · `scripts/validate-legal.mjs` · `apps/backend/src/http/routes/legal-routes.ts`.

### 4.2 Must read — compliance-relevant claims elsewhere

`SECURITY.md` (13.9 KB) · `AUDIT-2026-10.md` (especially §3 "Perspective: what each reader would still ask for"
and §4 residual risk) · `PRD.json` `openQuestions` · `REQUIREMENTS.md` (regulatory requirements, if any) ·
`README.md` (claims made to customers).

### 4.3 Must cross-check against code

`apps/backend/src/services/privacy-service.ts` · `maintenance-service.ts` · `config.ts` (retention defaults) ·
`auth-service.ts` (terms acceptance, MFA) · `repositories/auth-repo.ts` (audit of privileged actions) ·
`http/app.ts` (headers, access log) · `services/crypto.ts` (what is and is not encrypted).

### 4.4 Explicit non-goals

Legal advice → a licensed advocate (you **commission** it and record the outcome) · technical privacy
completeness → R08 · offensive security → R07 · deployment hardening → R19.

---

## 5. Upstream artefacts required

| From | Artefact | Why |
|------|----------|-----|
| R08 | `evidence/R08/legal-claims-matrix.md` | Starting point: claims → implementation |
| R08 | `evidence/R08/subprocessor-map.md` | Verify the sub-processor list |
| R07 | `evidence/R07/findings.md` | Security gaps that affect representations |
| R19 | `evidence/R19/proxy-config.md` | TLS/HSTS evidence for "encryption in transit" |

---

## 6. Checklist

### 6.1 Launch-blocking placeholders

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| COMP-01 | Enumerate every placeholder in the legal pack | `grep -rn "\[[A-Z ]*\]" legal/` | Complete list (5 known: company name ×5, address ×3, registration no. ×3 — verify exact counts) | **RUNTIME** |
| COMP-02 | Identify documents that would be published with placeholders | `GET /legal/{slug}` serves them verbatim | **A customer can read a placeholder today** — critical | **RUNTIME** |
| COMP-03 | Decide the gating mechanism: refuse to publish until filled, or block the release | Design | A concrete gate | **WRITE** |
| COMP-04 | Confirm company registration details are required before commercial use | Legal opinion | Recorded | **WRITE** |
| COMP-05 | Verify `test:legal` does or does not fail on placeholders | Seed check | Record actual behaviour | **RUNTIME** |

### 6.2 Claims-to-controls matrix (primary deliverable)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| COMP-06 | Every security statement in `legal/SECURITY.md` maps to an implemented control | Read + cross-check | Every claim evidenced; unsupported claims removed | **WRITE** |
| COMP-07 | Every privacy statement in `legal/PRIVACY.md` maps to code | Read + cross-check | Same | **WRITE** |
| COMP-08 | "Encryption at rest" is scoped honestly | Read `PRIVACY.md`/`SECURITY.md` vs filesystem storage | **Document images are not encrypted by the app** — confirm the wording does not claim otherwise | STATIC |
| COMP-09 | "Encryption in transit" is backed by a deployed TLS configuration | Coordinate with R19 | Evidence available | STATIC |
| COMP-10 | Retention figures match `config.ts` | Cross-check + run `test:legal` | Match | **RUNTIME** |
| COMP-11 | The sub-processor list matches reality | `SUBPROCESSORS.md` vs connectors + AI + hosting | Complete, no phantom entries | STATIC |
| COMP-12 | The DPA's processor obligations are all technically satisfiable | Read against the controls | No impossible promise | STATIC |
| COMP-13 | MFA is described as available, not mandatory | Read | Accurate | STATIC |
| COMP-14 | Any claim about "no third-party access" is consistent with the opt-in cloud AI | Read | Accurate | STATIC |

### 6.3 Uganda DPPA 2019

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| COMP-15 | Controller/processor roles are correctly described | Read `PRIVACY.md`/`DPA.md` | Correct for a multi-tenant processor | STATIC |
| COMP-16 | Registration with the Authority is acknowledged as a duty | Read | Present; owner assigned | STATIC |
| COMP-17 | A DPO/contact is named and reachable | Read | **Likely a placeholder** | STATIC |
| COMP-18 | Each statutory data-subject right maps to an endpoint **and** a passing test | Export, erasure, rectification, objection | A matrix: right → endpoint → test | **WRITE** |
| COMP-19 | Breach notification within 72 hours has a written procedure | Search | Present or written by you | **WRITE** |
| COMP-20 | The evidence to support breach notification exists (access log, audit log, request ids) | Coordinate with R18 | Available | STATIC |
| COMP-21 | Cross-border transfer is addressed | Read `DPA.md`/`PRIVACY.md` | Present; consistent with `Q-003` | STATIC |
| COMP-22 | A record of processing activities can be produced | R08's inventory feeds this | Present | **WRITE** |
| COMP-23 | Sensitive/special-category data (ID documents) is identified and given an explicit basis | Read | Present | STATIC |

### 6.4 GDPR alignment (for EU customers)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| COMP-24 | Art. 28 processor obligations are covered by the DPA | Read | Covered | STATIC |
| COMP-25 | Art. 30 records of processing | R08 inventory → formal record | Present | **WRITE** |
| COMP-26 | Art. 32 security of processing is evidenced | Controls list + R07 evidence | Evidenced | STATIC |
| COMP-27 | Art. 33/34 breach notification is procedurally ready | Same as COMP-19 | Ready | STATIC |
| COMP-28 | Art. 35 DPIA is either done or a documented decision not to | Read | Present or recorded | **WRITE** |
| COMP-29 | Art. 44+ transfer mechanism (SCCs/adequacy) is addressed | Read | Present or flagged as a gap | STATIC |

### 6.5 Commercial contracts

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| COMP-30 | Liability cap is set deliberately, not by default | `TERMS.md` §9 | A reasoned figure (the audit calls it "deliberately conservative") | STATIC |
| COMP-31 | SLA or service commitment is stated or explicitly absent | Read | Explicit | STATIC |
| COMP-32 | Availability claims match measured uptime capability | Coordinate with R17/R18 | Consistent | STATIC |
| COMP-33 | Termination and data-return/erasure obligations are technically deliverable | Read vs export/erase | Deliverable | STATIC |
| COMP-34 | Data portability format is specified | Read | Specified (JSON per R08) | STATIC |
| COMP-35 | Warranty/disclaimer language is appropriate for a pre-GA product | Read | Consistent with actual readiness | STATIC |
| COMP-36 | The licence model is decided (`Q-002`) | Read `LICENSE` + `PRD.json` | **Open — must be closed before selling** | STATIC |
| COMP-37 | Third-party licence obligations are satisfied | Scan dependencies for copyleft | No incompatible licence (e.g. GPL) in a shipped path | **WRITE** |
| COMP-38 | The Privacy Policy and Terms are versioned and changes are auditable | `legal/README.md` + `DEC-032` | Versioned | STATIC |

### 6.6 Procurement evidence pack

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| COMP-39 | Assemble the security questionnaire answer set | Compile | `evidence/R21/questionnaire-pack.md` | **WRITE** |
| COMP-40 | Penetration test | Commission or schedule | **Absent** — a dated plan is the minimum | **WRITE** |
| COMP-41 | SSO/SAML | Assess | **Absent** — record as a known competitive gap | STATIC |
| COMP-42 | SOC 2 / ISO 27001 | Assess | **Absent** — record | STATIC |
| COMP-43 | Enforceable MFA policy | Assess | **Absent** — record (audit §4.1) | STATIC |
| COMP-44 | Audit-log export for a customer's auditor | `GET /audit-logs.csv` | Present | STATIC |
| COMP-45 | Sub-processor notification mechanism | Read DPA | Present contractually; **no mail transport to deliver notice** — record | STATIC |
| COMP-46 | Business continuity / disaster recovery statement | Coordinate with R18 | Present or written | **WRITE** |
| COMP-47 | Data-residency answer (`Q-003`) | Read | **Open** | STATIC |

### 6.7 Validation and gating

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| COMP-48 | `npm run test:legal` enforces placeholder, retention and sub-processor agreement checks | Read `validate-legal.mjs` | Confirm what it truly enforces | STATIC |
| COMP-49 | It fails on a retention drift | Seed | Fails | **RUNTIME** |
| COMP-50 | It fails on a placeholder, or deliberately allows them pre-launch | Seed | Record the design choice | **RUNTIME** |
| COMP-51 | Legal documents are served correctly and only the allow-listed slugs | `GET /legal/../../etc/passwd` | 404 | **RUNTIME** |
| COMP-52 | A revised pack re-prompts acceptance | `DEC-032` | Works | **RUNTIME** |

---

## 7. Known compliance risks to confirm or refute

| Risk | Statement | Severity |
|------|-----------|----------|
| **R-14 (MEDIUM)** | Legal placeholders + unreviewed pack block commercial use | MEDIUM |
| **R-02** | Password recovery is undeliverable — an access-to-service failure | HIGH |
| R-08 | 11 stories `done` with unverified criteria → misrepresentation risk in sales | MEDIUM |
| — | No pen test / no SSO / no attestation | MEDIUM (commercial) |
| — | `Q-002` licence undecided | Blocks sales |
| — | Filesystem document storage unencrypted (verify the wording) | MEDIUM |

---

## 8. Questions you must answer

1. **Can this product lawfully be sold tomorrow?** If not, list every blocker in order.
2. Which claims in the legal pack are not backed by a control?
3. Does any customer-facing document claim encryption at rest for document images?
4. Can each Uganda DPPA data-subject right be exercised end to end today?
5. What will a procurement reviewer ask for that does not exist?
6. Is the licence model resolved? If not, what does that block?

---

## 9. Commands to run

```bash
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund

# ---------- placeholders ----------
grep -rn "\[COMPANY NAME\]\|\[ADDRESS\]\|\[REGISTRATION NO\.\]\|\[EMAIL\]\|\[PHONE\]" legal/
grep -rn "\[[A-Z][A-Z ]\{2,\}\]" legal/ | sort -u
echo "counts:"; grep -ro "\[COMPANY NAME\]" legal/ | wc -l

# ---------- retention consistency ----------
grep -nE "retention|90 days|24 months|7 days|1 hour|30 days" legal/PRIVACY.md legal/DPA.md | head -30
grep -n "retentionDays\|EXPORTS_TTL\|PASSWORD_RESET_TTL\|REFRESH_TOKEN_TTL" apps/backend/src/config.ts
npm run test:legal

# ---------- encryption-at-rest wording ----------
grep -niE "encrypt" legal/*.md | head -20
grep -rn "createCipheriv\|encrypt" apps/backend/src/services/crypto.ts apps/backend/src/storage/index.ts

# ---------- what is actually served ----------
npm run dev:backend &
curl -s http://127.0.0.1:4000/api/v1/legal | jq
curl -s http://127.0.0.1:4000/api/v1/legal/privacy | head -20
curl -s -o /dev/null -w "%{http_code}\n" 'http://127.0.0.1:4000/api/v1/legal/..%2F..%2Fpackage.json'

# ---------- data-subject rights exercised ----------
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4000/api/v1/me/export -o /tmp/export.json && jq 'keys' /tmp/export.json
curl -s -X POST http://127.0.0.1:4000/api/v1/me/erase -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"password":"…","confirm":"DELETE"}'

# ---------- licence ----------
head -20 LICENSE ; node -e "const p=require('./PRD.json');console.log(p.openQuestions)"

# ---------- third-party licences ----------
npx --yes license-checker@25 --summary 2>/dev/null | head -40
npx --yes license-checker@25 --failOn GPL 2>/dev/null | head
```

---

## 10. Tests to perform

| # | Test | Procedure | Pass criterion |
|---|------|-----------|----------------|
| T-01 | Placeholder inventory | Grep + serve `GET /legal/privacy` | Complete list; a gate defined |
| T-02 | Claims-to-controls | Read every claim | Every claim evidenced or removed |
| T-03 | Retention consistency | `test:legal` + manual | Match |
| T-04 | DSAR end to end | Export + erase with a real account | Both complete (coordinate R08) |
| T-05 | Rights-to-endpoint map | All statutory rights | All mapped with tests |
| T-06 | Sub-processor reconciliation | List vs code | Match |
| T-07 | Legal route traversal | `..%2F` attempts | 404 |
| T-08 | Terms re-prompt | Bump the version | Re-prompt works |
| T-09 | Licence scan | `license-checker` | No incompatible licence in the shipped path |
| T-10 | Questionnaire dry run | Answer 30 standard questions from evidence | Every answer backed by an artefact |

---

## 11. Evidence required

```
docs/reviewers/evidence/R21/
├── placeholder-inventory.md     # COMP-01 … COMP-05
├── claims-to-controls.md        # COMP-06 … COMP-14 (the key deliverable)
├── dsar-rights-map.md           # COMP-18
├── breach-procedure.md          # COMP-19, COMP-27
├── ropa.md                      # record of processing activities
├── questionnaire-pack.md        # COMP-39 — a real, usable answer set
├── commercial-gaps.md           # COMP-40 … COMP-47 with dates and owners
├── licence-scan.txt             # COMP-37
├── validator-sensitivity.md     # T-05, T-06
├── commands.log
└── findings.md                  # COMP-### register
```

---

## 12. Passing conditions (co-signs G3)

- [ ] **P1** Zero placeholders in any document served to a customer, with a gate that enforces it (COMP-01 … COMP-05, T-01).
- [ ] **P2** Every claim in the legal pack maps to an implemented, tested control, or is removed (COMP-06 … COMP-14).
- [ ] **P3** "Encryption at rest" is stated exactly as implemented (COMP-08).
- [ ] **P4** Retention figures match code and the validator fails on drift (COMP-10, T-03).
- [ ] **P5** Every Uganda DPPA data-subject right is exercisable end to end with a test (COMP-18, T-04, T-05).
- [ ] **P6** A 72-hour breach procedure exists and is supported by real evidence (COMP-19, COMP-20, T-11).
- [ ] **P7** The sub-processor list matches reality (COMP-11, T-06).
- [ ] **P8** The licence model is decided and recorded (`Q-002`) (COMP-36).
- [ ] **P9** A usable security-questionnaire answer pack exists, and each answer cites an artefact (COMP-39, T-10).
- [ ] **P10** Remaining commercial gaps (pen test, SSO, SOC 2, enforceable MFA, residency) are listed with owners and dates (COMP-40 … COMP-47).
- [ ] **P11** An advocate has reviewed the pack, or the review is scheduled with a date and the pack is marked non-final (no commercial reliance).

**P1, P2 and P5 are G3-blocking. P8 blocks sales.**

---

## 13. Blocked items

| Item ID | Blocker | What unblocks it | Owner |
|---------|---------|------------------|-------|
| COMP-02, COMP-04 | Company registration details not supplied | Owner/procurement | Owner |
| COMP-19 | No legal opinion on notification duties | Ugandan advocate | Owner |
| COMP-40 | No pen-test vendor engaged | Budget approval | Owner |
| COMP-47 | `Q-003` unresolved | Owner decision | Owner |

---

## 14. Findings register

| ID | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
|----|----------|-----------|---------|----------------|-----------|---------------|-------|
| COMP-001 | | | | | | | |

---

## 15. Reviewer sign-off

| Field | Value |
|-------|-------|
| Reviewer name | |
| Date started | |
| Date completed | |
| **G3 co-sign result** | ☐ Pass ☐ Fail ☐ Abstain |
| Co-sign G3 / G10 | ☐ ☐ |
| Placeholders remaining | |
| Advocate review | ☐ Done ☐ Scheduled ☐ Not started |
| Conditions failed (IDs) | |
| Reviewed commit | `43d384b` |
| Statement | *I read every legal document and mapped each claim to a control in the code, executing the DSAR, retention and legal-route tests rather than reading about them. Where a claim could not be evidenced, I removed it from the pack or recorded it as a blocker.* |
| Signature | |
