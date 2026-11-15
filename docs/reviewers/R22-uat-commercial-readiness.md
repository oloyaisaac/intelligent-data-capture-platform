# REVIEWER 22 — USER ACCEPTANCE & COMMERCIAL READINESS REVIEWER

| Field              | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| **Reviewer ID**    | R22                                                                |
| **Title**          | User Acceptance & Commercial Readiness Reviewer                    |
| **Board**          | G — Business, legal & acceptance                                   |
| **Wave**           | 5 (weeks 9–13) — **last**, and only after Gates 1–8 are green      |
| **Effort**         | 15 person-days                                                     |
| **Gate chaired**   | **G9 — Real-world user acceptance**                                |
| **Co-signs**       | G2, G7                                                             |
| **Evidence to**    | G3 (contributes findings, not an approver)                         |
| **Finding prefix** | `UAT-###`                                                          |
| **Upstream**       | Every other reviewer. You are the last evidence.                   |
| **Downstream**     | The go/no-go decision                                              |
| **Status**         | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Answer the only question the owner ultimately cares about: **will a real business pay for this, and can it
safely start using it on Monday?** You do that by putting the actual product — packaged desktop app, real phone,
real backend, real documents from the target sector — in front of real operators and measuring what happens.

**Why you go last.** Running a pilot before Gates 1–8 are green spends operator goodwill rediscovering defects
the reviews already found. Two of them would stop you on day one:

| Blocker             | Effect on a pilot                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| **R-01 (CRITICAL)** | The packaged desktop app cannot reach the backend — **sign-in fails, so the pilot cannot start** |
| **R-02 (CRITICAL)** | A participant who forgets their password cannot recover their account — no mail transport exists |

Those must be fixed first. Your job is then to measure what remains.

---

## 2. Required expertise

- Field/onsite UAT facilitation with non-technical operators
- Task analysis, time-and-motion measurement, error taxonomy
- SUS (System Usability Scale) and other validated instruments
- Pilot design: participant selection, consent, data handling, exit interviews
- Support-ticket taxonomy and triage
- Commercial readiness assessment: pricing inputs, onboarding, packaging, sales objections
- Benefit realisation: comparing the product against the status quo

---

## 3. Repository context (self-contained)

**Product promise (from `README.md`):**

> _"Businesses still run on paper. Someone photographs a delivery note, retypes it into a spreadsheet, and makes
> a mistake. IDCP replaces that loop: Phone camera → AI extraction → Human review → Business system."_

**The value claim is therefore a _labour_ claim:** IDCP must be **faster and more accurate than retyping**. If
review burden exceeds retyping, there is no business case — regardless of how good the code is.

**The target loop, end to end:**

```
Sign up (desktop) → pair a phone (QR) → capture a document → AI extracts
→ review & correct → approve → export to Excel/CSV or push to a connector
```

**What actually exists to pilot (verify each before recruiting):**

| Component         | State                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| Backend           | Runs on SQLite by default; PostgreSQL unverified (R-03)                                            |
| Desktop app       | **Packaged build cannot reach the API (R-01)** — no signed installer has ever been produced (R-10) |
| Mobile app        | No native build has ever been produced; `android/`/`ios/` absent (R-11)                            |
| AI extraction     | Runs only where the `tesseract` binary is installed; **accuracy unmeasured** (R-14)                |
| Connectors        | Only SQLite verified live; Google Sheets breaks after ~1 h (`CON-002`)                             |
| Password recovery | **Cannot complete (R-02)**                                                                         |
| Billing           | None — no way to charge a customer                                                                 |
| Legal pack        | Placeholders; not advocate-reviewed (R-21)                                                         |

---

## 4. Exact files and components to examine

You are testing the **deployed system**, but these documents define what you are validating against:

| #   | Artefact                                                             | Why                                                                       |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | `PRD.json` — 45 stories, `targetUsers`, `definitionOfDone`, `vision` | The stated intent you test against                                        |
| 2   | `uploads/PRD.md` and `uploads/requirements-1.md`                     | The original product intent (does the shipped thing match the dream?)     |
| 3   | `TESTING.md` §3.1 + the 11 `verification` blocks                     | Claims that were never demonstrated — you may be able to demonstrate some |
| 4   | `DEPLOYMENT.md` §11                                                  | The go-live checklist that must be green before you start                 |
| 5   | `README.md` "Basic usage" 6-step flow                                | The documented user journey                                               |
| 6   | `evidence/R12/journey-map.md` (R12)                                  | The measured interaction baseline                                         |
| 7   | `evidence/R14/benchmark-report.md` (R14)                             | Extraction accuracy you will observe in the field                         |
| 8   | `evidence/R18/runbooks/` (R18)                                       | The support procedures you will exercise                                  |
| 9   | `evidence/R21/commercial-gaps.md` (R21)                              | What you must not promise a participant                                   |

---

## 5. Upstream artefacts required — HARD PRECONDITIONS

**Do not begin recruiting participants until all of these are true.** Record each as a signed-off precondition.

| #   | Precondition                                           | Evidence required                 | Owner |
| --- | ------------------------------------------------------ | --------------------------------- | ----- |
| 1   | G1 Architecture — passed                               | `R01` sign-off                    | R01   |
| 2   | G3 Security & privacy — passed                         | `R07` sign-off                    | R07   |
| 3   | G4 Database — passed (or SQLite-only claim accepted)   | `R03` sign-off                    | R03   |
| 4   | G7 UI/UX & accessibility — passed                      | `R12`/`R13` sign-off              | R12   |
| 5   | **R-01 fixed**: a packaged desktop build signs in      | `R09`/`R10` evidence, T-01        | R10   |
| 6   | **R-02 fixed**: a reset link can actually be delivered | `R19` mail transport + `R05` test | R19   |
| 7   | A signed installer exists for at least one OS          | `R10` T-01                        | R10   |
| 8   | A mobile build runs on a physical device               | `R11` T-01/T-02                   | R11   |
| 9   | Extraction accuracy has been measured                  | `R14` benchmark                   | R14   |

If any is false, **report blocked** — do not run a pilot that will fail for known reasons.

---

## 6. Checklist

### 6.1 Pilot design

| ID     | Item                                                                                    | How to verify        | Expected                       | Type        |
| ------ | --------------------------------------------------------------------------------------- | -------------------- | ------------------------------ | ----------- |
| UAT-01 | Participant selection: ≥3 businesses, ≥5 operators, representative of the target sector | Recruit              | Documented selection rationale | **WRITE**   |
| UAT-02 | Document corpus: each participant supplies **their own** real documents                 | Collect with consent | ≥200 documents total           | **WRITE**   |
| UAT-03 | Consent and data-handling agreement signed for the pilot                                | Legal review (R21)   | Present                        | **WRITE**   |
| UAT-04 | Participants are told what the product cannot do (billing, SSO, Sheets expiry, updates) | Briefing script      | Honest briefing                | **WRITE**   |
| UAT-05 | Environment: production-like deployment, monitored                                      | Coordinate R19       | Monitored                      | **RUNTIME** |
| UAT-06 | Instrumentation: task timing, error logging, support-ticket capture                     | Set up               | All three                      | **WRITE**   |
| UAT-07 | Exit criteria defined before start                                                      | Written              | Clear pass/fail                | **WRITE**   |

### 6.2 The ten critical journeys — each executed by real operators

| ID     | Item                                                   | How to verify     | Expected                                     | Type        |
| ------ | ------------------------------------------------------ | ----------------- | -------------------------------------------- | ----------- |
| UAT-08 | **J1** Register → accept terms → first document        | Observe           | Completable unaided                          | **RUNTIME** |
| UAT-09 | **J2** Sign in with MFA (enrol, verify, recovery code) | Observe           | Completable                                  | **RUNTIME** |
| UAT-10 | **J3** Password recovery                               | Observe           | **Completable — blocked by R-02 if unfixed** | **RUNTIME** |
| UAT-11 | **J4** Pair a phone, then capture a document           | Observe           | Paired and captured                          | **RUNTIME** |
| UAT-12 | **J5** Extraction → review → correct → approve         | Observe + measure | Reviewer completes without help              | **RUNTIME** |
| UAT-13 | **J6** Export to Excel/CSV and open it                 | Observe           | Opens correctly in their spreadsheet tool    | **RUNTIME** |
| UAT-14 | **J7** Configure a connector and send a record         | Observe           | Write succeeds to _their_ system             | **RUNTIME** |
| UAT-15 | **J8** Invite a team member and assign a role          | Observe           | Works                                        | **RUNTIME** |
| UAT-16 | **J9** Data-subject export and erasure                 | Observe           | Works and is understood                      | **RUNTIME** |
| UAT-17 | **J10** Revoke a lost device / sign out everywhere     | Observe           | Works                                        | **RUNTIME** |

### 6.3 The value claim — the number that decides the business

| ID     | Item                                                                              | How to verify                 | Expected                                              | Type        |
| ------ | --------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------- | ----------- |
| UAT-18 | Measure **manual baseline**: time to retype + verify one document per participant | Stopwatch, ≥20 documents each | Minutes per document, by type                         | **RUNTIME** |
| UAT-19 | Measure **IDCP loop**: capture → extract → review → approve, same documents       | Stopwatch                     | Minutes per document, by type                         | **RUNTIME** |
| UAT-20 | **Compare including review time**                                                 | Compute                       | IDCP faster, or the premise fails — report either way | **RUNTIME** |
| UAT-21 | Measure the **error rate** both ways                                              | Count errors                  | IDCP lower, or report                                 | **RUNTIME** |
| UAT-22 | Measure **no-correction export rate** on participants' own documents              | Count untouched exports       | A single number (coordinate R14)                      | **RUNTIME** |
| UAT-23 | Measure accuracy **by document type**                                             | Segment                       | Identify which types are viable today                 | **RUNTIME** |
| UAT-24 | Compute the labour saving per 1 000 documents                                     | Derive                        | A number usable in a sales conversation               | **WRITE**   |
| UAT-25 | Identify the **document types that should not be sold yet**                       | From UAT-23                   | An exclusion list                                     | **WRITE**   |

### 6.4 Failure-mode acceptance

| ID     | Item                                            | How to verify              | Expected                                         | Type        |
| ------ | ----------------------------------------------- | -------------------------- | ------------------------------------------------ | ----------- |
| UAT-26 | Backend unavailable during working hours        | Stop it mid-session        | Operators continue capturing; queue drains later | **RUNTIME** |
| UAT-27 | Document stuck in `processing`                  | Observe or simulate        | Operator knows what to do (R18 runbook)          | **RUNTIME** |
| UAT-28 | Connector write fails                           | Simulate                   | Operator understands and retries                 | **RUNTIME** |
| UAT-29 | Phone loses network mid-capture                 | Airplane mode              | No data loss                                     | **RUNTIME** |
| UAT-30 | Wrong document type classified                  | Feed an ambiguous document | Recoverable in review                            | **RUNTIME** |
| UAT-31 | Operator makes a mistake (approves wrong value) | Observe                    | Correctable, and auditable                       | **RUNTIME** |

### 6.5 Support readiness

| ID     | Item                                                                                | How to verify  | Expected          | Type        |
| ------ | ----------------------------------------------------------------------------------- | -------------- | ----------------- | ----------- |
| UAT-32 | Every support ticket is logged with a taxonomy                                      | Pilot          | A real ticket set | **WRITE**   |
| UAT-33 | First-line runbooks exist for the top 5 ticket types                                | Coordinate R18 | Present           | **WRITE**   |
| UAT-34 | Response-time expectation is set and met                                            | Track          | Measured          | **RUNTIME** |
| UAT-35 | Onboarding materials exist (a one-page guide per role)                              | Create         | Present           | **WRITE**   |
| UAT-36 | An onboarding session can take a new operator to first approved document in <30 min | Run it         | Achieved          | **RUNTIME** |

### 6.6 Commercial readiness

| ID     | Item                                                                    | How to verify   | Expected                                                                                        | Type        |
| ------ | ----------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------- | ----------- |
| UAT-37 | Enumerate **everything that blocks a first paying customer**            | Assess          | A complete list (billing, installer, recovery email, licence, placeholders, Sheets, MFA policy) | **WRITE**   |
| UAT-38 | Determine the pricing input: cost per 1 000 documents (coordinate R17)  | Compute         | A number                                                                                        | **WRITE**   |
| UAT-39 | Determine willingness to pay: what did participants say they would pay? | Interview       | Recorded range                                                                                  | **WRITE**   |
| UAT-40 | Identify the top 3 objections raised and whether each is fixable        | Interview       | A ranked list                                                                                   | **WRITE**   |
| UAT-41 | Determine which sector is the best first market                         | Segment results | A recommendation                                                                                | **WRITE**   |
| UAT-42 | Confirm the self-serve path (signup → paid) exists                      | Test            | **It does not** — record honestly                                                               | STATIC      |
| UAT-43 | Confirm the product does not require a consultant to configure          | Observe         | Or price the service                                                                            | **RUNTIME** |
| UAT-44 | Confirm support cost per customer is estimable from the pilot           | From UAT-032    | A number                                                                                        | **WRITE**   |

### 6.7 Measured experience (validated instruments)

| ID     | Item                                                      | How to verify    | Expected                               | Type        |
| ------ | --------------------------------------------------------- | ---------------- | -------------------------------------- | ----------- |
| UAT-45 | SUS score per participant                                 | Questionnaire    | ≥68 average (industry "above average") | **RUNTIME** |
| UAT-46 | Task success rate per journey                             | Count            | ≥80 % unaided                          | **RUNTIME** |
| UAT-47 | Time-on-task per journey                                  | Measure          | Recorded                               | **RUNTIME** |
| UAT-48 | Error-recovery success                                    | Observe failures | Operators recover unaided              | **RUNTIME** |
| UAT-49 | Exit interviews: what would stop them using it?           | Interview        | Recorded                               | **WRITE**   |
| UAT-50 | Net recommendation (would they recommend it / pay for it) | Ask              | Recorded                               | **WRITE**   |

---

## 7. Known risks that will surface in a pilot

| Risk                 | Expected symptom                                                  |
| -------------------- | ----------------------------------------------------------------- |
| **R-01**             | Cannot sign in on the packaged app — pilot cannot start           |
| **R-02**             | A participant locked out after forgetting a password              |
| R-04                 | Deployment instability if PostgreSQL is used                      |
| **R-07 (`CON-002`)** | Sheets destination stops working after ~1 hour                    |
| R-14                 | Extraction accuracy varies wildly by document type; some unusable |
| R-12                 | Batch uploads slow or failing under real volume                   |
| R-21                 | Cannot legally onboard a paying customer (placeholders, licence)  |
| —                    | No billing: cannot convert the pilot into revenue                 |

---

## 8. Questions you must answer

1. **Is IDCP faster than retyping, including review time?** Show the numbers.
2. What fraction of _their own_ documents export with **no correction**?
3. Which document types should not be sold yet?
4. What did participants say would stop them adopting it?
5. What would they pay, and what does it cost to serve them?
6. What exactly blocks the first invoice?
7. What does an operator do when the system fails at 4 p.m. on a Friday?

---

## 9. Commands to run

```bash
# ---------- bring up a clean checkout first (every brief starts the same way) ----------
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund          # ~940 packages
cp .env.example .env                 # if absent, create per ENVIRONMENT.md
npm run db:migrate && npm run db:seed
npm run verify                       # suite green: 406 tests / 30 suites

# ---------- verify preconditions BEFORE recruiting ----------
# R-01: launch the PACKAGED app and sign in
apps/desktop/release/IDCP.AppImage   # or installed binary — must reach the API
# R-02: request a reset and confirm delivery
curl -s -X POST http://<host>/api/v1/auth/password/forgot \
  -H 'content-type: application/json' -d '{"email":"pilot@example.com"}'
#   → check the operator console/mail trap for the link
# R-14: benchmark numbers available
cat docs/reviewers/evidence/R14/benchmark-report.md

# ---------- production-like deployment ----------
docker compose up -d                 # from R19's compose file
curl -s http://<host>/api/v1/health | jq
# monitoring: confirm dashboards + alerts are live (R18/R19)

# ---------- measurement harness ----------
# A spreadsheet per participant with columns:
#   document_id | type | manual_seconds | icdp_capture_s | icdp_review_s | corrections | errors_manual | errors_icdp | exported_uncorrected
# and a stopwatch protocol: manual run first, then IDCP run, same 20 documents, alternating order to avoid bias

# ---------- ticket capture ----------
# A shared sheet: timestamp | participant | journey | severity | symptom | resolution | runbook_used
```

---

## 10. Tests to perform

| #    | Test                      | Procedure                | Pass criterion                    |
| ---- | ------------------------- | ------------------------ | --------------------------------- |
| T-01 | Precondition audit        | All 9 preconditions      | All true, or report blocked       |
| T-02 | Ten journeys              | 5 operators, observed    | Task success recorded per journey |
| T-03 | Manual vs IDCP timing     | Same documents both ways | Compared numbers                  |
| T-04 | No-correction rate        | Their own documents      | A percentage                      |
| T-05 | Accuracy by document type | Segment                  | A table                           |
| T-06 | Failure-mode acceptance   | 6 scenarios              | Operators recover                 |
| T-07 | SUS                       | Questionnaire            | Score recorded                    |
| T-08 | Onboarding                | New operator, unaided    | First approved doc <30 min        |
| T-09 | Support load              | Ticket log               | Tickets per participant per week  |
| T-10 | Commercial interviews     | Structured               | Objections + willingness to pay   |
| T-11 | Exit criteria check       | Against UAT-07           | Pass/fail per criterion           |

---

## 11. Evidence required

```
docs/reviewers/evidence/R22/
├── preconditions.md             # the 9 gates with evidence links
├── pilot-design.md              # participants, consent, corpus, exit criteria
├── journey-results.md           # T-02 per journey per participant
├── value-comparison.md          # T-03, T-04, T-05 — the business case numbers
├── failure-acceptance.md        # T-06
├── sus-results.md               # T-07
├── support-tickets.csv          # the real ticket set + taxonomy
├── onboarding-pack/             # one-pager per role
├── commercial-assessment.md     # UAT-37 … UAT-44 + interviews
├── go-no-go.md                  # the recommendation with reasoning
├── commands.log
└── findings.md                  # UAT-### register
```

---

## 12. Passing conditions (chairs G9; co-signs G2, G7)

- [ ] **P1** All 9 preconditions verified before the pilot began (UAT preconditions, T-01).
- [ ] **P2** All ten journeys executed by real operators with task-success recorded (UAT-08 … UAT-17, T-02).
- [ ] **P3** **The value claim is measured and positive** — IDCP is faster than retyping including review time (UAT-18 … UAT-20, T-03).
- [ ] **P4** The no-correction export rate is measured and meets the agreed threshold (UAT-22, T-04).
- [ ] **P5** Document types that are not ready are identified and excluded from sales (UAT-23, UAT-25, T-05).
- [ ] **P6** Failure modes are acceptable to real operators (UAT-26 … UAT-31, T-06).
- [ ] **P7** SUS ≥68 average or a remediation plan exists (UAT-45, T-07).
- [ ] **P8** Support runbooks and an onboarding pack exist and were used (UAT-32 … UAT-36, T-08, T-09).
- [ ] **P9** The complete list of blockers to a first paying customer is documented and owned (UAT-37, T-10).
- [ ] **P10** A go/no-go recommendation is written with explicit reasoning (UAT-49, UAT-50, §14).

**If P3 is false, the honest recommendation is: do not launch.** The product would be a slower way to do the
same work.

---

## 13. Blocked items

| Item ID        | Blocker                                | What unblocks it                | Owner |
| -------------- | -------------------------------------- | ------------------------------- | ----- |
| ALL            | **R-01** — packaged app cannot sign in | R09/R10 fix                     | R10   |
| UAT-10         | **R-02** — no mail transport           | R19                             | R19   |
| UAT-11, UAT-29 | No mobile build                        | R11                             | R11   |
| UAT-14         | Live destination credentials           | R15 + participant's own systems | R15   |
| UAT-42         | No billing                             | Owner decision                  | Owner |

---

## 14. Findings register

| ID      | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
| ------- | -------- | --------- | ------- | -------------- | --------- | ------------- | ----- |
| UAT-001 |          |           |         |                |           |               |       |

---

## 15. Reviewer sign-off and recommendation

| Field                      | Value                                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewer name              |                                                                                                                                                                                                          |
| Date started               |                                                                                                                                                                                                          |
| Date completed             |                                                                                                                                                                                                          |
| **Gate G9 result**         | ☐ Pass ☐ Fail                                                                                                                                                                                            |
| **G2 co-sign result**      | ☐ Pass ☐ Fail ☐ Abstain                                                                                                                                                                                  |
| **G7 co-sign result**      | ☐ Pass ☐ Fail ☐ Abstain                                                                                                                                                                                  |
| Preconditions met          | /9                                                                                                                                                                                                       |
| Participants / operators   | /                                                                                                                                                                                                        |
| Manual time per document   |                                                                                                                                                                                                          |
| IDCP time per document     |                                                                                                                                                                                                          |
| **Value verdict**          | ☐ Faster ☐ Equal ☐ Slower                                                                                                                                                                                |
| No-correction rate         |                                                                                                                                                                                                          |
| Average SUS                |                                                                                                                                                                                                          |
| Blockers to first customer |                                                                                                                                                                                                          |
| **Recommendation**         | ☐ Launch ☐ Launch with exclusions ☐ **Do not launch**                                                                                                                                                    |
| Reasoning (2–3 sentences)  |                                                                                                                                                                                                          |
| Reviewed commit            | `43d384b`                                                                                                                                                                                                |
| Statement                  | _I observed real operators using the packaged product on their own documents, measured the manual baseline as well as the IDCP loop, and I report the comparison whether or not it favours the product._ |
| Signature                  |                                                                                                                                                                                                          |
