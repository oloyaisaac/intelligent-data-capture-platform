# REVIEWER 08 — PRIVACY ENGINEER / DATA PROTECTION OFFICER

| Field | Value |
|-------|-------|
| **Reviewer ID** | R08 |
| **Title** | Privacy Engineer / Data Protection Officer (technical) |
| **Board** | B — Identity, security & privacy |
| **Wave** | 2 (weeks 3–5) |
| **Effort** | 8 person-days |
| **Gate chaired** | none |
| **Co-signs** | G3 |
| **Evidence to** | G1, G10 (contributes findings, not an approver) |
| **Finding prefix** | `PRIV-###` |
| **Upstream** | R03 (table inventory), R02 (route matrix) |
| **Downstream** | R21 (legal), R03 (erase residue test), R18 (maintenance observability) |
| **Status** | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Determine whether the product can honestly satisfy data-subject rights and its own retention promises:
can a person get **all** their data out, have it **completely** erased, and can the organisation be
confident that nothing is retained beyond the stated period — with evidence, not intent.

**Specific to this repository.** The privacy features were added in a hardening pass (`DEC-030`,
`DEC-031`, `DEC-032`, plus `/me/export` and `/me/erase`). `AUDIT-2026-10.md` claims they work. Your job is to
verify **completeness**, which is the classic failure mode of DSAR implementations: the user row is
anonymised but the extractions, the audit log, the device records, the batch items and the files on disk
still hold the personal data.

**Regulatory frame.** The product targets Uganda (Data Protection and Privacy Act 2019) and is
GDPR-shaped for EU customers (`legal/DPA.md`). Both require: lawful basis, access, rectification,
erasure, portability, retention limits, breach notification, and a record of processing.

---

## 2. Required expertise

- GDPR / Uganda DPPA 2019 data-subject rights and their technical implementation
- DSAR export completeness and format
- Erasure semantics including lawful-retention carve-outs
- Retention schedule design and enforcement verification
- PII discovery across a relational schema and object storage
- Log and telemetry PII minimisation
- DPIA / records-of-processing authoring with engineers

---

## 3. Repository context (self-contained)

**Product.** IDCP ingests photographs of business documents — frequently **IDs, contracts and invoices
containing personal data** — extracts structured text, stores both the image and the extraction, has a human
review it, and pushes records to third-party systems. Multi-tenant: each organisation is a controller (or
processor for its own customers), IDCP is the processor.

**Privacy-relevant implementation:**

| Element | Path | Size |
|---------|------|------|
| DSAR export + erasure | `apps/backend/src/services/privacy-service.ts` | 240 |
| Privacy routes | `apps/backend/src/http/routes/privacy-routes.ts` | 45 (`GET /me/export`, `POST /me/erase`) |
| Retention, expired exports, session sweep | `apps/backend/src/services/maintenance-service.ts` | 195 |
| Retention configuration | `apps/backend/src/config.ts` (`retention_days`, `EXPORTS_TTL_SECONDS`, `PASSWORD_RESET_TTL_SECONDS`) | 141 |
| Legal pack publishing | `apps/backend/src/http/routes/legal-routes.ts` | 66 |
| Log redaction | `apps/backend/src/logger.ts` | 74 |
| IP hashing | `packages/shared/src/ids.ts` | 73 |
| Schema (32 tables — which hold PII) | `apps/backend/src/db/migrations.ts` | 528 |
| Legal documents | `legal/{PRIVACY,DPA,SUBPROCESSORS,SECURITY,TERMS}.md` | 496 total |
| Legal contract validator | `scripts/validate-legal.mjs` | — |
| AI cloud opt-in | `config.ts` `AI_PROVIDER`, `organisations.ai_provider`, `learning_opt_in` | — |

**Documented retention figures (verify against code):**

| Data | Stated retention | Source |
|------|------------------|--------|
| Documents | 90 days (default, per-organisation configurable) | `PRIVACY.md`, `retention_days` |
| Audit entries | 24 months | `PRIVACY.md` |
| Exports | 7 days | `EXPORTS_TTL_SECONDS` |
| Password resets | 1 hour | `PASSWORD_RESET_TTL_SECONDS` |
| Sessions | 30 days (refresh TTL) | `REFRESH_TOKEN_TTL_SECONDS` |

---

## 4. Exact files and components to examine

### 4.1 Must read in full

| # | File | What you are looking for |
|---|------|--------------------------|
| 1 | `apps/backend/src/services/privacy-service.ts` (240) | **Every table and field the export includes and the erase touches** |
| 2 | `apps/backend/src/http/routes/privacy-routes.ts` (45) | Confirmation requirements (`password` + `confirm: "DELETE"`), role checks |
| 3 | `apps/backend/src/services/maintenance-service.ts` (195) | What the sweep deletes, in what order, and what it logs |
| 4 | `apps/backend/src/config.ts` (141) | Retention defaults and bounds |
| 5 | `apps/backend/src/db/migrations.ts` (528) | **All 32 tables** — build the PII inventory from the schema, not from the code's claims |
| 6 | `apps/backend/src/logger.ts` (74) | `redact()` key list vs what is actually logged |
| 7 | `packages/shared/src/ids.ts` (73) | `hashIp` — salted or bare |
| 8 | `apps/backend/src/http/routes/legal-routes.ts` (66) | Publishes the policy the product must honour |
| 9 | `apps/backend/test/privacy.test.ts` (202) | What is actually asserted |
| 10 | `apps/backend/test/maintenance.test.ts` (143) | What the sweep test proves |
| 11 | `apps/backend/test/terms.test.ts` (114) | Terms acceptance evidence (`DEC-032`) |

### 4.2 Legal pack — read every word, then check it against code

`legal/PRIVACY.md` · `legal/DPA.md` · `legal/SUBPROCESSORS.md` · `legal/SECURITY.md` · `legal/TERMS.md` ·
`legal/README.md`

For **each claim** in these documents, record: claim · where the code implements it · evidence · gap.

### 4.3 Services that write personal data

`auth-service.ts` (903) · `document-service.ts` (300) · `review-service.ts` (397) · `pairing-service.ts` (198) ·
`organisation-service.ts` (349) · `export-service.ts` (228) · `batch-service.ts` (223) ·
`connector-service.ts` (566) · `worker.ts` (282) · `ai/providers/cloud.ts` (124)

### 4.4 Explicit non-goals

Contract law, liability caps, company details, negotiation → R21 · credential strength → R05 ·
cross-tenant isolation → R06 · erasure **residue SQL verification** is co-owned with R03 (you define what
counts as PII; R03 runs the queries).

---

## 5. Upstream artefacts required

| From | Artefact | Why |
|------|----------|-----|
| R03 | `evidence/R03/schema.md` | The 32-table inventory you build the PII map on |
| R02 | `evidence/R02/route-matrix.csv` | Which privacy routes are guarded and how |

---

## 6. Checklist

### 6.1 PII inventory (primary deliverable)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| PRIV-01 | Build a **PII inventory** across all 32 tables | Read `migrations.ts`; for each column decide: personal data? sensitive? | `evidence/R08/pii-inventory.md` with table.column → category → basis → retention → deletion mechanism | **WRITE** |
| PRIV-02 | Classify special-category data | ID documents, signatures, health/financial content in extracted text | Flagged explicitly — ID images are special-category in many jurisdictions | STATIC |
| PRIV-03 | Identify PII in object storage | Document images, page images, exports | Every stored object classified | STATIC |
| PRIV-04 | Identify PII in logs | `logger.ts` + every logging call site | Enumerate; emails, IPs, names, document text | STATIC |
| PRIV-05 | Identify PII in the audit log | `audit_logs` `metadata` JSON | Documented; this is the hardest to erase lawfully | STATIC |
| PRIV-06 | Identify PII transmitted to sub-processors | Cloud AI provider payloads; connectors | Exactly what leaves the system, to whom | STATIC |
| PRIV-07 | Map each column to a lawful basis | Against `legal/PRIVACY.md` | No column without a basis | STATIC |

### 6.2 Data-subject access (`GET /me/export`)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| PRIV-08 | Export includes profile, memberships, sessions, devices | Read the service | All present | STATIC |
| PRIV-09 | Export includes **documents and extractions** (or an explanation of why not) | Read the service | Present or a documented boundary | STATIC |
| PRIV-10 | Export includes **corrections** the user made | Read the service | Present | STATIC |
| PRIV-11 | Export includes the **audit trail** attributable to the user | Read the service | Present or documented | STATIC |
| PRIV-12 | Export is machine-readable and portable | Format check | JSON with stable schema | STATIC |
| PRIV-13 | Export cannot include another user's data | Read the scoping | Org-scoped but user-filtered — **verify it does not dump the whole organisation to a viewer** | STATIC |
| PRIV-14 | Export is audited | Audit entry on download | Present | STATIC |
| PRIV-15 | Export is rate-limited / bounded | Check limiter + row caps | Bounded | STATIC |
| PRIV-16 | Execute a full export and diff against the inventory | T-01 | Every catalogue item either present or justified | **RUNTIME** |

### 6.3 Erasure (`POST /me/erase`)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| PRIV-17 | Erasure requires password **and** `confirm: "DELETE"` | Route + service | Both enforced server-side | STATIC |
| PRIV-18 | Erasure anonymises the user row consistently | `auth-repo.ts` `deleted-${id}@erased.invalid` | No recoverable identity | STATIC |
| PRIV-19 | Erasure removes **files on disk**, not only rows | Read the service; check storage deletes | Confirmed | STATIC |
| PRIV-20 | Erasure covers every table in the inventory | T-02 residue scan across all 32 tables | Zero residue, or documented lawful exception | **RUNTIME** |
| PRIV-21 | Lawful-retention carve-outs are explicit | Audit log retention, legal-hold, statutory duty | Written, defensible, disclosed in `PRIVACY.md` | STATIC |
| PRIV-22 | Erasure is irreversible | Re-sign-in attempt after erase | Impossible | **RUNTIME** |
| PRIV-23 | Erasure is refused when the user is one of several owners | Read the logic | Clear, actionable message | STATIC |
| PRIV-24 | Erasure is audited | Audit entry | Present | STATIC |
| PRIV-25 | Erasure of a user does not orphan or corrupt other tenants | T-03 post-erase org integrity check | No broken references visible to others | **RUNTIME** |
| PRIV-26 | An admin can erase a departing reviewer (with the right authority) | Check role gates | Enforced by role, not by self-only | STATIC |

### 6.4 Retention enforcement

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| PRIV-27 | Retention is per-organisation and configurable | `retention_days` | Confirmed, bounded | STATIC |
| PRIV-28 | The sweep actually runs unattended | `MAINTENANCE_ENABLED` default true; interval 24 h | Confirmed | STATIC |
| PRIV-29 | Purge deletes rows **and** storage objects | T-04: purge then count rows vs files | Equal | **RUNTIME** |
| PRIV-30 | Purge respects soft-deleted vs retained documents | Read `findExpiredForPurge` | Correct semantics | STATIC |
| PRIV-31 | Expired exports are deleted | `maintenance-service.ts` + `EXPORTS_TTL_SECONDS` | Confirmed | STATIC |
| PRIV-32 | Dead sessions are deleted | `sessions.expires_at < now` sweep | Confirmed | STATIC |
| PRIV-33 | Used/expired password resets are deleted | Sweep present | Confirmed | STATIC |
| PRIV-34 | **A failed sweep is invisible** | `maintenance-service.ts` logs a `warn` only | Record as a control gap; require a metric/alert (coordinate R18) | STATIC |
| PRIV-35 | The purge report is a **count**, not a list | Read the logging | Record: an admin cannot see *what* was deleted | STATIC |
| PRIV-36 | Retention figures in `PRIVACY.md` match `config.ts` | Cross-check; run `npm run test:legal` | Match; validator is meaningful | **RUNTIME** |
| PRIV-37 | Changing the default breaks `test:legal` | Temporarily change a default, run the validator, revert | Fails | **RUNTIME** |
| PRIV-38 | Audit-log retention is honoured | 24 months stated; is there any purge? | If never purged, the stated figure is false — record | STATIC |

### 6.5 Sub-processors and third-party transfers

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| PRIV-39 | Cloud AI is opt-in per organisation and recorded | `AI_PROVIDER`, `organisations.ai_provider`, `learning_opt_in` | Confirmed | STATIC |
| PRIV-40 | The sub-processor list matches reality | `legal/SUBPROCESSORS.md` vs connectors + AI providers + hosting | Every actual recipient listed; nothing phantom | STATIC |
| PRIV-41 | What exactly is sent to a cloud provider | `ai/providers/cloud.ts` | Document payloads documented | STATIC |
| PRIV-42 | A cross-border transfer statement exists | `legal/PRIVACY.md` / `DPA.md` | Present | STATIC |
| PRIV-43 | Training-data use is consented and separable | `REV-002` "opt-in training export" | Confirmed opt-in, default off | STATIC |
| PRIV-44 | Connector writes are disclosed as onward transfers | `legal/SUBPROCESSORS.md` | Disclosed | STATIC |

### 6.6 Logging, telemetry and IP handling

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| PRIV-45 | No password, token, secret or TOTP in logs | Scan logging call sites | Clean | STATIC |
| PRIV-46 | No document text or image content in logs | Scan | Clean | STATIC |
| PRIV-47 | `redact()` key list is complete | Read `logger.ts`; compare with actual log keys across services | Complete, or findings | STATIC |
| PRIV-48 | IP handling is minimised | `hashIp` in `ids.ts` | Hashed; determine whether **salted** | STATIC |
| PRIV-49 | A bare SHA-256 of an IP is reversible over the IPv4 space | Reason + demonstrate on a sample | If unsalted, record as a privacy finding with severity | **RUNTIME** |
| PRIV-50 | Audit log stores `ip_hash`, not raw IP | `audit_logs.ip_hash` | Confirmed | STATIC |
| PRIV-51 | Access log omits query strings (which can carry the SSE token) | `app.ts` `onResponse` | Confirmed for the app; flag the proxy for R19 | STATIC |

### 6.7 Consent, terms and notices

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| PRIV-52 | Terms acceptance is recorded with version and timestamp | `terms_accepted_at`, `terms_version` (`DEC-032`) | Confirmed | STATIC |
| PRIV-53 | A revised pack re-prompts | Read the version check | Confirmed | STATIC |
| PRIV-54 | Acceptance cannot be bypassed at the API boundary | Try registering without accepting | Rejected | **RUNTIME** |
| PRIV-55 | The privacy notice is reachable without authentication | `GET /legal/privacy` public | Confirmed | STATIC |
| PRIV-56 | The notice is versioned and changes are auditable | Read `legal/README.md` + validator | Present or recorded | STATIC |

### 6.8 Breach readiness and governance

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| PRIV-57 | A 72-hour breach procedure is written | Search `SECURITY.md`/`legal/` | Present or recorded missing | STATIC |
| PRIV-58 | The evidence needed to investigate a breach exists | Access log, audit log, request ids | Confirmed | STATIC |
| PRIV-59 | A record of processing activities can be produced | The inventory from PRIV-01 is a starting point | Present | STATIC |
| PRIV-60 | A DPO/contact is named | `legal/PRIVACY.md` | **Likely a placeholder — record** | STATIC |
| PRIV-61 | Controller registration duties are acknowledged | Uganda DPPA registration | Recorded for R21 | STATIC |
| PRIV-62 | Data minimisation is defensible | Why is each field collected? | Each justified or flagged | STATIC |

---

## 7. Known privacy risks to confirm or refute

| Risk | Statement |
|------|-----------|
| **R-02** | A user who forgets a password cannot recover it — an access-to-account failure with privacy consequences |
| R-09 | No backup/restore: erasure might silently reappear from a restored backup |
| R-11 | A failed retention sweep is invisible — retention may silently stop |
| R-14 | Legal placeholders and an unreviewed pack |
| R-24 | `hashIp` may be an unsalted SHA-256 (reversible over IPv4) |

---

## 8. Questions you must answer

1. **If I exercise my right of access today, what do I actually receive, and what is missing?**
2. After erasure, which tables and which files can still be linked to me?
3. Is the stated 90-day document retention actually enforced, and would anyone notice if it stopped?
4. Is a stored IP hash reversible? Demonstrate.
5. Exactly what personal data leaves this system to a third party, under which switch, with whose consent?
6. Could a restore from backup resurrect erased data — and is that documented?
7. Which claims in `legal/PRIVACY.md` are not implemented in code?

---

## 9. Commands to run

```bash
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund
npm run db:migrate && npm run db:seed
npm run dev:backend &

# --- schema → PII inventory scaffold ---
sqlite3 ./local-storage/idcp.db "SELECT m.name, p.name, p.type FROM sqlite_master m
  JOIN pragma_table_info(m.name) p WHERE m.type='table' ORDER BY m.name;"

# --- retention config vs legal claims ---
grep -n "retention\|EXPORTS_TTL\|PASSWORD_RESET_TTL\|REFRESH_TOKEN_TTL" apps/backend/src/config.ts
grep -nE "90 days|24 months|7 days|1 hour|retention" legal/PRIVACY.md | head -30
npm run test:legal

# --- prove the legal validator is meaningful ---
#  (a) change a retention default in config.ts, run test:legal, observe failure, revert
#  (b) introduce a "[COMPANY NAME]" placeholder check, run test:legal

# --- export completeness ---
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4000/api/v1/me/export > /tmp/export.json
jq 'keys' /tmp/export.json
jq '.' /tmp/export.json | head -60

# --- erase, then residue scan (full example) ---
curl -s -X POST http://127.0.0.1:4000/api/v1/me/erase -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"password":"…","confirm":"DELETE"}'
for t in $(sqlite3 ./local-storage/idcp.db "SELECT name FROM sqlite_master WHERE type='table'"); do
  n=$(sqlite3 ./local-storage/idcp.db "SELECT COUNT(*) FROM $t" 2>/dev/null)
  echo "$t=$n"
done
find ./local-storage/documents -type f | wc -l
find ./local-storage -type f -name '*.xlsx' -o -name '*.csv' | wc -l

# --- IP hash reversibility (PRIV-49) ---
node -e "const {hashIp}=require('./packages/shared/dist/ids.js');" 2>/dev/null || \
node --experimental-strip-types -e "
  const c=require('node:crypto');
  const h=(ip)=>c.createHash('sha256').update(ip).digest('hex');
  console.log('sha256(1.2.3.4) =', h('1.2.3.4'));
"
# compare with the actual value stored in audit_logs.ip_hash for a known request

# --- logging PII scan ---
grep -rn "logger\.\(info\|warn\|error\|debug\)" apps/backend/src/services | wc -l
grep -rn "email\|displayName\|filename\|text" apps/backend/src/services | grep logger

# --- maintenance observability ---
grep -n "warn\|error\|log" apps/backend/src/services/maintenance-service.ts
```

---

## 10. Tests to perform

| # | Test | Procedure | Pass criterion |
|---|------|-----------|----------------|
| T-01 | Full DSAR export | Create a user with documents, corrections, devices, sessions; export; diff against the inventory | Every catalogue item present or justified |
| T-02 | Erasure residue | Erase; scan all 32 tables + disk + exports | Zero residue, or lawful documented exception |
| T-03 | Post-erase integrity | Other users' views still correct | No orphan/visible corruption |
| T-04 | Retention enforcement | Backdate documents past `retention_days`; run the sweep | Rows and files both deleted, counts equal |
| T-05 | Sweep failure visibility | Make the sweep throw | Confirm nothing alerts (record) |
| T-06 | `test:legal` sensitivity | Change a retention default | Validator fails |
| T-07 | IP hash reversibility | Compute the hash of a known IP; compare with the stored value | Reversibility demonstrated or refuted |
| T-08 | Log PII scan | Grep every log line emitted during a full journey | No PII |
| T-09 | Terms enforcement | Register without accepting | API rejects |
| T-10 | Cloud-AI consent | Org with cloud disabled | No external call |

---

## 11. Evidence required

```
docs/reviewers/evidence/R08/
├── pii-inventory.md             # 32 tables × columns → category, basis, retention, deletion
├── dsar-export-diff.md          # T-01 completeness result
├── erase-residue-report.md      # T-02 per-table + disk
├── retention-audit.md           # stated vs enforced, per data class
├── legal-claims-matrix.md       # every claim in legal/*.md → implemented? evidence
├── subprocessor-map.md          # what leaves the system, to whom, under which switch
├── ip-hash-analysis.md          # T-07
├── log-pii-scan.md              # T-08
├── commands.log
└── findings.md                  # PRIV-### register
```

---

## 12. Passing conditions (co-signs G3)

- [ ] **P1** The PII inventory covers all 32 tables and all object storage (PRIV-01 … PRIV-07).
- [ ] **P2** The DSAR export is complete or its omissions are documented and lawful (PRIV-08 … PRIV-16, T-01).
- [ ] **P3** Erasure leaves zero residue, or the residue is explicit, lawful and disclosed (PRIV-17 … PRIV-25, T-02).
- [ ] **P4** Retention is enforced **and observable** (PRIV-27 … PRIV-38, T-04, T-05).
- [ ] **P5** Stated retention figures match code and the validator fails on drift (PRIV-36, PRIV-37, T-06).
- [ ] **P6** No PII or credential in logs; IP hashing is defensible (PRIV-45 … PRIV-51, T-07, T-08).
- [ ] **P7** Sub-processor list matches reality; cloud AI is opt-in and disclosed (PRIV-39 … PRIV-44).
- [ ] **P8** Terms acceptance is recorded and cannot be bypassed (PRIV-52 … PRIV-54).
- [ ] **P9** A breach procedure exists and the audit evidence to support it is available (PRIV-57 … PRIV-59).
- [ ] **P10** Every claim in `legal/PRIVACY.md` is backed by implemented code or is removed (PRIV matrix).

---

## 13. Blocked items

| Item ID | Blocker | What unblocks it | Owner |
|---------|---------|------------------|-------|
| PRIV-60 | DPO/company identity are placeholders | Owner decision | R21 |
| PRIV-42 | Cross-border transfer statement may need legal input | Ugandan advocate | R21 |

---

## 14. Findings register

| ID | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
|----|----------|-----------|---------|----------------|-----------|---------------|-------|
| PRIV-001 | | | | | | | |

---

## 15. Reviewer sign-off

| Field | Value |
|-------|-------|
| Reviewer name | |
| Date started | |
| Date completed | |
| **G3 co-sign result** | ☐ Pass ☐ Fail ☐ Abstain |
| DSAR verdict | ☐ Complete ☐ Partial — gaps listed |
| Erasure verdict | ☐ Complete ☐ Residue found |
| Conditions failed (IDs) | |
| Reviewed commit | `43d384b` |
| Statement | *I built a PII inventory from the schema rather than from the code's claims, executed a full export and erasure, and reconciled every retention figure against `config.ts`.* |
| Signature | |
