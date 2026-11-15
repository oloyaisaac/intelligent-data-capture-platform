# REVIEWER 14 — AI / DOCUMENT-INTELLIGENCE ENGINEER

| Field | Value |
|-------|-------|
| **Reviewer ID** | R14 |
| **Title** | AI / Document-Intelligence Engineer |
| **Board** | D — AI & integrations |
| **Wave** | 4 (weeks 6–8) |
| **Effort** | 15 person-days |
| **Gate chaired** | none |
| **Co-signs** | G9 |
| **Evidence to** | G2, G5 (contributes findings, not an approver) |
| **Finding prefix** | `AIX-###` (use `AIX-###` to avoid collision with PRD story IDs `AI-001`…`AI-004`) |
| **Upstream** | R03 (data model), R02 (worker) |
| **Downstream** | R22 (accuracy acceptance), R15 (mapping consumes extractions) |
| **Status** | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Determine whether extraction is **accurate enough to trust**, whether confidence scores mean what the UI
implies, and whether the pipeline fails safely. You are the reviewer responsible for the product's central
technical claim: *"AI extracts and structures the content, and a human confirms anything uncertain."*

**The uncomfortable truth you must confront.** `PRD.json` story `AI-002` requires *"an agreed benchmark on
the labelled test set."* **There is no labelled test set and no benchmark anywhere in this repository.**
`AGENT_STATE.md` states it plainly: *"treat that criterion as not measurable until a corpus is added."*
That means:

- Extraction quality is currently **unmeasured**.
- The review UI's "low confidence goes first" safety net is **unvalidated** — no one knows whether
  high-confidence values are actually more likely to be correct.
- The commercial claim ("saves you retyping") rests on an unquantified accuracy.

**Your primary deliverable is therefore not a code review — it is the first measurement this project has
ever had, plus the benchmark harness so it stays measured.**

---

## 2. Required expertise

- OCR and document layout analysis; text extraction from scans and phone photos
- Information extraction: field, key-value and table extraction
- Confidence calibration (reliability diagrams, expected calibration error)
- Evaluation methodology: corpora, labelling, train/dev/test discipline, per-field precision/recall/F1
- LLM/vision-provider integration: prompt design, schema conformance, cost control, retries, determinism
- PII handling in AI pipelines

---

## 3. Repository context (self-contained)

**Product.** A phone photographs a document; the backend OCRs it, classifies it (receipt / invoice /
delivery note / ID / contract / other), extracts fields and tables with **per-field confidence**, normalises
to the Universal Data Model (UDM), and routes low-confidence documents to human review.

**AI implementation:**

| Element | Path | LOC |
|---------|------|-----|
| Pipeline orchestration | `apps/backend/src/ai/pipeline.ts` | 156 |
| Field/table extraction | `apps/backend/src/ai/extract.ts` | 394 |
| Classification | `apps/backend/src/ai/classify.ts` | 112 |
| Provider interface | `apps/backend/src/ai/providers/types.ts` | 49 |
| Local OCR (tesseract subprocess) | `apps/backend/src/ai/providers/tesseract.ts` | 116 |
| Cloud provider (opt-in) | `apps/backend/src/ai/providers/cloud.ts` | 124 |
| UDM schema (Zod) | `packages/shared/src/udm/schema.ts` | 234 |
| Review rules / thresholds | `packages/shared/src/review.ts` | 148 |
| Worker that runs jobs | `apps/backend/src/services/worker.ts` | 282 |
| Job persistence + backoff | `apps/backend/src/repositories/system-repo.ts` | 203 |
| Template-based extraction | `apps/backend/src/services/template-service.ts` | 215 |
| Correction capture + opt-in training export | `apps/backend/src/services/review-service.ts` | 397 |
| AI test suite | `apps/backend/test/ai.test.ts` | 175 |

**Configuration (`config.ts`):**

| Key | Default | Meaning |
|-----|---------|---------|
| `AI_PROVIDER` | `local` | `local` (tesseract) or `cloud` |
| `AI_LOCAL_ENGINE` | `tesseract` | Only local engine |
| `TESSERACT_BIN` | `tesseract` | **External binary dependency** |
| `AI_CLOUD_ENDPOINT` | — | Required when cloud |
| `AI_CLOUD_API_KEY` | — | Required when cloud |
| `AI_CLOUD_MODEL` | `gpt-4o-mini` | Cloud model id |
| `AI_MAX_COST_MICROS_PER_DOC` | `0` | **Must be > 0 for cloud or the server refuses to start** |
| `AI_REVIEW_CONFIDENCE_THRESHOLD` | `0.85` | Review routing threshold |

**Documented pipeline** (`ARCHITECTURE.md` §2.6):
`upload → preprocess → OCR (text + geometry) → classify → extract fields/tables → normalise to UDM → score confidence → mark needs_review → persist`

**Environment reality:** the `tesseract` binary is **not installed** in the assessment sandbox
(`command -v tesseract` → not found). The provider is designed to fail with an actionable error
(`ProviderUnavailableError`) rather than silently produce empty text — verify that.

---

## 4. Exact files and components to examine

### 4.1 Must read in full

`ai/pipeline.ts` · `ai/extract.ts` (394 — every regex and heuristic) · `ai/classify.ts` ·
`ai/providers/types.ts` · `ai/providers/tesseract.ts` · `ai/providers/cloud.ts` ·
`packages/shared/src/udm/schema.ts` · `packages/shared/src/review.ts` · `packages/shared/src/constants.ts` ·
`services/worker.ts` · `services/template-service.ts` · `services/review-service.ts` (correction path) ·
`apps/backend/test/ai.test.ts`

### 4.2 Must cross-check

- `apps/backend/src/services/document-service.ts` — how a document enters the pipeline.
- `apps/backend/src/repositories/document-repo.ts` — how extractions are persisted.
- `apps/backend/src/db/migrations.ts` — the `extractions` table shape (provenance fields).
- `packages/connectors/src/contract.ts` — how extracted fields reach a destination (R15 owns the connector).
- `packages/shared/src/money.ts`, `dates.ts` — normalisation helpers used by extraction.

### 4.3 Explicit non-goals

Connector write correctness → R15 · worker crash recovery → R18 · storage of the original file → R03 ·
the review UI's interaction design → R12.

---

## 5. Upstream artefacts required

| From | Artefact | Why |
|------|----------|-----|
| R03 | `evidence/R03/schema.md` | The `extractions` table and its provenance columns |
| R02 | `evidence/R02/route-matrix.csv` | The upload → job → extraction route flow |

---

## 6. Checklist

### 6.1 PIPELINE CORRECTNESS

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| AIX-01 | The pipeline stages are exactly as documented | Read `pipeline.ts` | Matches `ARCHITECTURE.md` §2.6 or the doc is corrected | STATIC |
| AIX-02 | Every stage's output is validated before the next stage consumes it | Read | Zod validation at the boundary | STATIC |
| AIX-03 | **Every extraction is validated against the UDM schema before persistence** | Read the persist path; feed a malformed provider response | Rejected, not stored | **RUNTIME** |
| AIX-04 | Provenance is stored: provider name, model/version, latency, cost | `extractions` columns | All present | STATIC |
| AIX-05 | Extraction is idempotent per document job | Read worker + repo | Re-running replaces, not duplicates | STATIC |
| AIX-06 | A provider returning empty text produces a legible failure, not a silent success | Simulate | `failed` with an actionable message | **RUNTIME** |
| AIX-07 | A missing `tesseract` binary fails actionably | Unset the binary and run a job | `ProviderUnavailableError`, document `failed`, message names the cause | **RUNTIME** |
| AIX-08 | OCR timeout (60 s) is enforced and handled | Simulate a slow binary | Timeout → retry → dead, per the job policy | **RUNTIME** |
| AIX-09 | `maxBuffer` (32 MB) overflow is handled | Feed a huge TSV output | Error caught, job failed cleanly | STATIC |
| AIX-10 | The subprocess cannot be used for command injection | Confirm the temp filename is server-generated and the binary is not shell-invoked | `execFile` with an argv array (no shell) | STATIC |
| AIX-11 | Temp files are always cleaned up | Read the `finally` block | Removed on success and failure | STATIC |
| AIX-12 | Concurrent OCR jobs are bounded | Read the worker concurrency model | Never unbounded `execFile` fan-out | STATIC |

### 6.2 CLASSIFICATION

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| AIX-13 | Enumerate every document type the classifier can emit | `classify.ts` + UDM enum | Listed | STATIC |
| AIX-14 | Classification is deterministic for identical input | Run the same document 5× | Identical output | **RUNTIME** |
| AIX-15 | Unknown documents fall back to `other`, never crash | Feed a photo of a wall | `other` + review | **RUNTIME** |
| AIX-16 | Classification confidence is a real value, not a constant | Read | Real | STATIC |
| AIX-17 | Misclassification costs are bounded | Reason about the review consequence | A wrong type still leads to review | STATIC |

### 6.3 EXTRACTION QUALITY — the missing measurement

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| AIX-18 | **Confirm no labelled corpus exists** | `find . -iname "*corpus*" -o -iname "*fixture*" -o -iname "*labelled*"`; check `uploads/`, `fixtures/` (gitignored) | Absent — record as the primary finding | **RUNTIME** |
| AIX-19 | **Build a corpus**: ≥200 real documents per type, labelled by two annotators, with an agreement check | Data work | `evidence/R14/corpus/` + a labelling guide | **WRITE** |
| AIX-20 | **Build a benchmark harness** that runs the pipeline over the corpus and reports per-field precision/recall/F1 | New script (propose, do not commit without approval) | `evidence/R14/benchmark-report.md` | **WRITE** |
| AIX-21 | Measure per-field accuracy per document type | Run the harness | Numbers, with confidence intervals | **RUNTIME** |
| AIX-22 | Measure **no-correction export rate** — the metric the business actually cares about | Count records exported untouched | A single number, agreed with R22 | **RUNTIME** |
| AIX-23 | Identify the weakest fields and document types | From the benchmark | A ranked list | **RUNTIME** |
| AIX-24 | Extraction handles locale variance: `1.234,56` vs `1,234.56`; `DD/MM/YYYY` vs `MM/DD/YYYY` | Test with sw/fr and en documents | Correct or documented | **RUNTIME** |
| AIX-25 | Multi-page and multi-document inputs behave predictably | Test a 3-page PDF | Documented behaviour | **RUNTIME** |
| AIX-26 | Tables are extracted with row/column fidelity | Test 20 tabular documents | Measured accuracy | **RUNTIME** |
| AIX-27 | Templates measurably improve accuracy for their type | A/B with and without a template | Improvement demonstrated or the feature's value recorded as unproven | **RUNTIME** |

### 6.4 CONFIDENCE AND CALIBRATION

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| AIX-28 | How is confidence computed? | Read `extract.ts` | Documented; is it heuristic or learned? | STATIC |
| AIX-29 | Is confidence **per field** or per document? | Read | Per field (as documented) or the doc corrected | STATIC |
| AIX-30 | Is confidence **calibrated**? Build a reliability diagram: bucket by confidence, plot accuracy | From the benchmark | Calibration curve + expected calibration error | **WRITE** |
| AIX-31 | The key safety question: **when confidence ≥ 0.85, what is the error rate?** | From the benchmark | A measured number | **RUNTIME** |
| AIX-32 | The threshold `0.85` is justified by data, not chosen | Compare accuracy above/below | Justified or re-tuned with evidence | STATIC |
| AIX-33 | Deterministic post-processing cannot silently boost confidence | Read | No arbitrary lift | STATIC |
| AIX-34 | Confidence is preserved through normalisation to UDM | Read | Preserved | STATIC |
| AIX-35 | Correction data (REV-002) can be used to detect systematic low-confidence errors | Read the stats path | Available | STATIC |

### 6.5 PROVIDER ABSTRACTION

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| AIX-36 | Local and cloud implement the same interface | `providers/types.ts` | Identical contract | STATIC |
| AIX-37 | Switching provider requires no service change | Read `pipeline.ts` selection | Clean swap | STATIC |
| AIX-38 | Cloud provider handles 429/5xx with backoff | Read `cloud.ts` | Bounded retries | STATIC |
| AIX-39 | Cloud responses are schema-validated (prompt-injection / malformed JSON) | Read + simulate a malicious response | Rejected | **RUNTIME** |
| AIX-40 | **Cost is tracked and enforced per document and per organisation** | Read `AI_MAX_COST_MICROS_PER_DOC` usage | Enforced at runtime, not only validated at boot | STATIC |
| AIX-41 | Spend visibility exists (per org, per period) | Search | Present or recorded missing | STATIC |
| AIX-42 | A document cannot be processed repeatedly to run up a bill | Rate/concurrency limit | Bounded | STATIC |
| AIX-43 | Prompt/endpoint is not attacker-controllable by document content | Read | Endpoint fixed by config | STATIC |
| AIX-44 | TLS is enforced for the cloud endpoint | Read | Enforced | STATIC |

### 6.6 DATA HANDLING AND PRIVACY (co-owned with R08)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| AIX-45 | Cloud AI is **opt-in per organisation** and recorded | `organisations.ai_provider`, `learning_opt_in` | Enforced | STATIC |
| AIX-46 | The user/org is told when documents leave the infrastructure | UI + docs | Told | STATIC |
| AIX-47 | Document text and images never appear in logs | Read logging | Clean | STATIC |
| AIX-48 | Extractions containing PII follow the erasure/retention rules | Cross-check with R08 inventory | Consistent | STATIC |
| AIX-49 | The opt-in training export is genuinely opt-in and default-off | `REV-002` + `learning_opt_in` | Confirmed | STATIC |

### 6.7 Worker integration and job lifecycle (co-owned with R18)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| AIX-50 | Pipeline failure maps to a job state, not a crash | Read `worker.ts` | Caught, retried, then `dead` | STATIC |
| AIX-51 | Retry with backoff is correct for transient OCR failures | Read `system-repo.ts` retry | 5 attempts, exponential | STATIC |
| AIX-52 | A permanently failing document notifies the user | `document:failed` SSE event | Emitted | STATIC |
| AIX-53 | Progress events are emitted for long extractions | `job:progress` | Emitted | STATIC |
| AIX-54 | OCR runs **outside** database transactions | Read the flow | No long transaction holds a write lock | STATIC |

---

## 7. Known AI risks to confirm or refute

| Risk | Statement |
|------|-----------|
| **R-19 (MEDIUM)** | Confidence may be uncalibrated, so "low confidence goes first" may not protect the customer |
| **R-08** | `AI-001` and `AI-002` carry `verification` blocks: no benchmark exists |
| R-12 | Batch volume × OCR fan-out is a resource risk |
| — | `tesseract` is an external binary dependency with no install step documented in CI |
| — | Cloud spend caps are validated at boot but enforcement at runtime is unverified |

---

## 8. Questions you must answer

1. **What is the field-level accuracy of extraction today?** Give per-type numbers.
2. When confidence ≥ 0.85, what fraction of values are wrong?
3. What fraction of real documents can be exported with **no human correction**?
4. Does a missing OCR binary fail safely and actionably?
5. Can a malicious document burn the cloud budget or inject into the prompt?
6. Are templates measurably worth their complexity?
7. Does anything leave the customer's infrastructure without consent?

---

## 9. Commands to run

```bash
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund

# ---------- is there a corpus / benchmark at all? ----------
find . -path ./node_modules -prune -o \( -iname "*corpus*" -o -iname "*benchmark*" -o -iname "*labelled*" -o -iname "*labeled*" \) -print
ls -la uploads fixtures 2>/dev/null
grep -rn "benchmark\|precision\|recall\|f1" apps/backend/test packages/shared/test | head

# ---------- OCR availability ----------
command -v tesseract && tesseract --version || echo "tesseract NOT INSTALLED"
grep -n "execFile\|timeout\|maxBuffer" apps/backend/src/ai/providers/tesseract.ts
grep -n "ProviderUnavailable" -A3 apps/backend/src/ai/providers/tesseract.ts

# ---------- confidence and thresholds ----------
grep -rn "confidence" apps/backend/src/ai/*.ts packages/shared/src/review.ts | head -40
grep -n "AI_REVIEW_CONFIDENCE_THRESHOLD" -r apps/backend/src

# ---------- cost control ----------
grep -rn "AI_MAX_COST_MICROS_PER_DOC\|cost_micros" apps/backend/src | head -20

# ---------- UDM validation before persist ----------
grep -rn "safeParse\|UdmSchema\|udm" apps/backend/src/services/document-service.ts apps/backend/src/ai/pipeline.ts | head -20

# ---------- run the AI suite ----------
npx jest --config jest.config.cjs --selectProjects backend --runInBand -t "extract|classif|OCR|pipeline|AI"

# ---------- exercise the pipeline end to end ----------
npm run db:migrate && npm run db:seed && npm run dev:backend &
# upload a real receipt PDF/JPG via the API, then:
sqlite3 ./local-storage/idcp.db "SELECT document_type, confidence, fields FROM extractions ORDER BY created_at DESC LIMIT 3;"
sqlite3 ./local-storage/idcp.db "SELECT id,status,attempts,last_error FROM jobs ORDER BY created_at DESC LIMIT 3;"
```

---

## 10. Tests to perform

| # | Test | Procedure | Pass criterion |
|---|------|-----------|----------------|
| T-01 | Corpus build | ≥200 labelled documents per type | Corpus committed with a labelling guide |
| T-02 | Benchmark run | Harness over the corpus | Per-field P/R/F1 per type |
| T-03 | Calibration | Bucket accuracy by confidence | Reliability diagram + ECE reported |
| T-04 | Threshold validation | Accuracy above vs below `0.85` | Threshold justified or re-tuned |
| T-05 | No-correction rate | Count untouched exports | A single agreed number |
| T-06 | Missing binary | Run without `tesseract` | Actionable failure |
| T-07 | Malformed provider response | Inject invalid JSON/schema | Rejected, not stored |
| T-08 | Cloud 429/500 | Stub the provider | Backoff, then a bounded failure |
| T-09 | Cost cap | Exceed the per-doc cap | Enforced |
| T-10 | Locale numbers/dates | `1.234,56`; `DD/MM/YYYY` | Parsed correctly |
| T-11 | Wall photo | Upload a non-document | `other` + review, no crash |
| T-12 | Template effect | A/B with/without | Measured |
| T-13 | Prompt injection | A document containing "ignore previous instructions…" | No behavioural change |

---

## 11. Evidence required

```
docs/reviewers/evidence/R14/
├── corpus/                      # labelled samples (or a pointer + access note if too large for git)
├── labelling-guide.md           # how labels were defined and by whom
├── benchmark-report.md          # per-type, per-field P/R/F1 + confidence intervals
├── calibration.md               # reliability diagram + ECE + the 0.85 decision
├── no-correction-rate.md        # the business metric
├── failure-modes.md             # T-06 … T-11, T-13
├── provider-review.md           # abstraction, cost enforcement, privacy switches
├── commands.log
└── findings.md                  # AIX-### register
```

> **Repository hygiene note:** a labelled corpus may be large or contain real personal data. Commit the
> *harness and labelling guide*; store the corpus outside git (see `.gitignore`: `fixtures/private/`) and
> reference it by digest.

---

## 12. Passing conditions (co-signs G9)

- [ ] **P1** A labelled corpus exists with a documented labelling process (AIX-18, AIX-19, T-01).
- [ ] **P2** A reproducible benchmark harness reports per-field accuracy by document type (AIX-20 … AIX-23, T-02).
- [ ] **P3** Confidence is calibrated and the review threshold is justified by measurement (AIX-28 … AIX-34, T-03, T-04).
- [ ] **P4** The no-correction export rate is measured and meets the agreed threshold (AIX-22, T-05).
- [ ] **P5** Every extraction is UDM-validated before persistence (AIX-03, T-07).
- [ ] **P6** Provider failure paths are actionable; a missing binary fails safely (AIX-06 … AIX-12, T-06, T-08).
- [ ] **P7** Cost caps are enforced at runtime with visibility (AIX-40 … AIX-42, T-09).
- [ ] **P8** Cloud AI is opt-in, recorded, disclosed, and never logs content (AIX-45 … AIX-49).
- [ ] **P9** The `AI-001`/`AI-002` verification blocks are closed by real measurement, or the stories are moved off `done` (R-08).

---

## 13. Blocked items

| Item ID | Blocker | What unblocks it | Owner |
|---------|---------|------------------|-------|
| T-01 | No documents available to label | Source a real corpus (from a design partner) with consent | R22 |
| AIX-37 | No cloud AI credentials | Provision a test account with a spend cap | R19 |
| — | `tesseract` not installed | `apt-get install tesseract-ocr` (+ `-osd`, language packs) | R19 |

---

## 14. Findings register

| ID | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
|----|----------|-----------|---------|----------------|-----------|---------------|-------|
| AIX-001 | | | | | | | |

---

## 15. Reviewer sign-off

| Field | Value |
|-------|-------|
| Reviewer name | |
| Date started | |
| Date completed | |
| **G9 co-sign result** | ☐ Pass ☐ Fail ☐ Abstain |
| Co-sign G2 / G5 / G9 | ☐ ☐ ☐ |
| **Corpus exists** | ☐ Yes ☐ No |
| **Measured accuracy (no-correction rate)** | |
| **Calibration verdict** | ☐ Good ☐ Poor ☐ Unknown |
| Conditions failed (IDs) | |
| Reviewed commit | `43d384b` |
| Statement | *I read the whole pipeline and extraction code, built or obtained a labelled corpus, and produced the first accuracy and calibration measurements this project has had.* |
| Signature | |
