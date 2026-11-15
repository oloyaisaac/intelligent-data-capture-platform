# REVIEWER 12 — UX / PRODUCT DESIGN REVIEWER

| Field              | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| **Reviewer ID**    | R12                                                                |
| **Title**          | UX / Product Design Reviewer                                       |
| **Board**          | C — Client platforms & experience                                  |
| **Wave**           | 3 (weeks 3–5)                                                      |
| **Effort**         | 8 person-days                                                      |
| **Gate chaired**   | **G7 — UI/UX & accessibility approval**                            |
| **Co-signs**       | G9                                                                 |
| **Finding prefix** | `UX-###`                                                           |
| **Upstream**       | R09 (renderer behaviour), R11 (mobile behaviour)                   |
| **Downstream**     | R22 (pilot), R13                                                   |
| **Status**         | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Determine whether a real operator can complete the product's core loop — **pair a phone → capture → review →
approve → export/send** — without training, and whether the interface tells the truth about what the system
is doing. You are the reviewer who answers: _"would a customer actually be able to use this?"_

**The product's entire commercial premise rests here.** The differentiator is not the OCR; it is that a human
confirms uncertain values quickly. If review takes longer than retyping, the product has no business case —
and that is measurable, not aesthetic.

**Specific to this repository.** The interface is unusually complete for its stage: 12 desktop pages, 5 mobile
screens, three languages, 647 translation keys. `AUDIT-2026-10.md` §1.1 claims _"every button, link and menu
entry does something — no placeholders, no 'coming soon' dialogs"_. Verify that independently. But also verify
the inverse: **does the UI imply capabilities that do not exist?** There is no billing, no SSO, no email
delivery, and no working auto-update.

---

## 2. Required expertise

- Interaction design for data-entry / verification workflows
- Information architecture and navigation design
- Error, empty, loading and partial-failure state design
- Destructive-action safety and confirmation patterns
- Task analysis and usability testing facilitation
- Product honesty: aligning UI affordances with real system capability

---

## 3. Repository context (self-contained)

**Product.** IDCP turns photographed business documents into clean records. Users are data-entry staff,
operations managers and small-business owners. The loop:

```
Phone camera → AI extraction → Human review → Business system
  (capture)     (structure)      (approve)      (Excel/Sheets/SQL/CRM)
```

**Surfaces to review:**

| Surface                        | Count                               | Where                                                                 |
| ------------------------------ | ----------------------------------- | --------------------------------------------------------------------- |
| Desktop pages                  | 12 + 2 (accept-invite, marketplace) | `apps/desktop/src/pages/*.tsx`, `src/marketplace/MarketplacePage.tsx` |
| Desktop components             | 2                                   | `src/components/{ui,SendToDestination}.tsx`                           |
| Desktop navigation             | sidebar sections                    | `src/App.tsx` `NAV` array                                             |
| Mobile screens                 | 5                                   | `apps/mobile/src/screens/*.tsx`                                       |
| Design tokens                  | 1                                   | `apps/desktop/src/styles.css` (621)                                   |
| Shared confidence/review rules | 1                                   | `packages/shared/src/review.ts` (148)                                 |
| Thresholds                     | 1                                   | `packages/shared/src/constants.ts`                                    |

**Known product limits the UI must not misrepresent:**

| Limit                | Reality                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Billing / plans      | `organisations.plan` is a free-text column; **no billing exists**                               |
| SSO / SAML           | absent                                                                                          |
| Password-reset email | **no mail transport exists** (R-02)                                                             |
| Auto-update          | `idcp:updates:check` returns a hardcoded `up_to_date`; publish URL is `updates.example.invalid` |
| Google Sheets        | destination dies ~1 h after a pasted token (`CON-002`)                                          |
| MFA enforcement      | self-service only; an organisation cannot require it                                            |
| Workflow branching   | one AND-list only; `notify` records an output, sends nothing                                    |
| RTL languages        | no RTL catalogue ships                                                                          |
| Voice                | unavailable unless native speech modules are installed                                          |

---

## 4. Exact files and components to examine

### 4.1 Desktop (all pages, in this order — the user's order)

1. `pages/LoginPage.tsx` (312) — sign-in, register, forgot, reset, MFA challenge
2. `App.tsx` (368) — shell, navigation, boot, session expiry
3. `pages/DashboardPage.tsx` (320) — first screen after login
4. `pages/DevicesPage.tsx` (168) — pairing
5. `pages/DocumentsPage.tsx` (284) — the list
6. `pages/ReviewPage.tsx` (512) — **the core screen**
7. `components/SendToDestination.tsx` (220)
8. `pages/ExportsPage.tsx` (161)
9. `pages/BatchesPage.tsx` (255)
10. `pages/ConnectorsPage.tsx` (231)
11. `pages/TemplatesPage.tsx` (353)
12. `pages/WorkflowsPage.tsx` (519)
13. `pages/MarketplacePage.tsx` (235)
14. `pages/ProjectsPage.tsx` (139)
15. `pages/SettingsPage.tsx` (695)
16. `pages/AccountPage.tsx` (506)
17. `pages/AcceptInvitePage.tsx` (94)
18. `components/ui.tsx` (191) — buttons, modal, table primitives
19. `styles.css` (621) — tokens, spacing, focus states

### 4.2 Mobile (all screens)

`CaptureScreen.tsx` (279) · `ReviewScreen.tsx` (277) · `PairingScreen.tsx` (155) ·
`SignInScreen.tsx` (157) · `QueueScreen.tsx` (151)

### 4.3 Rules the UI must reflect faithfully

`packages/shared/src/review.ts` (confidence thresholds, low-confidence ordering) ·
`packages/shared/src/constants.ts` (`LIMITS`, thresholds) · `packages/shared/src/i18n.ts` (647 keys)

### 4.4 Explicit non-goals

WCAG conformance and keyboard/screen-reader testing → R13 · component correctness and dead controls → R09 ·
API errors → R02 · value measurement in a pilot → R22.

---

## 5. Upstream artefacts required

| From | Artefact                             | Why                                                                        |
| ---- | ------------------------------------ | -------------------------------------------------------------------------- |
| R09  | `evidence/R09/control-inventory.csv` | A verified list of every control; you review meaning, R09 reviews function |
| R09  | `evidence/R09/page-states.md`        | Loading/empty/error states already catalogued                              |

---

## 6. Checklist

### 6.1 The core journey

| ID    | Item                                                                     | How to verify                                        | Expected                                                | Type        |
| ----- | ------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------- | ----------- |
| UX-01 | Execute the full loop unaided, on a packaged build, from a clean account | Sign up → pair → capture → review → approve → export | Completable without documentation                       | **RUNTIME** |
| UX-02 | Count clicks and time for each step                                      | Instrument the run                                   | `evidence/R12/journey-metrics.md` with baseline numbers | **RUNTIME** |
| UX-03 | Identify every dead end                                                  | Walk every branch                                    | None, or listed                                         | **RUNTIME** |
| UX-04 | First-run experience: does a new user know what to do first?             | Clean install                                        | Instructive empty state for pairing                     | **RUNTIME** |
| UX-05 | Is pairing discoverable from the dashboard?                              | Look                                                 | Primary call-to-action present                          | STATIC      |
| UX-06 | After pairing, is the next action obvious?                               | Continue the run                                     | Yes                                                     | **RUNTIME** |

### 6.2 The review screen (highest-value surface)

| ID    | Item                                                                          | How to verify                            | Expected                              | Type        |
| ----- | ----------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------- | ----------- |
| UX-07 | Low-confidence fields are surfaced **first**                                  | Read `ReviewPage` ordering + `review.ts` | Confirmed and explained to the user   | STATIC      |
| UX-08 | Confidence is communicated non-numerically and meaningfully                   | Look for colour/label usage              | Understandable without a legend       | STATIC      |
| UX-09 | The image is zoomable/pannable enough to verify a value                       | Try on a dense invoice                   | Usable                                | **RUNTIME** |
| UX-10 | Field focus makes correction fast                                             | Tab → type → next field                  | No mouse round-trips                  | **RUNTIME** |
| UX-11 | Approving with unresolved low-confidence fields is deliberate, not accidental | Try it                                   | Guarded or clearly intentional        | **RUNTIME** |
| UX-12 | The document type is visible and editable where needed                        | Look                                     | Present (`REV-002` correction typing) | STATIC      |
| UX-13 | Bulk approve communicates exactly what will be skipped                        | Mixed selection                          | Explicit list before confirming       | **RUNTIME** |
| UX-14 | A reviewer can tell who approved what and when                                | Look for metadata                        | Present                               | STATIC      |
| UX-15 | Reviewing 20 documents in a row does not require repeating setup              | Test the batch flow                      | Efficient                             | **RUNTIME** |

### 6.3 Error, empty and partial states

| ID    | Item                                                       | How to verify                      | Expected                 | Type        |
| ----- | ---------------------------------------------------------- | ---------------------------------- | ------------------------ | ----------- |
| UX-16 | Every page has a designed empty state that teaches         | Visit with no data                 | Present and instructive  | **RUNTIME** |
| UX-17 | Every page has a loading state (not a blank flash)         | Throttle the network               | Skeleton/spinner         | **RUNTIME** |
| UX-18 | 401 shows a sign-in prompt, not a raw error                | Expire the token                   | Clear action             | **RUNTIME** |
| UX-19 | 403 explains _why_, not just "forbidden"                   | Use a `viewer` for an admin action | Role-appropriate wording | **RUNTIME** |
| UX-20 | 429 explains the wait                                      | Trigger a rate limit               | "Try again in N"         | **RUNTIME** |
| UX-21 | 500 offers a retry and a reference id                      | Force an error                     | Actionable               | **RUNTIME** |
| UX-22 | A failed connector run is explained in domain language     | Break a connector                  | Not a stack trace        | **RUNTIME** |
| UX-23 | A document stuck in `processing` tells the user what to do | Simulate                           | Guidance                 | **RUNTIME** |
| UX-24 | Offline/degraded realtime is visible                       | Stop the backend                   | Banner/state change      | **RUNTIME** |
| UX-25 | Validation errors point at the field                       | Submit an invalid form             | Inline, field-level      | **RUNTIME** |

### 6.4 Destructive and irreversible actions

| ID    | Item                                                                           | How to verify   | Expected                    | Type   |
| ----- | ------------------------------------------------------------------------------ | --------------- | --------------------------- | ------ |
| UX-26 | Every destructive action is confirmed with consequences stated                 | Sweep all pages | Plain-language consequences | STATIC |
| UX-27 | Erasure requires typing `DELETE` and the password                              | `AccountPage`   | Matches API                 | STATIC |
| UX-28 | Erasure explains the multi-owner refusal **before** the user tries             | Read the copy   | Pre-emptive                 | STATIC |
| UX-29 | "Sign out everywhere" explains the effect on other devices                     | Read the copy   | Clear                       | STATIC |
| UX-30 | Device revoke explains what stops working                                      | Read            | Clear                       | STATIC |
| UX-31 | No destructive action is adjacent to a primary action without spacing/guarding | Sweep           | Safe layout                 | STATIC |

### 6.5 Honesty of the interface (product integrity)

| ID    | Item                                                            | How to verify                      | Expected                                                     | Type   |
| ----- | --------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------ | ------ |
| UX-32 | Nothing promises billing/upgrades that do not exist             | Search for plan/upgrade/pricing UI | Absent or honest                                             | STATIC |
| UX-33 | Nothing promises SSO/enterprise auth                            | Search                             | Absent                                                       | STATIC |
| UX-34 | The password-reset screen is honest about delivery              | Read the copy                      | **Tells the user what to do** given no mail transport (R-02) | STATIC |
| UX-35 | The update check does not claim an update exists                | Read UI around `checkForUpdates`   | Honest                                                       | STATIC |
| UX-36 | Google Sheets setup warns that the token expires                | Read the connector form            | Warning present, or record the gap (`CON-002`)               | STATIC |
| UX-37 | "Notify" in workflows does not imply delivery                   | Read the workflow copy             | Honest                                                       | STATIC |
| UX-38 | Voice features do not appear available when modules are missing | Mobile + desktop                   | Hidden or disabled with explanation                          | STATIC |
| UX-39 | MFA is presented as optional, not mandatory                     | Read the copy                      | Accurate                                                     | STATIC |
| UX-40 | No "coming soon", `href="#"` or dead menu item                  | Sweep                              | Zero                                                         | STATIC |

### 6.6 Consistency

| ID    | Item                                                                | How to verify                     | Expected                     | Type        |
| ----- | ------------------------------------------------------------------- | --------------------------------- | ---------------------------- | ----------- |
| UX-41 | Terminology is consistent (destination vs connector vs integration) | Grep UI strings                   | One term per concept         | STATIC      |
| UX-42 | Dates, times and numbers use the locale formatter                   | Check `lib/format.ts` usage       | Consistent                   | STATIC      |
| UX-43 | Button hierarchy is consistent across pages                         | Compare                           | Primary/secondary consistent | STATIC      |
| UX-44 | Table behaviours are consistent (sort, filter, pagination)          | Compare Documents/Exports/Batches | Consistent                   | STATIC      |
| UX-45 | Error wording style is consistent                                   | Compare pages                     | Consistent                   | STATIC      |
| UX-46 | Navigation state is always recoverable (back/refresh keeps place)   | Test                              | Preserved                    | **RUNTIME** |

### 6.7 Mobile UX

| ID    | Item                                                   | How to verify | Expected                                | Type        |
| ----- | ------------------------------------------------------ | ------------- | --------------------------------------- | ----------- |
| UX-47 | Capture is one tap from launch                         | Use the app   | ≤2 taps                                 | **RUNTIME** |
| UX-48 | The capture screen guides the user (framing, distance) | Use it        | Guidance present                        | STATIC      |
| UX-49 | Queue state is understandable at a glance              | `QueueScreen` | Clear                                   | STATIC      |
| UX-50 | Review on a phone is usable for simple fields          | Use it        | Actually usable, not a shrunken desktop | **RUNTIME** |
| UX-51 | Sync status is visible without opening a menu          | Look          | Visible                                 | STATIC      |

### 6.8 Deliverables

| ID    | Item                                                    | Output                           | Type      |
| ----- | ------------------------------------------------------- | -------------------------------- | --------- |
| UX-52 | Annotated journey map with click counts and timings     | `evidence/R12/journey-map.md`    | **WRITE** |
| UX-53 | Heuristic evaluation (Nielsen's 10) per page            | `evidence/R12/heuristics.md`     | **WRITE** |
| UX-54 | Error-state catalogue with screenshots                  | `evidence/R12/error-states.md`   | **WRITE** |
| UX-55 | Usability test with ≥5 operators, tasks + timings + SUS | `evidence/R12/usability-test.md` | **WRITE** |

---

## 7. Known UX risks to confirm or refute

| Risk     | Statement                                                         |
| -------- | ----------------------------------------------------------------- |
| **R-01** | A packaged build cannot sign in — no journey can complete         |
| **R-02** | Password recovery cannot complete; the UI must be honest about it |
| R-13     | Performance: a slow dashboard undermines the "live" promise       |
| R-22     | Accessibility evidence is thin — co-owned with R13                |
| —        | The review burden may exceed retyping (the core commercial risk)  |

---

## 8. Questions you must answer

1. **Can a first-time user complete the loop in under 15 minutes without help?** Measure it.
2. Does the review screen actually make verification faster than retyping? Show the numbers.
3. Where does a user get stuck, and what do they do next?
4. Which control misleads about capability? (billing, updates, email, Sheets, notify, voice)
5. Is the wording consistent enough that a support agent can write one runbook?
6. What does the operator see when the backend is down, and do they lose work?

---

## 9. Commands to run

```bash
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund
npm run db:migrate && npm run db:seed
npm run dev:backend &
npm run dev:desktop &      # http://127.0.0.1:5173 — dev proxy works for journey testing
# sign in: owner@example.com / demo-password-change-me

# --- honesty sweep: strings that may over-promise ---
grep -rniE "coming soon|upgrade|pricing|billing|plan\b|sso|saml|sso" apps/desktop/src/pages apps/desktop/src/components apps/mobile/src/screens | head -30
grep -rn 'href="#"' apps/desktop/src apps/mobile/src
grep -rniE "checkForUpdates|up to date|update available" apps/desktop/src

# --- empty/loading/error state presence ---
for f in apps/desktop/src/pages/*.tsx; do
  echo "== $f"
  grep -c -iE "loading|spinner|skeleton" "$f"
  grep -c -iE "empty|no .* yet|nothing" "$f"
  grep -c -iE "error|failed|retry" "$f"
done

# --- terminology consistency ---
grep -rhoiE "destination|connector|integration" apps/desktop/src/pages | sort | uniq -c

# --- confidence presentation ---
grep -rn "confidence" apps/desktop/src/pages/ReviewPage.tsx packages/shared/src/review.ts | head -20
```

---

## 10. Tests to perform

| #    | Test                            | Procedure                            | Pass criterion                                     |
| ---- | ------------------------------- | ------------------------------------ | -------------------------------------------------- |
| T-01 | Unassisted first run            | 5 operators, no help, full loop      | ≥4/5 complete without assistance                   |
| T-02 | Time-to-first-approved-document | Measure                              | Recorded baseline; target agreed                   |
| T-03 | Review vs retyping              | 10 documents, stopwatch both methods | IDCP faster including review, or the premise fails |
| T-04 | Error injection                 | 4xx/5xx per page                     | Every state actionable                             |
| T-05 | Empty-state tour                | Every page with no data              | All instructive                                    |
| T-06 | Destructive sweep               | Attempt every destructive action     | All confirmed with consequences                    |
| T-07 | Honesty sweep                   | Enumerate false affordances          | Zero, or listed                                    |
| T-08 | Mobile journey                  | Capture → queue → review on a phone  | Completable                                        |
| T-09 | Offline journey                 | Backend down mid-work                | Clear state, no data loss                          |
| T-10 | SUS questionnaire               | 5–8 users                            | Score recorded                                     |

---

## 11. Evidence required

```
docs/reviewers/evidence/R12/
├── journey-map.md               # steps, clicks, timing, dead ends
├── heuristics.md                # Nielsen × page
├── error-states.md              # catalogue with screenshots
├── usability-test.md            # T-01 … T-04, T-10, with participants and metrics
├── honesty-sweep.md             # T-07: every affordance vs capability
├── terminology.md               # UX-41 consistency result
├── commands.log
└── findings.md                  # UX-### register
```

---

## 12. Passing conditions (chairs G7; co-signs G9)

- [ ] **P1** The full loop is completable unaided on a packaged build (UX-01, T-01).
- [ ] **P2** Journey metrics are recorded: clicks and time per step, and time-to-first-approved-document (UX-02, T-02).
- [ ] **P3** No dead ends anywhere in the flows (UX-03).
- [ ] **P4** Every page has designed empty, loading and error states with an actionable next step (UX-16 … UX-25, T-04, T-05).
- [ ] **P5** Low-confidence-first review ordering is implemented and communicated (UX-07, UX-08).
- [ ] **P6** Every destructive action is confirmed with stated consequences (UX-26 … UX-31, T-06).
- [ ] **P7** **The interface promises nothing the system cannot do** (UX-32 … UX-40, T-07).
- [ ] **P8** Terminology and table/button/error conventions are consistent (UX-41 … UX-46).
- [ ] **P9** Mobile capture and simple review are genuinely usable on a phone (UX-47 … UX-51, T-08).
- [ ] **P10** Usability testing with real operators has been run and scored (UX-55, T-01, T-10).

---

## 13. Blocked items

| Item ID | Blocker                                | What unblocks it | Owner |
| ------- | -------------------------------------- | ---------------- | ----- |
| UX-01   | Packaged build cannot sign in (R-01)   | R09/R10 fix      | R10   |
| UX-34   | No mail transport to describe honestly | R19 adds one     | R19   |
| UX-50   | Needs a real mobile build              | R11              | R11   |

---

## 14. Findings register

| ID     | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
| ------ | -------- | --------- | ------- | -------------- | --------- | ------------- | ----- |
| UX-001 |          |           |         |                |           |               |       |

---

## 15. Reviewer sign-off

| Field                   | Value                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewer name           |                                                                                                                                                                           |
| Date started            |                                                                                                                                                                           |
| Date completed          |                                                                                                                                                                           |
| **Gate G7 result**      | ☐ Pass ☐ Fail                                                                                                                                                             |
| **G9 co-sign result**   | ☐ Pass ☐ Fail ☐ Abstain                                                                                                                                                   |
| Operators tested        |                                                                                                                                                                           |
| SUS score               |                                                                                                                                                                           |
| Conditions failed (IDs) |                                                                                                                                                                           |
| Reviewed commit         | `43d384b`                                                                                                                                                                 |
| Statement               | _I completed the full journey unaided on a packaged build, measured every step, ran usability tests with real operators, and swept every control for capability honesty._ |
| Signature               |                                                                                                                                                                           |
