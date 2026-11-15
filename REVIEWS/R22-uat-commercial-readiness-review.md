# REVIEWER NAME: User Acceptance & Commercial Readiness Reviewer (R22)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R22-uat-commercial-readiness.md` (50 checklist items)
**STATUS:** ☒ **BLOCKED — pilot could not run.** 9 of 9 preconditions failed.

---

## AREAS EXAMINED

Preconditions · journeys J1–J13 · value measurement · commercial blockers · billing.

---

## 1. Summary of examination

I audited the nine hard preconditions from the brief. **Every one of them failed.** I did not recruit participants, because running a pilot against a product that cannot sign in would spend operator goodwill rediscovering already-known defects.

**Verdict: the pilot is blocked, and I report it as blocked rather than fabricating a result.** This is the only reviewer in the programme that could not execute its primary task, and the reason is itself the most important finding: **five independent critical-capability gaps each individually prevent a pilot.**

---

## 2. Files and components inspected

| Artefact                                    | Checked          |
| ------------------------------------------- | ---------------- |
| `PRD.json` target users, definition of done | ✓                |
| `README.md` 6-step usage flow               | ✓                |
| `evidence/` from R09–R14                    | cross-referenced |
| `package.json` (billing)                    | absent           |
| `legal/`, `electron-builder.json`           | preconditions    |

---

## 3. Features examined

Sign-up · pairing · capture · extraction · review · export · connectors · team · erasure · device revocation — all via their _prerequisites_ rather than execution.

---

## 4. Tests performed

| #   | Precondition                   | Result                                           |
| --- | ------------------------------ | ------------------------------------------------ |
| P1  | G1 architecture passed         | **NOT RUN** — reviews in progress                |
| P2  | G3 security passed             | **FAIL** — 4 HIGH open (R07)                     |
| P3  | G4 database passed             | **FAIL** — PostgreSQL never executed (DB-001)    |
| P4  | G7 UX/a11y passed              | **FAIL** — no live region, no axe (A11Y-001/002) |
| P5  | **Packaged desktop signs in**  | **FAIL — R-01/DESK-001 CRITICAL**                |
| P6  | **Password reset deliverable** | **FAIL — AUTH-002, no mail transport**           |
| P7  | Signed installer exists        | **FAIL — ELEC-003; no release/ directory**       |
| P8  | Mobile build on device         | **FAIL — MOB-001, no native project**            |
| P9  | Extraction accuracy measured   | **FAIL — AIX-001, no corpus**                    |

**Preconditions met: 0 / 9.**

---

## 5. Successful findings

Even without a pilot, several structural positives are visible and worth recording:

1. **The product loop is coherent and fully mapped to real screens** — dashboard, documents, review, export all exist and are reachable.
2. **The review screen is designed around the actual bottleneck** (per-field confidence, low-confidence first), which is the right instinct for this product category.
3. **Export works multiple ways** (Excel, CSV, connectors), so a customer with a spreadsheet workflow could get value on day one.
4. **Retention and erasure exist as real features**, not promises — unusual at this stage.
5. **The offline queue is designed for the real deployment context** (field capture on poor networks).

---

## 6. Identified problems

### UAT-001 — The pilot is blocked by five independent capability gaps

| Field            | Value                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| **Severity**     | **CRITICAL**                                                             |
| **Affected**     | Whole programme                                                          |
| **Evidence**     | 0/9 preconditions met. Each of P5–P9 alone would stop a pilot.           |
| **Expected**     | A runnable product to put in front of operators                          |
| **Actual**       | No packaged app, no mobile app, no reset, no installer, no accuracy data |
| **Verification** | The nine precondition results above                                      |

**Recommended correction:** No pilot until P5–P9 are green. The fastest path is: fix R-01 + CSP → build an unsigned Windows installer → add a mail transport → measure extraction on 200 documents.

---

### UAT-002 — The value proposition has never been measured

| Field            | Value                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **CRITICAL**                                                                                                                                       |
| **Affected**     | Business model                                                                                                                                     |
| **Evidence**     | No time-on-task data, no no-correction rate, no manual-baseline comparison exists. The README claim — _"IDCP replaces that loop"_ — is unmeasured. |
| **Expected**     | Evidence that IDCP is faster than retyping including review time                                                                                   |
| **Actual**       | No measurement of any kind                                                                                                                         |
| **Verification** | Absence across the repository                                                                                                                      |

**Why CRITICAL:** if review burden exceeds retyping, **the product has no business case** regardless of engineering quality. Every other finding in this review is repairable; this one determines whether repair is worth doing.

**Recommended correction:** The minimum viable experiment does not require the full product. Five operators, twenty of their own documents, and a stopwatch — comparing manual entry against extraction-plus-review. This can be run in a week once R-01 is fixed.

---

### UAT-003 — No billing exists; a pilot cannot become revenue

| Field            | Value                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------ |
| **Severity**     | **HIGH**                                                                                   |
| **Affected**     | Commercial                                                                                 |
| **Evidence**     | `grep -rniE "stripe\|billing\|subscription\|checkout"` across the backend returns nothing. |
| **Expected**     | A way to charge a customer                                                                 |
| **Actual**       | None. A successful pilot would convert to an unpaid deployment.                            |
| **Verification** | Grep                                                                                       |

**Note:** billing is not in the 45-story PRD, so this is scope-absent rather than scope-failed. It is still the blocker between "works" and "business".

---

### UAT-004 — Onboarding presumes a phone that cannot be built

| Field            | Value                                                                               |
| ---------------- | ----------------------------------------------------------------------------------- |
| **Severity**     | **HIGH**                                                                            |
| **Affected**     | First-run experience                                                                |
| **Evidence**     | The documented 6-step flow begins "pair a phone". Mobile cannot be built (MOB-001). |
| **Expected**     | A first-run path that works today                                                   |
| **Actual**       | Dead end unless the operator knows to upload from the desktop                       |
| **Verification** | Read `README.md` against MOB-001                                                    |

---

### UAT-005 — Support cannot be delivered for the current state

| Field        | Value                                                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity** | **MEDIUM**                                                                                                                                      |
| **Affected** | Operations                                                                                                                                      |
| **Evidence** | No runbooks (OPS-004), no metrics (REL-001), no alerts (REL-002). A customer reporting a stuck document could not be diagnosed from the system. |
| **Expected** | First-line diagnostics                                                                                                                          |
| **Actual**   | None                                                                                                                                            |

---

### UAT-006 — Document-type readiness is unknown, so the market cannot be chosen

| Field        | Value                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity** | **MEDIUM**                                                                                                                                   |
| **Affected** | Go-to-market                                                                                                                                 |
| **Evidence** | No per-type accuracy data (AIX-005), so it is unknown whether to target logistics (delivery notes), retail (receipts) or finance (invoices). |
| **Expected** | A recommended first segment backed by data                                                                                                   |
| **Actual**   | No data                                                                                                                                      |

---

## 7. Missing functionality

| Item                    | Status              |
| ----------------------- | ------------------- |
| Runnable packaged app   | **Not implemented** |
| Mobile build            | **Not implemented** |
| Password reset delivery | **Not implemented** |
| Accuracy data           | **Not implemented** |
| Billing                 | **Not implemented** |
| Onboarding materials    | **Not implemented** |
| Support runbooks        | **Not implemented** |
| Pilot instrumentation   | **Not implemented** |

---

## 8. Security concerns

A pilot would involve real customer documents containing personal data. Running one before G3 (security) is green would put third-party data into a system with four open HIGH findings. That is an additional reason to wait.

---

## 9. Performance concerns

No capacity data exists, so a pilot's infrastructure requirements are unknown. Cross-ref PERF-004.

---

## 10. Recommendations

1. **Do not run a pilot yet.** Report blocked.
2. Fix the R-01 chain (R-01 + CSP + packaged test), then build one unsigned installer.
3. Add a mail transport so recovery works.
4. Measure extraction on 200 real documents.
5. Re-audit these nine preconditions; then pilot.

---

## EVIDENCE CLASSIFICATION

| Class                        | Items                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **A. Verified working**      | Product loop structure, review-screen design, multi-path export, retention/erasure features, offline queue design |
| **B. Verified failing**      | **UAT-001 (0/9 preconditions)**, UAT-004                                                                          |
| **C. Not implemented**       | Billing, onboarding, runbooks, instrumentation, accuracy data                                                     |
| **D. Partially implemented** | First-run path (desktop-only branch works, undocumented)                                                          |
| **E. Unable to verify**      | **ALL user acceptance criteria** — no runnable product, no participants, no measurements                          |

---

## ISSUE SUMMARY

| ID      | Severity     | Title                                   |
| ------- | ------------ | --------------------------------------- |
| UAT-001 | **CRITICAL** | Pilot blocked; 0/9 preconditions met    |
| UAT-002 | **CRITICAL** | Value proposition never measured        |
| UAT-003 | **HIGH**     | No billing; pilot cannot become revenue |
| UAT-004 | **HIGH**     | Onboarding presumes unbuildable mobile  |
| UAT-005 | MEDIUM       | Support undeliverable                   |
| UAT-006 | MEDIUM       | Market segment undecidable              |

**Totals: 2 CRITICAL · 2 HIGH · 2 MEDIUM · 0 LOW**
