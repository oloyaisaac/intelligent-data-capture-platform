# REVIEWER NAME: Accessibility & Internationalisation Reviewer (R13)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R13-accessibility-i18n.md` (60 checklist items)
**STATUS:** ☑ Complete — **no assistive-technology testing** (no NVDA, no VoiceOver, no display)

---

## AREAS EXAMINED

647 i18n keys × 3 locales · RTL support · `dir` wiring · ARIA usage · form labelling · focus management · keyboard access · colour/contrast · axe-core.

---

## 1. Summary of examination

I parsed the i18n catalogue programmatically (brace-matching rather than regex, to avoid the counting trap that defeated a naive grep), verified key parity across locales, checked RTL wiring, and inventoried every ARIA attribute and form control.

**Verdict: internationalisation is genuinely well executed — exact 647-key parity across three locales, RTL infrastructure that works, and no hardcoded strings. Accessibility is well-intentioned and materially incomplete: the primitives are right but there is no automated check and the dialog focus trap is missing.**

Two of my initial hypotheses were wrong and I corrected them during the review — see §4 T3 and T5.

---

## 2. Files and components inspected

| File | Checked |
|---|---|
| `packages/shared/src/i18n.ts` | 2,105 LOC — parsed programmatically |
| `apps/desktop/src/lib/locale.tsx` | provider, direction |
| `apps/desktop/src/App.tsx:258` | `dir={direction}` |
| `apps/desktop/src/components/ui.tsx` | `Field`, `Modal` |
| `apps/desktop/src/styles.css` | 621 LOC — focus, motion |
| 14 pages | ARIA inventory |

---

## 3. Features examined

Translation coverage · locale switching · RTL layout · screen-reader structure · keyboard navigation · focus visibility · motion preference · semantic markup.

---

## 4. Tests performed

| # | Test | Result |
|---|---|---|
| T1 | Key parity across locales | **PASS** — `en` 647, `sw` 647, `fr` 647, **0 drift either direction** |
| T2 | Hardcoded strings in components | **PASS** — all via `t()` |
| T3 | ~~"No RTL support"~~ → **corrected** | **PASS** — `dir={direction}` at `App.tsx:258`; `directionFor()` handles 13 RTL languages |
| T4 | ARIA attribute inventory | 20 `aria-*`, 22 `role=`, 1 `alt=` |
| T5 | ~~"Inputs unlabelled"~~ → **corrected** | **PASS (mostly)** — `Field` uses implicit `<label>` wrapping; 0 `htmlFor` is a style choice, not a defect |
| T6 | `aria-live` regions | **FAIL — 0 occurrences** |
| T7 | `prefers-reduced-motion` | **FAIL — 0 occurrences** |
| T8 | Focus visibility | **PASS** — 6 `focus-visible` rules |
| T9 | Modal focus trap | **FAIL** — cross-ref DESK-003 |
| T10 | axe-core / automated a11y | **FAIL — not installed, no suite** |
| T11 | Screen reader pass (NVDA/VoiceOver) | **NOT RUN** |
| T12 | Contrast measurement | **NOT RUN** — no display |

---

## 5. Successful findings

1. **Exact 647-key parity across `en`, `sw`, `fr`** with zero missing and zero stray keys in either direction. I verified this by brace-matching each catalogue object — a regex count returns 0 on this file, which is a trap worth recording.
2. **`directionFor()` covers 13 RTL languages** (`ar, arc, ckb, dv, fa, he, iw, ks, ps, sd, ug, ur, yi`) and returns `ltr`/`rtl` from the primary subtag, handling `ar-EG` and `ar_EG` correctly.
3. **`dir` is applied once at the root**, so one layout serves both directions — the correct approach, documented as DEC-028.
4. **Zero hardcoded user-facing strings** in components; everything flows through `t()`.
5. **Focus visibility is handled** with 6 `focus-visible` rules — keyboard users see where they are.
6. **The translator falls back gracefully**: missing key → English → the key itself, so a partial catalogue never crashes a screen (`i18n.ts:2088-2090`).

---

## 6. Identified problems

### A11Y-001 — No live region: asynchronous content is invisible to screen readers

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | All 14 pages; realtime layer |
| **Evidence** | `grep -rho 'aria-live' apps/desktop/src` → **0**. The app receives SSE events (document processed, review assigned) and updates lists and counters visually with no announcement. |
| **Expected** | `role="status"`/`aria-live="polite"` for arrivals and completion counts |
| **Actual** | Screen-reader users receive no notification that anything changed |
| **Verification** | grep; read `lib/realtime.ts` event handlers — none touches a live region |

**Why HIGH:** the product's workflow is asynchronous by design. A blind reviewer who approves a document is never told the next one is ready. This makes the core loop unusable with a screen reader, regardless of how many ARIA attributes exist elsewhere.

**Recommended correction:** Add a persistent, visually-hidden `aria-live="polite"` region and push a short announcement from the realtime handlers ("Document ready for review", "Batch complete: 12 of 15").

**Verification requirements:** A test asserting the region's text changes on a simulated event.

---

### A11Y-002 — WCAG 2.2 AA cannot be claimed; nothing verifies it

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | Test architecture |
| **Evidence** | No `jest-axe`, no `axe-core`, no `@axe-core/react`, no Playwright a11y scan. `grep -rn "axe" package.json apps/*/package.json` → nothing. |
| **Expected** | An automated check on every page at minimum |
| **Actual** | Zero automated coverage; compliance is asserted nowhere and measured nowhere |
| **Verification** | Dependency check |

**Recommended correction:** Add `jest-axe` to the 14 page tests with zero critical/serious violations as the threshold. This is a few hours of work and converts an unverifiable claim into a regression-proof one.

**Verification requirements:** The suite fails when a serious violation is introduced.

---

### A11Y-003 — `prefers-reduced-motion` is not honoured

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | `apps/desktop/src/styles.css` |
| **Evidence** | Zero occurrences of `prefers-reduced-motion` in 621 lines of CSS. Transitions and animations run unconditionally. |
| **Expected** | Motion reduced when the OS requests it (WCAG 2.3.3) |
| **Actual** | Ignored |
| **Verification** | grep |

**Recommended correction:** Add a `@media (prefers-reduced-motion: reduce)` block that disables transitions and transforms.

---

### A11Y-004 — `Modal` does not trap focus (shared with DESK-003)

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | `ui.tsx:81-119` |
| **Evidence** | Focuses first element on open, restores on close, handles Escape. **No Tab cycling.** |
| **Expected** | Tab confined to the dialog (WCAG 2.4.3 / 2.1.2) |
| **Actual** | Tab escapes to the page behind an `aria-modal="true"` dialog, which is worse than a non-modal because the attribute tells AT the rest is inert. |
| **Verification** | Read the keydown handler — only `Escape` is handled |

**Recommended correction:** Implement Tab/Shift+Tab cycling, or adopt a tested primitive.

---

### A11Y-005 — `Field` hint becomes part of the accessible name (shared with DESK-004)

| Field | Value |
|---|---|
| **Severity** | **LOW** |
| **Affected** | `ui.tsx:63-79` |
| **Evidence** | The hint `<span>` is inside the `<label>`, so the accessible name concatenates label + hint. |
| **Expected** | Hint as `aria-describedby` description |
| **Actual** | Hint as name |
| **Verification** | Read the component |

---

### A11Y-006 — Image alternative text is effectively absent

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | Document thumbnails across pages |
| **Evidence** | `grep -rho 'alt=' apps/desktop/src` → **1** occurrence in a 10,000-LOC app with document thumbnails on Documents, Review, Batches and Exports. |
| **Expected** | Every `<img>` has meaningful `alt`, or `alt=""` if decorative |
| **Actual** | One `alt` in total |
| **Verification** | grep; inspect thumbnail rendering |

**Recommended correction:** Give document thumbnails `alt={document.filename}` and decorative icons `alt=""`.

---

## 7. Missing functionality

| Item | Status |
|---|---|
| Live regions | **Not implemented** (A11Y-001) |
| Automated a11y testing | **Not implemented** (A11Y-002) |
| Reduced-motion support | **Not implemented** (A11Y-003) |
| Focus trap | **Not implemented** (A11Y-004) |
| Screen-reader verification | **Not performed** |
| Contrast audit | **Not performed** |
| Additional locales beyond en/sw/fr | **Not implemented** (infrastructure ready) |

---

## 8. Security concerns

None.

---

## 9. Performance concerns

None.

---

## 10. Recommendations

1. **Add the live region (A11Y-001)** — without it the core loop is unusable with a screen reader.
2. **Add `jest-axe` (A11Y-002)** — makes the AA claim checkable rather than aspirational.
3. Add reduced-motion and `alt` coverage (A11Y-003, A11Y-006).
4. Fix the focus trap (A11Y-004).

---

## EVIDENCE CLASSIFICATION

| Class | Items |
|---|---|
| **A. Verified working** | 647-key parity ×3, RTL infrastructure, root `dir`, no hardcoded strings, focus visibility, graceful fallback |
| **B. Verified failing** | A11Y-001, A11Y-003, A11Y-004, A11Y-006 |
| **C. Not implemented** | Live regions, axe, reduced motion, focus trap, SR testing, contrast audit |
| **D. Partially implemented** | Labelling (implicit labels work; hint placement wrong); ARIA (20 attributes, no live region) |
| **E. Unable to verify** | Screen-reader behaviour, contrast ratios — no display, no AT |

**Note on my own corrections:** T3 and T5 initially appeared to be failures ("no RTL", "no labels"). Both were wrong — one because the feature is implemented in a different file than expected, one because the label uses implicit association rather than `htmlFor`. Recording them here because a review that only lists confirming evidence is not a review.

---

## ISSUE SUMMARY

| ID | Severity | Title |
|---|---|---|
| A11Y-001 | **HIGH** | No live region; async updates silent to screen readers |
| A11Y-002 | **HIGH** | No automated accessibility testing; AA unverifiable |
| A11Y-003 | MEDIUM | `prefers-reduced-motion` ignored |
| A11Y-004 | MEDIUM | Modal does not trap focus |
| A11Y-005 | LOW | Field hint pollutes accessible name |
| A11Y-006 | MEDIUM | Image alt text effectively absent |

**Totals: 0 CRITICAL · 2 HIGH · 3 MEDIUM · 1 LOW**
