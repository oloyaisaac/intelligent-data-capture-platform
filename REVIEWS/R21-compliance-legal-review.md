# REVIEWER NAME: Compliance & Legal-Technical Reviewer (R21)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R21-compliance-legal.md` (52 checklist items)
**STATUS:** ☑ Complete — **advocate review not obtained** (no external counsel)

---

## AREAS EXAMINED

Legal pack (6 documents) · placeholders · claims-to-controls · DSAR · retention · sub-processors · licence · procurement gaps.

---

## 1. Summary of examination

I read all six legal documents, grepped for placeholders, executed `test:legal`, and mapped every security and privacy claim to an implemented control.

**Verdict: the legal pack is unusually well drafted for a pre-launch product and it cannot be used commercially today.** Thirteen placeholders, no advocate review, no penetration test, no licence decision, and — the structural point — **the validator enforces the pre-launch state rather than gating it.**

---

## 2. Files and components inspected

| File                         | Checked                                |
| ---------------------------- | -------------------------------------- |
| `legal/PRIVACY.md`           | controller identity, retention, rights |
| `legal/TERMS.md`             | liability, warranty, termination       |
| `legal/DPA.md`               | Art. 28 obligations                    |
| `legal/SUBPROCESSORS.md`     | completeness                           |
| `legal/SECURITY.md`          | claims                                 |
| `legal/README.md`            | placeholder register                   |
| `LICENSE`                    | licence model                          |
| `scripts/validate-legal.mjs` | sensitivity                            |

---

## 3. Features examined

Placeholders · retention consistency · DSAR rights · sub-processor disclosure · encryption claims · liability · licence.

---

## 4. Tests performed

| #   | Test                             | Result                                               |
| --- | -------------------------------- | ---------------------------------------------------- |
| T1  | Placeholder enumeration          | **13 occurrences** across 4 documents                |
| T2  | `npm run test:legal`             | **PASS** — "placeholders intact"                     |
| T3  | Validator fails on placeholder   | **NO — it requires them**                            |
| T4  | Retention figures vs `config.ts` | **PASS** — consistent                                |
| T5  | DSAR end to end                  | **PARTIAL** — export omits content (PRIV-001)        |
| T6  | Encryption-at-rest claim         | **PASS** — scoped to credentials, not document files |
| T7  | Sub-processor list               | **PASS** — matches enabled features                  |
| T8  | Licence decided                  | **NO — `Q-002` open**                                |
| T9  | Advocate review                  | **NOT OBTAINED**                                     |
| T10 | Penetration test                 | **NOT OBTAINED**                                     |

---

## 5. Successful findings

1. **Retention figures in `legal/PRIVACY.md` match `config.ts` exactly**, and `test:legal` enforces the consistency.
2. **The encryption claim is correctly scoped.** The pack does not claim document images are encrypted at rest by the application; it describes connector credentials. That is honest — many products overclaim here.
3. **`legal/README.md` maintains an explicit placeholder register** naming each token and its purpose, which is exactly how this should be managed.
4. **The DPA covers Art. 28 processor obligations** in recognisable form.
5. **Terms liability is deliberately conservative** rather than defaulted.
6. **The pack self-declares that it "needs review by a Ugandan advocate"**, which is the correct posture.

---

## 6. Identified problems

### COMP-001 — Thirteen placeholders in documents served to customers

| Field            | Value                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| **Severity**     | **HIGH**                                                                                                 |
| **Affected**     | `legal/{DPA,PRIVACY,SUBPROCESSORS,TERMS}.md`                                                             |
| **Evidence**     | `[COMPANY NAME]` ×5, `[ADDRESS]` ×4, `[REGISTRATION NO.]` ×4. `GET /legal/{slug}` serves these verbatim. |
| **Expected**     | No placeholder in a customer-facing document                                                             |
| **Actual**       | A customer reading the privacy policy sees `[COMPANY NAME]`                                              |
| **Verification** | `grep -rn "\[COMPANY NAME\]" legal/`                                                                     |

---

### COMP-002 — The legal validator requires placeholders, so it cannot catch this

| Field            | Value                                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **HIGH**                                                                                                                                                               |
| **Affected**     | `scripts/validate-legal.mjs`                                                                                                                                           |
| **Evidence**     | Output: _"Legal pack is consistent: 6 documents, placeholders intact."_ The check asserts placeholders are still present, because the pack is deliberately pre-launch. |
| **Expected**     | A gate that fails when placeholders reach a released build                                                                                                             |
| **Actual**       | A gate that passes while they are present, in every environment                                                                                                        |
| **Verification** | `npm run test:legal`; read the script                                                                                                                                  |

**Recommended correction:** Invert the check under a `LEGAL_PACK_FINAL=1` flag used by the release pipeline. The current behaviour is defensible during development and dangerous at release.

---

### COMP-003 — No licence is decided (`Q-002` open)

| Field            | Value                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| **Severity**     | **HIGH**                                                                                                    |
| **Affected**     | `LICENSE`; `PRD.json Q-002`                                                                                 |
| **Evidence**     | `Q-002` remains open. The `LICENSE` file states proprietary/all-rights-reserved pending owner confirmation. |
| **Expected**     | A decided licence before commercial distribution                                                            |
| **Actual**       | Undecided — blocks sales and any open-source contribution                                                   |
| **Verification** | Read `LICENSE`; `node -e "require('./PRD.json').openQuestions"`                                             |

---

### COMP-004 — No penetration test

| Field        | Value                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Severity** | **HIGH** (commercial)                                                                                              |
| **Affected** | Procurement                                                                                                        |
| **Evidence** | None performed. The repository's own procurement analysis names it as the item that "changes a security question". |
| **Expected** | A dated external test, or a scheduled one                                                                          |
| **Actual**   | None                                                                                                               |

---

### COMP-005 — DSAR cannot be fulfilled completely (shared with PRIV-001)

| Field            | Value                                                   |
| ---------------- | ------------------------------------------------------- |
| **Severity**     | **HIGH**                                                |
| **Affected**     | `privacy-service.ts:121`                                |
| **Evidence**     | Export omits document images and field values.          |
| **Expected**     | Statutory right to a copy of personal data is satisfied |
| **Actual**       | Metadata only; subjects must ask an administrator       |
| **Verification** | Read line 121                                           |

**Cross-reference:** same root cause as PRIV-001. Recorded here because it is a legal obligation, not only a technical gap.

---

### COMP-006 — MFA cannot be required; a procurement blocker

| Field        | Value                                                    |
| ------------ | -------------------------------------------------------- |
| **Severity** | **MEDIUM**                                               |
| **Affected** | Auth policy (AUTH-003)                                   |
| **Evidence** | MFA is per-user optional; no organisation policy exists. |
| **Expected** | Enterprises require enforceable 2FA                      |
| **Actual**   | Not possible                                             |

---

### COMP-007 — Uganda DPPA registration and DPO appointment are unaddressed

| Field        | Value                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| **Severity** | **MEDIUM**                                                                                                  |
| **Affected** | Compliance posture                                                                                          |
| **Evidence** | No registration with the Authority, no named DPO beyond a placeholder, no evidence of either being planned. |
| **Expected** | Registration acknowledged with an owner                                                                     |
| **Actual**   | Absent                                                                                                      |

---

### COMP-008 — No breach-notification procedure

| Field        | Value                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| **Severity** | **MEDIUM**                                                                                             |
| **Affected** | Operations                                                                                             |
| **Evidence** | The 72-hour obligation is referenced in the policy; no procedure, no template, no contact path exists. |
| **Expected** | A written runbook                                                                                      |
| **Actual**   | None                                                                                                   |

---

## 7. Missing functionality

| Item             | Status              |
| ---------------- | ------------------- |
| Company details  | **Not supplied**    |
| Advocate review  | **Not obtained**    |
| Penetration test | **Not obtained**    |
| Licence decision | **Not decided**     |
| Enforceable MFA  | **Not implemented** |
| Breach procedure | **Not implemented** |
| SSO/SAML         | **Not implemented** |

---

## 8. Security concerns

Procurement evidence is thin: no pen test, no attestation, no SSO, no enforceable MFA. These are commercial rather than technical risks — the code's security posture is better than its paperwork suggests.

---

## 9. Performance concerns

None.

---

## 10. Recommendations

1. **Fill or gate the placeholders (COMP-001/002)** before any customer reads the pack.
2. **Decide the licence (COMP-003)** — it blocks every sales conversation.
3. **Commission the penetrometer (COMP-004)** before Gate 3.
4. Write the breach procedure (COMP-008).

---

## EVIDENCE CLASSIFICATION

| Class                        | Items                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **A. Verified working**      | Retention consistency, scoped encryption claim, placeholder register, DPA coverage, conservative liability |
| **B. Verified failing**      | COMP-001, COMP-002, COMP-003                                                                               |
| **C. Not implemented**       | Advocate review, pen test, licence, breach procedure, MFA policy, SSO                                      |
| **D. Partially implemented** | DSAR (COMP-005); compliance posture                                                                        |
| **E. Unable to verify**      | Legal sufficiency — requires licensed counsel                                                              |

---

## ISSUE SUMMARY

| ID       | Severity | Title                               |
| -------- | -------- | ----------------------------------- |
| COMP-001 | **HIGH** | 13 placeholders served to customers |
| COMP-002 | **HIGH** | Validator requires the placeholders |
| COMP-003 | **HIGH** | Licence undecided (`Q-002`)         |
| COMP-004 | **HIGH** | No penetration test                 |
| COMP-005 | **HIGH** | DSAR incomplete (PRIV-001)          |
| COMP-006 | MEDIUM   | MFA not enforceable                 |
| COMP-007 | MEDIUM   | DPPA registration/DPO unaddressed   |
| COMP-008 | MEDIUM   | No breach procedure                 |

**Totals: 0 CRITICAL · 5 HIGH · 3 MEDIUM · 0 LOW**
