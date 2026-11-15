# REVIEWER NAME: Privacy Engineer / Data Protection Officer (R08)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R08-privacy-dpo.md` (62 checklist items)
**STATUS:** ☑ Complete

---

## AREAS EXAMINED

Data-subject access (export) · erasure · retention · audit trail · sub-processors · legal claims vs implementation · PII inventory · cloud AI data flow.

---

## 1. Summary of examination

I read `privacy-service.ts` in full, traced erasure and export end to end, compared the retention figures in `legal/PRIVACY.md` to `config.ts`, and mapped what the cloud AI provider would transmit if enabled.

**Verdict: the privacy plumbing exists and is thoughtful about ordering, but two gaps are material.** The subject-access export **explicitly omits document images and extracted field values** — the product's core personal data. And erasure **silently tolerates failure** to delete blobs while reporting success. Both are honest in the code comments, and both would fail a real DPPA/GDPR audit.

---

## 2. Files and components inspected

| File                                               | Checked                   |
| -------------------------------------------------- | ------------------------- |
| `apps/backend/src/services/privacy-service.ts`     | full read — export, erase |
| `apps/backend/src/services/maintenance-service.ts` | retention sweep           |
| `apps/backend/src/config.ts`                       | retention defaults        |
| `legal/{PRIVACY,DPA,SUBPROCESSORS,SECURITY}.md`    | claims                    |
| `apps/backend/src/ai/providers/cloud.ts`           | data egress               |
| `apps/backend/src/http/routes/privacy-routes.ts`   | 2 routes                  |

---

## 3. Features examined

DSAR export · account erasure · retention purge · audit log · sub-processor disclosure · consent/terms · cloud AI opt-in.

---

## 4. Tests performed

| #   | Test                          | Result                                                     |
| --- | ----------------------------- | ---------------------------------------------------------- |
| T1  | `npx jest privacy`            | **PASS**                                                   |
| T2  | Export contents               | **PARTIAL** — see PRIV-001                                 |
| T3  | Cross-tenant export isolation | **PASS** — "never includes another organisation documents" |
| T4  | Erasure completeness          | **FAIL** — see PRIV-002                                    |
| T5  | Retention figures vs config   | **PASS** — consistent                                      |
| T6  | `npm run test:legal`          | **PASS**                                                   |
| T7  | Sub-processor list vs code    | **PASS** (with R21)                                        |
| T8  | Cloud AI egress               | **PASS** — opt-in, explicit config required                |
| T9  | Audit log completeness        | **PARTIAL** — see PRIV-003                                 |

---

## 5. Successful findings

1. **Erasure ordering is deliberate and correct.** `privacy-service.ts:218` comments: _"Files go after the rows: a failure here leaves an orphan blob, never a dangling record."_ The author reasoned about which inconsistency is safer, and chose rightly.
2. **Erasure requires password re-entry plus a literal `"DELETE"` confirmation** — appropriate friction for an irreversible action.
3. **The sole-owner guard is present**: _"You are one of several owners. Make another person the owner first."_ — this prevents orphaning an organisation, a real consideration.
4. **Export is tenant-isolated** with a dedicated negative test.
5. **Cloud AI is opt-in and refuses to start without a spend cap** (`AI_MAX_COST_MICROS_PER_DOC`), citing `PRD.json Q-001`. Refusing to enable a data-egress feature without an explicit cost control is good governance.
6. **Retention figures in `legal/PRIVACY.md` match `config.ts`**, and `test:legal` enforces it.

---

## 6. Identified problems

### PRIV-001 — The subject-access export omits document images and extracted field values

| Field            | Value                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **HIGH**                                                                                                                                                                                                                                                                                                               |
| **Affected**     | `apps/backend/src/services/privacy-service.ts:121`                                                                                                                                                                                                                                                                     |
| **Evidence**     | The service returns a note: _"Document images and extracted field values are not included: download them from the document list, or ask an administrator for an organisation-level export."_ Metadata rows are exported; the document content and the UDM field values — the actual personal data processed — are not. |
| **Expected**     | A DSAR returns the personal data the controller holds about the subject                                                                                                                                                                                                                                                |
| **Actual**       | It returns metadata and a pointer to a manual process                                                                                                                                                                                                                                                                  |
| **Verification** | Read line 121; call `GET /me/export` on a seeded account and inspect the payload                                                                                                                                                                                                                                       |

**Why HIGH:** under the Uganda DPPA 2019 and GDPR Art. 15, the subject is entitled to a copy of their personal data, not an index of it. A photographed invoice containing their name and address **is** their personal data. Manual fulfilment may be defensible at low volume but is not automated compliance, and it is not stated in the Terms.

**Recommended correction:** Include signed, time-limited download URLs (or a zip) for the subject's documents and the UDM field values. If deliberate, state the manual process in `legal/PRIVACY.md` and add a service-level commitment.

**Verification requirements:** An export containing a document's field values, byte-identical to what the review screen shows.

---

### PRIV-002 — Erasure reports success while blobs may remain

| Field            | Value                                                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **HIGH**                                                                                                                                                                                      |
| **Affected**     | `apps/backend/src/services/privacy-service.ts:220-225`                                                                                                                                        |
| **Evidence**     | `await this.storage.delete(document.storage_key).catch((error) => { this.logger.warn('could not delete a draft document during erasure', ...) })`. The response still returns `erased: true`. |
| **Expected**     | Erasure either succeeds or reports the residue                                                                                                                                                |
| **Actual**       | A failed file delete produces a `warn` log and a success response                                                                                                                             |
| **Verification** | Read lines 218-228; simulate a storage failure and observe `erased: true`                                                                                                                     |

**Why HIGH:** an erasure request that returns success while retaining the photographed document is a false statement to a data subject and a regulator. The current behaviour is defensible only if residue is tracked and retried — and no reconciliation exists (see DB-002).

**Recommended correction:** Record failures in a `pending_deletions` table, retry on the maintenance sweep, and either (a) block the `erased: true` response until files are gone, or (b) return `erased: "partial"` with a follow-up commitment. Option (b) with a working retry is pragmatic and honest.

**Verification requirements:** A test that injects a storage failure and asserts the residue is recorded and later removed.

---

### PRIV-003 — Audit log does not record every privacy-relevant event

| Field            | Value                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **MEDIUM**                                                                                                                                                            |
| **Affected**     | `audit_logs` writers across services                                                                                                                                  |
| **Evidence**     | `privacy.account_erased` and `password_reset_requested` are recorded. Reads of sensitive data (document download, export generation) are **not** consistently logged. |
| **Expected**     | Access to personal data is logged for accountability (DPPA principle 8 / GDPR Art. 5(2))                                                                              |
| **Actual**       | Mutations logged well; reads not                                                                                                                                      |
| **Verification** | Grep `audit.record` call sites and compare to read endpoints                                                                                                          |

**Recommended correction:** Log document access and export generation. Read logging is cheap and is exactly what an auditor asks for.

---

### PRIV-004 — No configuration for automated data-subject request handling

| Field            | Value                                                                                                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **MEDIUM**                                                                                                                                                                                                                              |
| **Affected**     | Product scope                                                                                                                                                                                                                           |
| **Evidence**     | Requests are fulfilled by API calls (`/me/export`, `/me/erase`) that the subject must make through the app while signed in. There is no intake channel for a subject who has lost access — which is precisely when many requests occur. |
| **Expected**     | A route for a subject who cannot sign in                                                                                                                                                                                                |
| **Actual**       | None; `DEC-030`-style operator intervention required                                                                                                                                                                                    |
| **Verification** | Enumerate privacy routes: 2, both authenticated                                                                                                                                                                                         |

**Recommended correction:** A public intake endpoint (rate-limited, verified by email) — which also requires the mail transport missing per AUTH-002.

---

### PRIV-005 — Legal placeholders remain in documents served to customers

| Field            | Value                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **MEDIUM**                                                                                                      |
| **Affected**     | `legal/*.md`                                                                                                    |
| **Evidence**     | 5 `[COMPANY NAME]` / `[ADDRESS]` / `[REGISTRATION NO.]` placeholders; `GET /legal/{slug}` serves them verbatim. |
| **Expected**     | A customer cannot read a placeholder                                                                            |
| **Actual**       | They can, today                                                                                                 |
| **Verification** | `grep -rn "\[COMPANY NAME\]" legal/`                                                                            |

**Recommended correction:** Fill or gate. Cross-ref COMP-001 in R21.

---

## 7. Missing functionality

| Item                                       | Status                         |
| ------------------------------------------ | ------------------------------ |
| Document content in DSAR export            | **Not implemented** (PRIV-001) |
| Erasure residue tracking                   | **Not implemented** (PRIV-002) |
| Read-access audit logging                  | **Partial** (PRIV-003)         |
| Unauthenticated DSAR intake                | **Not implemented** (PRIV-004) |
| Automated retention residue reconciliation | **Not implemented**            |

---

## 8. Security concerns

Cloud AI transmits `data:image/...;base64` payloads to an external endpoint when enabled — correct and documented, gated on explicit opt-in and a spend cap. This is a **sub-processor** and must appear in `legal/SUBPROCESSORS.md` whenever enabled.

---

## 9. Performance concerns

Export builds the full payload in memory; acceptable at current volumes, noted for R17.

---

## 10. Recommendations

1. Include document content in the export (PRIV-001) — the most defensible finding in this domain.
2. Track and retry erasure residue (PRIV-002); until then do not return `erased: true` unconditionally.
3. Log reads of personal data (PRIV-003).
4. Add an unauthenticated intake channel once mail exists (PRIV-004).
5. Fill legal placeholders (PRIV-005).

---

## EVIDENCE CLASSIFICATION

| Class                        | Items                                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **A. Verified working**      | Erasure ordering, password+confirm friction, sole-owner guard, tenant-isolated export, retention consistency, opt-in cloud AI |
| **B. Verified failing**      | PRIV-001, PRIV-002                                                                                                            |
| **C. Not implemented**       | Content export, residue tracking, unauthenticated intake                                                                      |
| **D. Partially implemented** | Audit logging (mutations yes, reads no); export (metadata yes, content no)                                                    |
| **E. Unable to verify**      | Real DSAR response time at volume; regulator acceptance                                                                       |

---

## ISSUE SUMMARY

| ID       | Severity | Title                                               |
| -------- | -------- | --------------------------------------------------- |
| PRIV-001 | **HIGH** | DSAR export omits document content and field values |
| PRIV-002 | **HIGH** | Erasure reports success while blobs may remain      |
| PRIV-003 | MEDIUM   | Personal-data reads not audited                     |
| PRIV-004 | MEDIUM   | No intake channel for locked-out subjects           |
| PRIV-005 | MEDIUM   | Legal placeholders served to customers              |

**Totals: 0 CRITICAL · 2 HIGH · 3 MEDIUM · 0 LOW**
