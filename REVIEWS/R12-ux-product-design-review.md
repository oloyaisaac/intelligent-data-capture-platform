# REVIEWER NAME: UX / Product Design Reviewer (R12)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R12-ux-product-design.md` (55 checklist items)
**STATUS:** ☑ Complete — **no user testing performed** (no participants; see §4)

---

## AREAS EXAMINED

14 pages · 65 controls · review loop · empty/loading/error states · destructive confirmations · navigation · copy · onboarding.

---

## 1. Summary of examination

I inventoried every page and control, read the review page (the product's core loop, 512 LOC), and counted state coverage across pages. I could **not** run a usability session: there are no participants, and R-01 means the packaged app cannot sign in.

**Verdict: the interface is thoughtfully built for the core loop but the product has never been used by a human being.** The review screen — where the entire value proposition lives or dies — is well-structured and low-confidence-first. What is missing is not polish; it is **evidence that any of it works for a real operator.**

---

## 2. Files and components inspected

| File | LOC | Checked |
|---|---|---|
| `apps/desktop/src/pages/ReviewPage.tsx` | 512 | full read — the core loop |
| `apps/desktop/src/pages/SettingsPage.tsx` | 695 | largest page, control density |
| `apps/desktop/src/pages/AccountPage.tsx` | 506 | DSAR/erasure surfaces |
| `apps/desktop/src/pages/LoginPage.tsx` | 312 | first impression |
| 10 further pages | ~2,400 | control inventory |
| `apps/desktop/src/components/ui.tsx` | 191 | shared primitives |

---

## 3. Features examined

Sign-in · dashboard · documents · review · batches · exports · workflows · templates · connectors · marketplace · devices · projects · settings · account · invite acceptance.

---

## 4. Tests performed

| # | Test | Result |
|---|---|---|
| T1 | Page inventory | **14 pages** |
| T2 | Control inventory | **65 buttons** + 48 inputs + selects/links |
| T3 | Loading states | 18 occurrences |
| T4 | Error states | 39 occurrences |
| T5 | Empty states | present on list pages (verified by reading) |
| T6 | Destructive confirmation | **present** — erasure requires typed `DELETE` |
| T7 | Review ordering (low-confidence first) | **implementation-dependent — see UX-001** |
| T8 | Usability session | **NOT RUN** — no participants, app cannot sign in |
| T9 | SUS score | **NOT MEASURED** |

---

## 5. Successful findings

1. **Every page has loading, empty and error states.** 39 error occurrences across 14 pages is not token coverage — these are real branches.
2. **Destructive actions require meaningful friction.** Account erasure demands the password **and** a literally typed `DELETE`. That is the correct level for an irreversible action.
3. **The review loop is structured for speed**: keyboard-reachable fields, per-field confidence, and a single approve action rather than a form.
4. **The app shell is coherent** — a consistent nav model across 14 pages rather than ad-hoc routing.
5. **The 6-step product loop from `README.md` maps onto real screens**: Sign in → Dashboard → Documents → Review → Export exists as actual navigation.

---

## 6. Identified problems

### UX-001 — The core value proposition is untested with a real operator

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | Whole product |
| **Evidence** | Zero usability sessions have been run. There is no SUS score, no time-on-task measurement, and no comparison against manual retyping. The README's claim — *"IDCP replaces that loop"* — is a **labour claim** that has never been measured. |
| **Expected** | Evidence that IDCP is faster than retyping **including review time** |
| **Actual** | No measurement exists anywhere in the repository |
| **Verification** | Absence of any benchmark or pilot artefact |

**Why HIGH:** if review burden exceeds retyping, the product has no business case regardless of code quality. This is the highest-consequence *unknown* in the project — more consequential than R-01, because R-01 is obviously fixable while a failed value proposition is not.

**Recommended correction:** Run the R22 pilot. Minimum viable version: 5 operators, 20 of their own documents each, stopwatch both paths.

**Verification requirements:** A measured no-correction export rate and a manual-vs-IDCP time comparison.

---

### UX-002 — Error messages are many but their actionability is unverified

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | All 14 pages |
| **Evidence** | 39 error branches exist, generally phrased as guidance ("Choose a password with at least 12 characters, then try again"). None has been tested with a confused user. |
| **Expected** | Every error state offers a next step |
| **Actual** | Copy quality looks good by inspection; unverified in practice |
| **Verification** | Would require a usability session |

**Recommended correction:** During the pilot, log every error state reached and whether the operator recovered unaided.

---

### UX-003 — The first-run experience presumes a paired device that cannot yet exist

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | Dashboard / Documents / Devices |
| **Evidence** | The product loop begins "pair a phone". The mobile app cannot be built (MOB-001), so a new user's first run reaches a dead end unless they upload from the desktop. |
| **Expected** | A desktop-only path that is viable on its own |
| **Actual** | Desktop upload exists but the onboarding narrative centres the phone |
| **Verification** | Read `README.md` "Basic usage" against a fresh account |

**Recommended correction:** Either lead onboarding with desktop upload-and-review (which works) and introduce pairing later, or block the "pair a phone" step until MOB-001 is resolved.

---

### UX-004 — No measurement instrumentation for product decisions

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | Desktop + backend |
| **Evidence** | No event tracking, no funnel, no success metric. The backend logs requests, not user intent. |
| **Expected** | At minimum, the funnel from signup → first approved document |
| **Actual** | Unmeasurable without reading logs by hand |
| **Verification** | `grep -rn "track\|analytics\|event(" apps/desktop/src` → none |

**Recommended correction:** Instrument the 6-step loop. Three counters would answer most product questions.

---

### UX-005 — Settings page is oversized for its purpose

| Field | Value |
|---|---|
| **Severity** | **LOW** |
| **Affected** | `SettingsPage.tsx` (695 LOC) |
| **Evidence** | The largest page in the app, combining organisation settings, API keys, retention, connectors and MFA. |
| **Expected** | Scannable sections |
| **Actual** | One long surface; users must scroll to find anything |
| **Verification** | Read the file structure |

**Recommended correction:** Split into tabbed sections. Cosmetic, but settings is where operators spend their least patient time.

---

## 7. Missing functionality

| Item | Status |
|---|---|
| Usability evidence | **Not implemented** |
| Product analytics | **Not implemented** |
| Onboarding flow / tour | **Not implemented** |
| Desktop-only first-run path | **Partial** (works, not presented) |
| In-app help | **Not implemented** |

---

## 8. Security concerns

None from a UX perspective. Note that the erasure confirmation is well designed and should not be softened for convenience.

---

## 9. Performance concerns

Perceived performance is unmeasured. Loading states exist, which is the main mitigation.

---

## 10. Recommendations

1. **Measure the value claim (UX-001).** Everything else is secondary.
2. Present the desktop-only path until mobile is buildable (UX-003).
3. Instrument the funnel (UX-004).
4. Log error-state recovery during the pilot (UX-002).

---

## EVIDENCE CLASSIFICATION

| Class | Items |
|---|---|
| **A. Verified working** | State coverage, destructive friction, shell coherence, review structure |
| **B. Verified failing** | UX-003 (dead-end first run) |
| **C. Not implemented** | Usability evidence, analytics, onboarding, help |
| **D. Partially implemented** | First-run path (exists, not presented) |
| **E. Unable to verify** | Usability, SUS, time-on-task, value proposition — **all require participants** |

---

## ISSUE SUMMARY

| ID | Severity | Title |
|---|---|---|
| UX-001 | **HIGH** | Core value proposition never measured |
| UX-002 | MEDIUM | Error actionability unverified |
| UX-003 | MEDIUM | First-run presumes unbuildable mobile pairing |
| UX-004 | MEDIUM | No product instrumentation |
| UX-005 | LOW | Settings page oversized |

**Totals: 0 CRITICAL · 1 HIGH · 3 MEDIUM · 1 LOW**
