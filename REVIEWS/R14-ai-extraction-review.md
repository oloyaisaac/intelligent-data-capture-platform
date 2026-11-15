# REVIEWER NAME: AI / Document-Intelligence Engineer (R14)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R14-ai-extraction.md` (54 checklist items)
**STATUS:** ☑ Complete — **extraction accuracy unmeasured** (no corpus, no tesseract, no cloud credentials)

---

## AREAS EXAMINED

Pipeline (156) · `extract.ts` (394) · `classify.ts` (112) · `providers/tesseract.ts` (116) · `providers/cloud.ts` (124) · worker (282) · UDM schema (234).

---

## 1. Summary of examination

I read the extraction and classification logic in full, inspected both providers, and checked for the two things that would make an accuracy claim possible: a document corpus and a measured benchmark. Neither exists.

**Verdict: the code is well-structured and honest about its limits, but the product's central claim — that AI extraction saves work — has never been measured.** Confidence values are computed from pattern strength, not from observed correctness. With no corpus, there is no way to know whether "confidence 0.8" means 80% correct.

---

## 2. Files and components inspected

| File | LOC | Checked |
|---|---|---|
| `apps/backend/src/ai/pipeline.ts` | 156 | orchestration, failure paths |
| `apps/backend/src/ai/extract.ts` | 394 | field extraction, confidence derivation |
| `apps/backend/src/ai/classify.ts` | 112 | document type scoring, threshold |
| `apps/backend/src/ai/providers/tesseract.ts` | 116 | binary invocation, absence handling |
| `apps/backend/src/ai/providers/cloud.ts` | 124 | external call, data egress, timeout |
| `packages/shared/src/udm/schema.ts` | 234 | output contract |
| `apps/backend/src/services/worker.ts` | 282 | job lifecycle |

---

## 3. Features examined

OCR execution · field extraction · document classification · confidence scoring · low-confidence routing · provider selection · spending cap · UDM validation.

---

## 4. Tests performed

| # | Test | Result |
|---|---|---|
| T1 | `npx jest ai` | **PASS** |
| T2 | `tesseract` binary present | **ABSENT** (`which tesseract` → nothing) |
| T3 | Real OCR end to end | **NOT RUN** — no binary, no provider credentials |
| T4 | Accuracy corpus | **DOES NOT EXIST** |
| T5 | Confidence calibration | **UNVERIFIABLE** — no ground truth |
| T6 | Cloud provider gated | **PASS** — opt-in, spend cap required |
| T7 | UDM schema validation on output | **PASS** — `--check` in CI |
| T8 | Classification threshold | read `classify.ts:111` | **PASS** — explicit threshold |
| T9 | Thousands of real documents | **NOT RUN** |

---

## 5. Successful findings

1. **Confidence is derived per field from the strength of the pattern that matched** (`extract.ts:13`) and flows to the review UI so low-confidence fields surface first. The *mechanism* is right even though the *calibration* is unknown.
2. **Classification has an explicit low-confidence threshold** (`classify.ts:111`) rather than forcing every document into a type.
3. **The cloud provider is opt-in, requires an explicit endpoint, API key and spend cap**, and refuses to start without the cap (citing `PRD.json Q-001`). Refusing to enable egress without cost control is good governance.
4. **The cloud provider is deliberately narrow** — no vendor SDK, hard timeout, no vendor types leaking into the domain.
5. **The UDM schema is generated from TypeScript and drift-checked in CI**, so the extraction contract cannot silently diverge from the schema.
6. **The tesseract provider handles absence gracefully** rather than crashing the worker.

---

## 6. Identified problems

### AIX-001 — Extraction accuracy has never been measured

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | Whole AI pipeline |
| **Evidence** | No corpus directory, no benchmark script, no recorded accuracy figure anywhere in the repository. `find . -name "*.json" \| xargs grep -l "corpus\|benchmark"` returns only `PRD.json` (a mention, not data). |
| **Expected** | Accuracy measured per document type on a labelled set |
| **Actual** | Unknown |
| **Verification** | Absence of any corpus or metric |

**Why HIGH:** the product's value proposition depends on extraction being accurate enough that review takes less time than retyping. Without a measurement, no one knows whether that is true for receipts, for invoices, or for anything. The no-correction export rate — the single number that decides the business — does not exist.

**Recommended correction:** Build a corpus of ≥200 real documents per target type from the pilot, label the ground truth, and record precision/recall per field. This is the highest-value work in the AI domain and it is a prerequisite for R22.

**Verification requirements:** A reproducible benchmark run reporting per-type accuracy and no-correction rate.

---

### AIX-002 — Confidence values are uncalibrated

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | `apps/backend/src/ai/extract.ts`; `classify.ts:97` |
| **Evidence** | `const confidence = Math.max(0.2, Math.min(0.98, Number(raw.toFixed(3))))` — bounded to `[0.2, 0.98]` by construction. The value reflects pattern strength; nothing maps it to probability of correctness. |
| **Expected** | A field at confidence 0.9 is correct ~90% of the time |
| **Actual** | The number is ordinal at best. The UI sorts by it, so ordering is probably useful; the *absolute* value is meaningless. |
| **Verification** | Read `extract.ts` and `classify.ts`; no calibration step exists |

**Why HIGH:** the review UI lets operators trust high-confidence fields. If 0.98 does not mean "almost certainly right", reviewers will skim and approve errors — and the error escapes to the customer's downstream system. That is the worst possible failure mode for a document-extraction product.

**Recommended correction:** Calibrate against the AIX-001 corpus: bin predicted confidence, plot observed accuracy, and either fit a mapping or replace the value with an explicit tier (high/medium/low) that is honest about being ordinal.

**Verification requirements:** A reliability diagram (confidence bin vs observed accuracy) in the evidence set.

---

### AIX-003 — No ground truth means regression in extraction quality would be invisible

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | CI |
| **Evidence** | `ai.test.ts` asserts schema validity and routing, not extraction quality. A change that halves recall would pass every test. |
| **Expected** | A quality gate in CI |
| **Actual** | Structural tests only |
| **Verification** | Read `apps/backend/test/ai.test.ts` assertions |

**Recommended correction:** Once the corpus exists, snapshot per-type accuracy and fail CI on regression beyond a tolerance.

---

### AIX-004 — The local provider cannot run in any environment reviewed so far

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | `providers/tesseract.ts`; deployment |
| **Evidence** | `tesseract` is absent from the assessment environment. No Dockerfile exists (R19) to guarantee its presence in production. |
| **Expected** | The default provider (`AI_PROVIDER=local`) works out of the box |
| **Actual** | It fails unless the operator installs a system binary that no deployment artefact installs |
| **Verification** | `which tesseract`; no Dockerfile |

**Recommended correction:** Either bundle the binary in the deployment image, or make the absence a startup error with an actionable message rather than a per-document failure.

---

### AIX-005 — Document type coverage is untested per type

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | `classify.ts`; extraction patterns |
| **Evidence** | Patterns exist for receipts, invoices, delivery notes and IDs, but no per-type accuracy figure exists, so it is unknown which types are viable for sale. |
| **Expected** | A per-type readiness statement |
| **Actual** | All types presented as equally supported |
| **Verification** | Would require AIX-001 |

**Recommended correction:** After the benchmark, publish "supported / beta / unsupported" per document type. Selling a type that extracts badly is worse than not offering it.

---

## 7. Missing functionality

| Item | Status |
|---|---|
| Labelled corpus | **Not implemented** |
| Accuracy benchmark | **Not implemented** |
| Confidence calibration | **Not implemented** |
| Per-type readiness | **Not implemented** |
| Quality regression gate | **Not implemented** |
| Multi-page PDF handling at scale | **Unverified** |

---

## 8. Security concerns

When cloud AI is enabled, document images are transmitted as base64 `data:` URLs to an external endpoint — the image content leaves the deployment. This is correctly opt-in and documented, but the provider is a **sub-processor** that must appear in `legal/SUBPROCESSORS.md` whenever enabled.

---

## 9. Performance concerns

OCR is the dominant cost in the pipeline. `RECOVERY_GRACE_MS = 30 s` may requeue long OCR jobs that are still running (cross-ref REL). Throughput per document is unmeasured — deferred to R17.

---

## 10. Recommendations

1. **Build the corpus and measure (AIX-001).** Nothing in this domain can be honestly claimed without it.
2. **Calibrate confidence (AIX-002)** — the review UI's safety depends on it.
3. Publish per-type readiness (AIX-005) and sell only what works.
4. Guarantee the OCR binary exists in the deployment image (AIX-004).

---

## EVIDENCE CLASSIFICATION

| Class | Items |
|---|---|
| **A. Verified working** | Per-field confidence mechanism, classification threshold, opt-in gating, spend cap, UDM drift check, graceful absence |
| **B. Verified failing** | — (no failing behaviour proven; the gaps are absence of measurement) |
| **C. Not implemented** | Corpus, benchmark, calibration, per-type readiness, quality gate |
| **D. Partially implemented** | Confidence (mechanism yes, calibration no); providers (code yes, runtime unproven) |
| **E. Unable to verify** | **Extraction accuracy, confidence calibration, OCR execution, cloud provider behaviour** — no binary, no credentials, no corpus |

---

## ISSUE SUMMARY

| ID | Severity | Title |
|---|---|---|
| AIX-001 | **HIGH** | Accuracy never measured; no corpus |
| AIX-002 | **HIGH** | Confidence uncalibrated but drives reviewer trust |
| AIX-003 | MEDIUM | No quality regression gate |
| AIX-004 | MEDIUM | Default OCR provider cannot run in deployment |
| AIX-005 | MEDIUM | Per-type readiness unknown |

**Totals: 0 CRITICAL · 2 HIGH · 3 MEDIUM · 0 LOW**
