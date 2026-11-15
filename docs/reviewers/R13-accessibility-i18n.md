# REVIEWER 13 — ACCESSIBILITY & INTERNATIONALISATION REVIEWER

| Field              | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| **Reviewer ID**    | R13                                                                |
| **Title**          | Accessibility & Internationalisation Reviewer                      |
| **Board**          | C — Client platforms & experience                                  |
| **Wave**           | 3 (weeks 3–5)                                                      |
| **Effort**         | 8 person-days                                                      |
| **Gate chaired**   | none                                                               |
| **Co-signs**       | G7                                                                 |
| **Evidence to**    | G9 (contributes findings, not an approver)                         |
| **Finding prefix** | `A11Y-###`                                                         |
| **Upstream**       | R12 (journey map, page inventory)                                  |
| **Downstream**     | G7 sign-off                                                        |
| **Status**         | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Determine whether the product is usable by people using a keyboard, a screen reader, a magnifier, or a
language other than English — and whether the three shipped locales are genuinely complete rather than
"translated where we remembered".

**Specific to this repository — measured before the review even starts:**

| Measurement                                            | Value                                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `aria-*` attributes across `apps/desktop/src`          | **19** (across 12 pages + 2 components)                                                   |
| Total `aria-`/`role=`/`tabIndex`/`htmlFor` occurrences | 41                                                                                        |
| Automated accessibility test suites                    | **0** (`axe`/`jest-axe` not installed)                                                    |
| i18n catalogue size                                    | 2 105 LOC, **647 keys × 3 locales** (`en`, `sw`, `fr`)                                    |
| RTL locale catalogues                                  | **0**                                                                                     |
| Documented RTL verification                            | "the direction helper and the logical-property test" — a unit test, not a real RTL render |

19 ARIA attributes across 14 files is thin evidence for any WCAG claim. The repository makes no formal
accessibility claim, but a commercial product sold into organisations will be asked. Your job is to produce
the **first real accessibility evidence**, and to decide whether the RTL claim survives.

---

## 2. Required expertise

- WCAG 2.2 AA: all four principles, with emphasis on 1.4.3 contrast, 2.1.1 keyboard, 2.4.3 focus order, 2.4.7 focus visible, 3.3.1 error identification, 4.1.2 name/role/value, 4.1.3 status messages
- WAI-ARIA Authoring Practices: dialogs, tables, live regions
- Screen-reader testing: NVDA + Firefox/Chrome (Windows), VoiceOver + Safari (macOS), VoiceOver/TalkBack (mobile), TalkBack (Android)
- Keyboard-only operation and focus management
- Colour contrast and non-text contrast
- i18n: ICU/`Intl`, pluralisation, date/number/currency, text expansion, bidi, logical CSS properties

---

## 3. Repository context (self-contained)

**Product.** IDCP has a desktop app (Electron + React 19, 12 pages) and a mobile app (React Native, 5
screens). Users review documents side-by-side with extracted data, so dense tables, images and live updates
are central — all classic accessibility hazards.

**Accessibility-relevant code:**

| Element                                      | Path                                                                          | Size      |
| -------------------------------------------- | ----------------------------------------------------------------------------- | --------- |
| Shared UI primitives (buttons, modal, table) | `apps/desktop/src/components/ui.tsx`                                          | 191       |
| Modal dialog                                 | `ui.tsx` — `role="dialog" aria-modal="true"` + `ref`                          | ~L110–140 |
| Global styles, focus states, contrast tokens | `apps/desktop/src/styles.css`                                                 | 621       |
| Navigation landmark                          | `App.tsx` — `<nav className="sidebar" aria-label={t('app.mainNavigation')}>`  | 368       |
| Charts                                       | `lib/charts.ts` (SVG) + `DashboardPage.tsx` `aria-label={describeChart(...)}` | 146 + 320 |
| Review table                                 | `pages/ReviewPage.tsx` (checkbox `aria-label`, table headers)                 | 512       |
| Documents table                              | `pages/DocumentsPage.tsx` (`<th aria-label={t('table.actions')} />`)          | 284       |
| Batches file input                           | `pages/BatchesPage.tsx` `aria-label={t('batches.chooseFiles')}`               | 255       |
| Login form                                   | `pages/LoginPage.tsx` `aria-label` on submit                                  | 312       |
| Marketplace                                  | `MarketplacePage.tsx` `aria-label` on package action                          | 235       |
| Locale plumbing                              | `lib/{locale.tsx, i18n.ts, labels.ts}`                                        | 173       |
| i18n catalogue                               | `packages/shared/src/i18n.ts`                                                 | 2 105     |
| RTL direction helper                         | `lib/locale.tsx` — `applyDocumentLocale`                                      | —         |
| Mobile locale/theme                          | `apps/mobile/src/ui/{locale,theme}.ts`                                        | 90        |
| Mobile screens                               | 5 files in `apps/mobile/src/screens/`                                         | 1 019     |

**Documented claims to test:**

| Claim                                                                                                                                           | Source                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| "Localisation is complete: 647 keys, 100% coverage in `en`, `sw` and `fr`, `Intl` formatting, and a direction-aware layout"                     | `AGENT_STATE.md` gap 6  |
| "No RTL language ships yet, so RTL is verified by the direction helper and the logical-property test rather than by a real RTL catalogue"       | `AGENT_STATE.md` gap 6  |
| "The English and French catalogues are clean. Two Swahili strings were suspected and turned out to be correct (`mashine`, `kumbukumbu chache`)" | `AUDIT-2026-10.md` §1.1 |

---

## 4. Exact files and components to examine

### 4.1 Must read in full

`apps/desktop/src/components/ui.tsx` · `apps/desktop/src/styles.css` · `apps/desktop/src/App.tsx` ·
`apps/desktop/src/lib/{locale.tsx, i18n.ts, labels.ts, charts.ts, format.ts}` ·
`packages/shared/src/i18n.ts` (all 2 105 lines — you are checking completeness and quality, not sampling) ·
`apps/desktop/index.html` (lang attribute) · `apps/mobile/src/ui/{locale.ts, theme.ts}`

### 4.2 Every page (accessibility review)

`pages/LoginPage.tsx` · `pages/DashboardPage.tsx` · `pages/DevicesPage.tsx` · `pages/DocumentsPage.tsx` ·
`pages/ReviewPage.tsx` · `pages/ExportsPage.tsx` · `pages/BatchesPage.tsx` · `pages/ConnectorsPage.tsx` ·
`pages/TemplatesPage.tsx` · `pages/WorkflowsPage.tsx` · `pages/MarketplacePage.tsx` ·
`pages/ProjectsPage.tsx` · `pages/SettingsPage.tsx` · `pages/AccountPage.tsx` · `pages/AcceptInvitePage.tsx`

### 4.3 Every mobile screen

`apps/mobile/src/screens/{CaptureScreen, ReviewScreen, PairingScreen, SignInScreen, QueueScreen}.tsx`

### 4.4 Explicit non-goals

Visual design and flow quality → R12 · component correctness → R09 · mobile build → R11 ·
translation **content** approval by a native speaker is a _task you commission_, not a code change.

---

## 5. Upstream artefacts required

| From | Artefact                       | Why                                             |
| ---- | ------------------------------ | ----------------------------------------------- |
| R12  | `evidence/R12/journey-map.md`  | The flows you must traverse with assistive tech |
| R12  | `evidence/R12/error-states.md` | The states whose announcements you must verify  |

---

## 6. Checklist

### 6.1 Semantic structure and accessible names

| ID      | Item                                                               | How to verify                                              | Expected                                     | Type      |
| ------- | ------------------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------- | --------- |
| A11Y-01 | `<html lang>` is set and updates on locale change                  | `index.html` + `applyDocumentLocale`                       | Correct                                      | STATIC    |
| A11Y-02 | `<html dir>` updates for RTL locales                               | `applyDocumentLocale`                                      | Correct (even though no RTL catalogue ships) | STATIC    |
| A11Y-03 | Landmarks exist: nav, main, complementary                          | Read `App.tsx`                                             | `nav` present; `main` present?               | STATIC    |
| A11Y-04 | One `<h1>` per page and a logical heading order                    | Read each page                                             | Correct                                      | STATIC    |
| A11Y-05 | Every interactive element has an accessible name                   | **Inventory** all `<button>`, `<a>`, `<input>`, `<select>` | 100% named                                   | **WRITE** |
| A11Y-06 | Icon-only buttons have names                                       | Check `aria-label` coverage                                | All named                                    | STATIC    |
| A11Y-07 | Form inputs are associated with labels                             | `htmlFor`/`id` or `aria-labelledby`                        | All associated                               | STATIC    |
| A11Y-08 | Required fields are programmatically indicated                     | `aria-required` or `required`                              | Correct                                      | STATIC    |
| A11Y-09 | Error messages are programmatically associated                     | `aria-describedby`                                         | Correct                                      | STATIC    |
| A11Y-10 | Tables have proper header cells                                    | `<th scope>`                                               | Correct                                      | STATIC    |
| A11Y-11 | The review table's image/field pairing is perceivable non-visually | Read `ReviewPage`                                          | Documented approach                          | STATIC    |
| A11Y-12 | Charts have a text alternative that conveys the data               | `describeChart` → `aria-label`                             | Adequate or improved                         | STATIC    |
| A11Y-13 | No ARIA is used where native semantics suffice                     | Read `ui.tsx`                                              | Correct                                      | STATIC    |

### 6.2 Keyboard and focus

| ID      | Item                                                                                         | How to verify                                                   | Expected             | Type        |
| ------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------- | ----------- |
| A11Y-14 | Every interactive element is reachable by Tab                                                | Keyboard sweep of all pages                                     | 100%                 | **RUNTIME** |
| A11Y-15 | Focus order matches visual order                                                             | Tab through Review and Settings                                 | Correct              | **RUNTIME** |
| A11Y-16 | Focus is always visible                                                                      | Read `styles.css` for `:focus-visible`; no bare `outline: none` | Visible ring         | STATIC      |
| A11Y-17 | **The modal traps focus, sets initial focus, restores focus on close, and closes on Escape** | `ui.tsx` + live test                                            | Implemented          | **RUNTIME** |
| A11Y-18 | No keyboard trap anywhere                                                                    | Tab through every page                                          | None                 | **RUNTIME** |
| A11Y-19 | Skip-to-content link exists or navigation is short enough                                    | Read `App.tsx`                                                  | Present or justified | STATIC      |
| A11Y-20 | Custom widgets (if any) implement the ARIA pattern                                           | Inventory custom controls                                       | Correct              | STATIC      |
| A11Y-21 | Hover-only information is also focusable/readable                                            | Sweep                                                           | None hidden          | STATIC      |
| A11Y-22 | The bulk-select checkbox pattern is keyboard-operable                                        | `ReviewPage`                                                    | Correct              | **RUNTIME** |

### 6.3 Screen reader

| ID      | Item                                                               | How to verify                                   | Expected                    | Type        |
| ------- | ------------------------------------------------------------------ | ----------------------------------------------- | --------------------------- | ----------- |
| A11Y-23 | The app is navigable with NVDA on Windows                          | Manual                                          | Usable end-to-end           | **RUNTIME** |
| A11Y-24 | The app is navigable with VoiceOver on macOS                       | Manual                                          | Usable end-to-end           | **RUNTIME** |
| A11Y-25 | **SSE arrivals are announced via a live region**                   | Look for `aria-live` in the dashboard/documents | **Likely absent — confirm** | STATIC      |
| A11Y-26 | Loading and save confirmations are announced                       | `aria-live`/`role="status"`                     | Present or finding          | STATIC      |
| A11Y-27 | Error messages are announced                                       | `role="alert"`                                  | Present or finding          | STATIC      |
| A11Y-28 | Page/route changes are announced                                   | Focus management on route change                | Present or finding          | STATIC      |
| A11Y-29 | Table row actions are distinguishable to a screen reader           | Read `ReviewPage` aria-labels                   | Distinct per row            | STATIC      |
| A11Y-30 | Decorative images are hidden (`alt=""`), meaningful ones described | Sweep                                           | Correct                     | STATIC      |

### 6.4 Visual accessibility

| ID      | Item                                                 | How to verify                                              | Expected                             | Type        |
| ------- | ---------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------ | ----------- |
| A11Y-31 | Text contrast ≥4.5:1 (normal), ≥3:1 (large)          | Compute for every token pair on the dark surface `#0d151d` | Pass, or a measured list of failures | **RUNTIME** |
| A11Y-32 | Non-text contrast ≥3:1 (borders, icons, focus rings) | Compute                                                    | Pass                                 | **RUNTIME** |
| A11Y-33 | No information conveyed by colour alone              | Check confidence highlighting and status badges            | Redundant icon/text cue              | STATIC      |
| A11Y-34 | Text resizes to 200% without loss                    | Browser zoom 200%                                          | Usable                               | **RUNTIME** |
| A11Y-35 | Reflow at 320 CSS px width                           | DevTools responsive                                        | No horizontal scroll for content     | **RUNTIME** |
| A11Y-36 | Touch targets ≥24×24 px (mobile ≥44)                 | Inspect                                                    | Pass or findings                     | STATIC      |
| A11Y-37 | Reduced-motion preference respected                  | `prefers-reduced-motion` in CSS                            | Present or finding                   | STATIC      |
| A11Y-38 | Animations are not essential to comprehension        | Sweep                                                      | None                                 | STATIC      |
| A11Y-39 | Automated scan is clean                              | `npx axe` / `jest-axe` on every page (add the dependency)  | Zero critical/serious                | **RUNTIME** |

### 6.5 i18n completeness and quality

| ID      | Item                                                                                                             | How to verify                                         | Expected                          | Type        |
| ------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------- | ----------- |
| A11Y-40 | Key counts per locale are equal                                                                                  | Parse `i18n.ts`; count keys in `en`, `sw`, `fr`       | 647/647/647 with zero gaps        | **RUNTIME** |
| A11Y-41 | No locale falls back to another language silently                                                                | Look for fallback logic                               | Explicit, with a dev-time warning | STATIC      |
| A11Y-42 | **No hardcoded English strings in components**                                                                   | `grep` JSX text nodes across all pages/screens        | Zero, or a listed set             | STATIC      |
| A11Y-43 | Plurals use `Intl.PluralRules`, not `"+ s"` concatenation                                                        | Search for `count +` patterns                         | Correct                           | STATIC      |
| A11Y-44 | Dates/numbers/currency use `Intl` per locale                                                                     | `lib/format.ts`                                       | Consistent                        | STATIC      |
| A11Y-45 | Interpolation placeholders are preserved in all locales                                                          | Compare keys with `{vars}`                            | No lost placeholders              | **RUNTIME** |
| A11Y-46 | No key has an empty or copy-pasted-from-English value in `sw`/`fr`                                               | Scan for identical-to-English values in short strings | Suspicious entries listed         | STATIC      |
| A11Y-47 | Text expansion does not break layout (French is ~20% longer)                                                     | Switch to `fr` and traverse                           | No clipping/overlap               | **RUNTIME** |
| A11Y-48 | Truncation is not used for critical text                                                                         | Inspect                                               | None critical                     | STATIC      |
| A11Y-49 | Native-speaker review of 20 high-traffic strings per non-English locale                                          | Commission reviewers                                  | Signed                            | **WRITE**   |
| A11Y-50 | The two Swahili strings named in the audit (`mashine`, `kumbukumbu chache`) are re-confirmed by a native speaker | Ask                                                   | Confirmed or corrected            | **WRITE**   |

### 6.6 RTL

| ID      | Item                                                                                      | How to verify                               | Expected                                          | Type                                  |
| ------- | ----------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------- | ------------------------------------- |
| A11Y-51 | `dir="rtl"` is applied correctly when an RTL locale is active                             | `applyDocumentLocale`                       | Correct                                           | STATIC                                |
| A11Y-52 | Layout uses logical properties (`margin-inline-*`) not physical (`margin-left`)           | `grep -nE "margin-left\|padding-left\|left: | right:" styles.css`                               | Count and record; convert or document | STATIC |
| A11Y-53 | Icons with direction (arrows, chevrons) mirror                                            | Sweep                                       | Correct or listed                                 | STATIC                                |
| A11Y-54 | **Prove RTL with a real RTL catalogue** (e.g. an `ar` pseudolocale) or withdraw the claim | Add a minimal RTL catalogue and render it   | Verified visually, or the claim removed from docs | **RUNTIME**                           |
| A11Y-55 | Bidi text (mixed Arabic + Latin) renders correctly in fields                              | Pseudolocale test                           | Correct                                           | **RUNTIME**                           |

### 6.7 Mobile accessibility

| ID      | Item                                                                     | How to verify       | Expected            | Type        |
| ------- | ------------------------------------------------------------------------ | ------------------- | ------------------- | ----------- |
| A11Y-56 | `accessibilityLabel`/`accessibilityRole` present on interactive elements | Sweep the 5 screens | Present or findings | STATIC      |
| A11Y-57 | TalkBack can complete capture → queue → review                           | Android manual      | Usable              | **RUNTIME** |
| A11Y-58 | VoiceOver (iOS) can complete the same                                    | iOS manual          | Usable              | **RUNTIME** |
| A11Y-59 | Dynamic type / font scaling does not break layouts                       | Set 200% text       | Usable              | **RUNTIME** |
| A11Y-60 | Touch targets meet platform minimums                                     | Inspect             | Pass                | STATIC      |

---

## 7. Known accessibility/i18n risks to confirm or refute

| Risk                  | Statement                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------- |
| **R-22 (LOW→MEDIUM)** | 19 `aria-*` attributes across 12 pages; zero automated a11y tests                             |
| —                     | No live region exists for SSE updates, so a screen-reader user cannot know a document arrived |
| —                     | The modal's focus trap is unverified                                                          |
| —                     | The RTL claim rests on a unit test, not a render                                              |
| —                     | Contrast on a dark theme (`#0d151d`) is unmeasured                                            |
| —                     | "647 keys / 100% coverage" is asserted; count it independently                                |

---

## 8. Questions you must answer

1. **Can a keyboard-only user complete the full review loop?** Demonstrate.
2. Are incoming documents announced to a screen reader?
3. Is the modal focus trap real, and does Escape restore focus?
4. What is the measured contrast ratio of every text token on the dark surface?
5. Are the 647 keys genuinely complete in `sw` and `fr`? Count them, and have a native speaker check 20.
6. Does RTL work when actually rendered, or does it only pass a unit test?
7. Which pages fail an automated axe scan, and how badly?

---

## 9. Commands to run

```bash
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund

# ---------- baseline counts ----------
grep -rc "aria-" apps/desktop/src --include=*.tsx | awk -F: '{s+=$2} END {print "aria- total:", s}'
grep -rn "aria-live\|role=\"status\"\|role=\"alert\"" apps/desktop/src
grep -rn "outline: none\|outline:none\|outline: 0" apps/desktop/src/styles.css
grep -nE "margin-left|padding-left|margin-right|padding-right|left:|right:" apps/desktop/src/styles.css | wc -l
grep -rn "prefers-reduced-motion" apps/desktop/src/styles.css

# ---------- i18n coverage (independent count) ----------
node --experimental-strip-types -e "
  import('./packages/shared/src/i18n.ts').then(m => {
    for (const [loc, cat] of Object.entries(m.CATALOGUES ?? {})) console.log(loc, Object.keys(cat).length);
  });
" 2>/dev/null || node -e "
  const s=require('fs').readFileSync('packages/shared/src/i18n.ts','utf8');
  console.log('keys seen:', (s.match(/^\s{2,4}'[a-zA-Z][\w.]*':/gm)||[]).length, '(manual parse — verify)');
"

# ---------- hardcoded English in components ----------
grep -rnE '>[A-Z][a-z]+ [a-z]+' apps/desktop/src/pages apps/desktop/src/components | head -40

# ---------- automated accessibility ----------
npm i -D @axe-core/cli jest-axe 2>/dev/null
npm run dev:desktop &
npx axe http://127.0.0.1:5173 --exit 2>&1 | tail -40
# then add jest-axe assertions per page in a scratch test file

# ---------- contrast (compute from tokens) ----------
grep -nE "\-\-[a-z-]+:\s*#" apps/desktop/src/styles.css | head -40
# use any contrast calculator against --surface #0d151d and the text tokens

# ---------- RTL proof ----------
# add a minimal 'ar' catalogue with 5 keys, set locale, screenshot both directions
```

---

## 10. Tests to perform

| #    | Test                      | Procedure                                      | Pass criterion                       |
| ---- | ------------------------- | ---------------------------------------------- | ------------------------------------ |
| T-01 | Keyboard-only full loop   | No mouse                                       | Completable                          |
| T-02 | Modal focus behaviour     | Open/close modal                               | Trap, initial focus, restore, Escape |
| T-03 | NVDA walkthrough          | Windows + NVDA                                 | All pages usable                     |
| T-04 | VoiceOver walkthrough     | macOS + VoiceOver                              | All pages usable                     |
| T-05 | SSE announcement          | Receive a document with a screen reader active | Announced                            |
| T-06 | Contrast audit            | Every token pair                               | All ≥4.5:1 or listed                 |
| T-07 | axe scan                  | All 15 routes                                  | Zero critical/serious                |
| T-08 | Zoom 200% + 320 px reflow | Browser                                        | No loss                              |
| T-09 | i18n key parity           | Parse catalogue                                | 647/647/647                          |
| T-10 | French layout             | Traverse in `fr`                               | No clipping                          |
| T-11 | RTL render                | Pseudolocale                                   | Correct, or claim withdrawn          |
| T-12 | Mobile TalkBack/VoiceOver | Both platforms                                 | Capture → review completable         |
| T-13 | Dynamic type 200%         | Mobile                                         | No layout break                      |

---

## 11. Evidence required

```
docs/reviewers/evidence/R13/
├── accessible-names.csv         # every interactive element → name → present?
├── axe-report/                  # per-route axe output
├── keyboard-walkthrough.md      # T-01, T-02 with focus order
├── screen-reader-notes.md       # T-03 … T-05 transcripts
├── contrast-table.md            # token × background × ratio × pass/fail
├── i18n-parity.md               # key counts, missing keys, suspicious values
├── native-speaker-review.md     # T-09/T-10 sign-off per locale
├── rtl-evidence.md              # screenshots both directions
├── mobile-a11y.md               # T-12, T-13
├── commands.log
└── findings.md                  # A11Y-### register
```

---

## 12. Passing conditions (co-signs G7)

- [ ] **P1** Every interactive element has an accessible name (A11Y-05, A11Y-06).
- [ ] **P2** Full keyboard operability with visible focus, and a correct modal focus trap (A11Y-14 … A11Y-22, T-01, T-02).
- [ ] **P3** Screen readers can complete the review loop, and SSE arrivals are announced (A11Y-23 … A11Y-30, T-03 … T-05).
- [ ] **P4** Contrast measured and passing, or every failure listed with a fix (A11Y-31, A11Y-32, T-06).
- [ ] **P5** An automated axe scan runs in CI with zero critical/serious violations (A11Y-39, T-07).
- [ ] **P6** Zoom 200% and 320 px reflow are usable (A11Y-34, A11Y-35, T-08).
- [ ] **P7** i18n parity is proven by independent count: zero missing keys across `en`/`sw`/`fr` (A11Y-40, T-09).
- [ ] **P8** Zero hardcoded English in components (A11Y-42).
- [ ] **P9** Native speakers have reviewed 20 high-traffic strings per locale (A11Y-49, A11Y-50).
- [ ] **P10** RTL is proven by a real RTL render **or** the RTL claim is removed from the documentation (A11Y-51 … A11Y-55, T-11).
- [ ] **P11** Mobile capture and review work under TalkBack and VoiceOver (A11Y-57, A11Y-58, T-12).

---

## 13. Blocked items

| Item ID          | Blocker                                       | What unblocks it             | Owner |
| ---------------- | --------------------------------------------- | ---------------------------- | ----- |
| A11Y-23, A11Y-24 | No Windows/macOS screen-reader environments   | Machines with NVDA/VoiceOver | R19   |
| A11Y-49          | No native Swahili/French speakers on the team | Commission reviewers         | R22   |
| A11Y-57, A11Y-58 | No mobile build                               | R11                          | R11   |

---

## 14. Findings register

| ID       | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
| -------- | -------- | --------- | ------- | -------------- | --------- | ------------- | ----- |
| A11Y-001 |          |           |         |                |           |               |       |

---

## 15. Reviewer sign-off

| Field                   | Value                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reviewer name           |                                                                                                                                                                          |
| Date started            |                                                                                                                                                                          |
| Date completed          |                                                                                                                                                                          |
| **G7 co-sign result**   | ☐ Pass ☐ Fail ☐ Abstain                                                                                                                                                  |
| WCAG 2.2 AA verdict     | ☐ Pass ☐ Pass with exceptions ☐ Fail                                                                                                                                     |
| i18n verdict            | ☐ Complete ☐ Gaps listed                                                                                                                                                 |
| RTL verdict             | ☐ Proven ☐ Claim withdrawn                                                                                                                                               |
| Conditions failed (IDs) |                                                                                                                                                                          |
| Reviewed commit         | `43d384b`                                                                                                                                                                |
| Statement               | _I counted the i18n keys independently rather than trusting the documentation, ran axe on every route, and completed the review loop with keyboard, NVDA and VoiceOver._ |
| Signature               |                                                                                                                                                                          |
