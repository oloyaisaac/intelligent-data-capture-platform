# REVIEWER 09 — DESKTOP RENDERER ENGINEER (React / Electron UI)

| Field | Value |
|-------|-------|
| **Reviewer ID** | R09 |
| **Title** | Desktop Renderer Engineer |
| **Board** | C — Client platforms & experience |
| **Wave** | 3 (weeks 3–5, parallel with Wave 2) |
| **Effort** | 12 person-days |
| **Gate chaired** | none |
| **Co-signs** | G2 |
| **Evidence to** | G7 (contributes findings, not an approver) |
| **Finding prefix** | `DESK-###` (write `DESK-012 (refs PRD DESK-001)` when referring to a PRD story) |
| **Upstream** | R01 (layer map), R04 (API contract) |
| **Downstream** | R10, R12, R13, R22 |
| **Status** | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Determine whether the desktop application — **the primary product surface** — actually works: whether each
of the 12 pages loads real data, each control performs its action, each failure state is legible, and the
token lifecycle is correct.

### 1.1 ⚠ THE CENTRAL FINDING YOU MUST SETTLE: R-01

The parent assessment concluded that **the packaged desktop app cannot reach its backend**. You must
confirm or refute this, because it is the highest-severity defect in the repository and it decides whether
Gate 2 can ever be signed.

**The claim, with exact evidence:**

```
apps/desktop/src/App.tsx:134     function createClient(onSessionExpired) {
apps/desktop/src/App.tsx:138       return new ApiClient({
apps/desktop/src/App.tsx:139         storage: bridge ? new BridgeTokenStorage(bridge) : new MemoryTokenStorage(),
apps/desktop/src/App.tsx:140         onSessionExpired,
                                      ← NO baseUrl passed
apps/desktop/src/api/client.ts:154  this.baseUrl = (options.baseUrl ?? '/api/v1').replace(/\/$/, '');
apps/desktop/src/lib/realtime.ts:106 export function eventsUrl(accessToken, base = '/api/v1')
```

- In **development**, `vite.config.ts` proxies `/api` → `http://127.0.0.1:4000`, so a relative `/api/v1`
  works. That proxy lives in `server` and `preview` config — it is **absent from `build`**.
- In a **packaged** app, `electron-main.ts` calls `window.loadFile(...)`, so the document origin is
  `file://`. A relative request to `/api/v1` therefore resolves to `file:///api/v1`.
- The built bundle was checked: it contains the string `api/v1` and **no** absolute backend URL
  (`grep -c "localhost:4000" dist/assets/*.js` → `0`).
- All renderer tests inject an absolute base URL (`new ApiClient({ baseUrl: 'https://idcp.test/api/v1' })`),
  so **406 passing tests cannot detect this**.

**Your tasks:**

| ID | Task |
|----|------|
| R01-CONFIRM-1 | Trace the base-URL resolution in `App.tsx` → `client.ts` → `realtime.ts` and record file:line for each step |
| R01-CONFIRM-2 | Run `npm run build -w @idcp/desktop` and grep the output bundle for an absolute API origin — record the result |
| R01-CONFIRM-3 | Explain, in one paragraph, why the existing test suite passes despite the defect |
| R01-CONFIRM-4 | Design the fix: where should the API origin come from (build-time `VITE_` env, runtime config injected by the Electron main process, or a custom protocol handler)? State the trade-off for each and recommend one |
| R01-CONFIRM-5 | Note the **CSP coupling**: `index.html` sets `connect-src 'self' ws:`. Even with a correct API URL, a `file://` page will not be allowed to connect to `https://api…` without a CSP change. Record the required CSP change |
| R01-CONFIRM-6 | Write the **one end-to-end test** that would have caught this (see §10 T-01) |

**You own the fix.** Coordinate with R10 (Electron shell) on where the runtime configuration is injected,
and with R07 on the CSP change.

---

## 2. Required expertise

- React 19 (concurrent rendering, `useEffect` semantics, stale closures)
- Client-side routing without a router library (`window.location.hash` based)
- Async data fetching, request cancellation, error boundaries
- Token storage and refresh orchestration in a SPA
- Vite build configuration and environment handling
- Component decomposition of large page components

---

## 3. Repository context (self-contained)

**Product.** IDCP converts photographed business documents into structured records that a human reviews
and then exports or pushes into external systems. The desktop app is the primary surface: pairing, the live
job dashboard, full human-in-the-loop review, mapping, connectors, exports, analytics, settings and account
security.

**Renderer structure (React 19 + Vite 6, Electron shell loads `dist/index.html`):**

| Area | File | LOC |
|------|------|-----|
| App shell, routing, auth boot | `apps/desktop/src/App.tsx` | 368 |
| **API client, token storage, refresh** | `apps/desktop/src/api/client.ts` | **960** |
| Entry | `apps/desktop/src/main.tsx` | 13 |
| Styles (design tokens) | `apps/desktop/src/styles.css` | 621 |
| Shared UI (buttons, modal, table) | `apps/desktop/src/components/ui.tsx` | 191 |
| Send-to-destination panel | `apps/desktop/src/components/SendToDestination.tsx` | 220 |
| SSE realtime client | `apps/desktop/src/lib/realtime.ts` | 109 |
| Review helpers | `apps/desktop/src/lib/review.ts` | 158 |
| Charts (SVG) | `apps/desktop/src/lib/charts.ts` | 146 |
| Formatting | `apps/desktop/src/lib/format.ts` | 161 |
| i18n / locale | `apps/desktop/src/lib/{i18n,locale,labels}.ts(x)` | 173 |
| **Pages (12)** | see table below | 4 088 |

**The 12 pages:**

| Page | File | LOC | Primary actions |
|------|------|-----|-----------------|
| Review | `pages/ReviewPage.tsx` | 512 | side-by-side image/fields, correct, approve, bulk approve |
| Settings | `pages/SettingsPage.tsx` | 695 | organisation, retention, corrections, connectors config |
| Account | `pages/AccountPage.tsx` | 506 | password change, sessions, MFA, export, erase, legal links |
| Login | `pages/LoginPage.tsx` | 312 | sign-in, register, forgot, reset, MFA challenge |
| Templates | `pages/TemplatesPage.tsx` | 353 | CRUD |
| Dashboard | `pages/DashboardPage.tsx` | 320 | live metrics, chart, CSV export |
| Documents | `pages/DocumentsPage.tsx` | 284 | list, filter, open, delete |
| Batches | `pages/BatchesPage.tsx` | 255 | batch upload, progress, results |
| Marketplace | `pages/MarketplacePage.tsx` | 235 | catalogue, install, rollback |
| Connectors | `pages/ConnectorsPage.tsx` | 231 | CRUD, health, mapping |
| Devices | `pages/DevicesPage.tsx` | 168 | list, rename, revoke, pair |
| Exports | `pages/ExportsPage.tsx` | 161 | create, download |
| Projects | `pages/ProjectsPage.tsx` | 139 | CRUD |
| Workflows | `pages/WorkflowsPage.tsx` | 519 | rules, runs, approvals |
| Accept invite | `pages/AcceptInvitePage.tsx` | 94 | accept invitation |

---

## 4. Exact files and components to examine

### 5.1 Must read in full

`App.tsx` · `api/client.ts` (960 — read every method) · `main.tsx` · `lib/realtime.ts` · `lib/review.ts` ·
`lib/format.ts` · `lib/charts.ts` · `lib/{i18n,locale,labels}.ts(x)` · `components/ui.tsx` ·
`components/SendToDestination.tsx` · `index.html` · `vite.config.ts` · `styles.css`

### 5.2 Every page (all 15 files listed above)

For each page record: data source, loading state, empty state, error state, primary action, destructive
actions and their confirmations, keyboard reachability.

### 5.3 Tests

`apps/desktop/test/desktop.test.tsx` (1 511) · `apps/desktop/test/shell.test.ts` (213) ·
`apps/desktop/test/stubs/file.ts`

### 5.4 Explicit non-goals

Electron main process, IPC, packaging and signing → R10 · visual design and flow quality → R12 ·
WCAG conformance and i18n completeness → R13 · API contract correctness → R04.

---

## 5. Upstream artefacts required

| From | Artefact | Why |
|------|----------|-----|
| R04 | `evidence/R04/coverage-diff.md` | Confirm the client uses only documented endpoints |
| R01 | `evidence/R01/layer-map.md` | Confirm the renderer holds no domain logic |

---

## 6. Checklist

### 7.1 Bootstrap, configuration and transport

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DESK-01 | **The API base URL is resolvable in a packaged app** | §2 tasks | **Currently broken (R-01)** | **RUNTIME** |
| DESK-02 | The SSE URL uses the same origin resolution | `lib/realtime.ts` `eventsUrl` | Same defect class | STATIC |
| DESK-03 | The CSP permits the production API origin | `index.html` | Currently `connect-src 'self' ws:` — insufficient | STATIC |
| DESK-04 | There is a single place where the API origin is configured | Read `App.tsx`/`client.ts` | One source of truth | STATIC |
| DESK-05 | A missing/unreachable backend produces a legible error, not a white screen | Kill the backend, load the app | Actionable message | **RUNTIME** |
| DESK-06 | `main.tsx` fails loudly if `#root` is missing | Read | Throws with a message | STATIC |

### 7.2 Authentication and token lifecycle

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DESK-07 | Tokens go to the Electron bridge, never web storage | `BridgeTokenStorage` + `grep -rn "localStorage\|sessionStorage" apps/desktop/src` | Zero web storage | STATIC |
| DESK-08 | `MemoryTokenStorage` is used only when no bridge exists (tests/browser) | Read `createClient` | Confirmed and documented | STATIC |
| DESK-09 | Refresh is **single-flight** | Read the 401 path in `client.ts` | Concurrent 401s trigger one refresh | STATIC |
| DESK-10 | A failed refresh signs the user out exactly once | `onSessionExpired` | Single transition, no loop | STATIC |
| DESK-11 | Sign-out clears the token file and returns to sign-in | Read + test | Confirmed | STATIC |
| DESK-12 | The MFA challenge flow is implemented in the UI | `LoginPage.tsx` | Enrol/verify/disable present | STATIC |
| DESK-13 | The reset-password flow is reachable and honest about delivery | `LoginPage.tsx` | Confirm what the UI claims vs the missing mail transport (R-02) | STATIC |
| DESK-14 | Invitation acceptance works from the hash route | `AcceptInvitePage.tsx` | Confirmed | STATIC |

### 7.3 Data fetching and render correctness

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DESK-15 | Every page has an explicit loading state | Read each page | Present, or a finding | STATIC |
| DESK-16 | Every page has an explicit empty state | Read each page | Present, or a finding | STATIC |
| DESK-17 | Every page handles an API error without crashing | Inject 500 per page (T-05) | Legible message, app still usable | **RUNTIME** |
| DESK-18 | Request cancellation on unmount | Search for `AbortController` | Present, or a finding (state updates after unmount) | STATIC |
| DESK-19 | No stale-closure bug in effects | Read every `useEffect`; check dependency arrays | Correct; note the `tRef` pattern in `App.tsx` | STATIC |
| DESK-20 | No double-fetch in `React.StrictMode` | `useEffect` guards | Idempotent fetch | STATIC |
| DESK-21 | Pagination/cursor is implemented consistently | `DocumentsPage`, `ExportsPage` | Correct cursor handling | STATIC |
| DESK-22 | Large lists are not rendered unbounded | Read list rendering | Bounded / virtualised | STATIC |

### 7.4 The review workflow (the product's core)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DESK-23 | Low-confidence fields are surfaced **first** | `ReviewPage` ordering vs `packages/shared/src/review.ts` thresholds | Confirmed against the documented rule | STATIC |
| DESK-24 | The image and fields display side by side | Read layout | Confirmed | STATIC |
| DESK-25 | Corrections are sent with the document type (`REV-002`) | Read the payload | Confirmed | STATIC |
| DESK-26 | Approve is not possible while an edit is unsaved | Read the flow | Guarded | STATIC |
| DESK-27 | Bulk approve reports **skipped** items | Read + test | Explicit report, never silent | STATIC |
| DESK-28 | Optimistic vs confirmed updates are deliberate | Read the write paths | Consistent, documented | STATIC |
| DESK-29 | A concurrent edit by another reviewer produces a clear outcome | T-06 | Conflict or refresh, never silent overwrite | **RUNTIME** |

### 7.5 Destructive actions

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DESK-30 | Document delete is confirmed | `DocumentsPage` | Confirmation dialog | STATIC |
| DESK-31 | Device revoke is confirmed | `DevicesPage` | Confirmed | STATIC |
| DESK-32 | Account erasure requires password **and** `DELETE` | `AccountPage` | Matches API requirement | STATIC |
| DESK-33 | Connector credential replacement is confirmed | `ConnectorsPage` | Confirmed | STATIC |
| DESK-34 | "Sign out everywhere" is confirmed and explains the effect | `AccountPage` | Confirmed | STATIC |
| DESK-35 | No destructive control is a single unguarded click | Sweep all pages | None | STATIC |

### 7.6 Realtime

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DESK-36 | SSE connects with a valid credential | `lib/realtime.ts` + `eventsUrl` | Works (once R-01 is fixed) | STATIC |
| DESK-37 | All 10 documented event names are handled | Compare with `realtime/hub.ts` | Exact match | STATIC |
| DESK-38 | Reconnect backoff is bounded and does not hammer | 6 retries, cap 30 s | Confirmed | STATIC |
| DESK-39 | **Give-up is visible to the user** | After `maxRetries`, status becomes `offline` | **Verify the UI shows this** — a silently dead dashboard is a finding | STATIC |
| DESK-40 | A malformed event payload cannot crash the page | Read the JSON parse guard | Guarded | STATIC |
| DESK-41 | SSE is cleaned up on unmount/sign-out | Read `close()` wiring | Confirmed | STATIC |

### 7.7 Pages — per-page action inventory (produce a table)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DESK-42 | Enumerate **every interactive control** on all 15 page files | Read each page | `evidence/R09/control-inventory.csv`: page, control, action, API call, test, works? | **WRITE** |
| DESK-43 | Every control performs its documented action | T-04 against a live backend | No dead controls | **RUNTIME** |
| DESK-44 | Every page's primary action is covered by a test that would fail if broken | Cross-reference the inventory against `desktop.test.tsx` | No uncovered primary action | STATIC |
| DESK-45 | No page renders a blank screen for any route | Visit all 15 hash routes | All render | **RUNTIME** |

### 7.8 Code health

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| DESK-46 | Components >400 LOC are decomposed or justified | `wc -l` per file | Settings 695, Review 512, Account 506, Workflows 519 — each needs a plan or a justification | STATIC |
| DESK-47 | `client.ts` (960) is not a god-object | Read; count responsibilities | Split planned (transport / auth / resources) or justified | STATIC |
| DESK-48 | No duplicated types that mirror `packages/shared` | Compare with `contracts.ts` | Imports shared types | STATIC |
| DESK-49 | Bundle size is understood | `npm run build -w @idcp/desktop` | 526 kB (149 kB gzip) + a Vite warning — record a code-splitting plan | **RUNTIME** |
| DESK-50 | No `dangerouslySetInnerHTML` | `grep -rn "dangerouslySetInnerHTML"` | Zero | STATIC |
| DESK-51 | No secret or token in the bundle | Grep the built assets | Zero | **RUNTIME** |
| DESK-52 | Renderer has no Node/fs/electron import | `grep -rn "require(\|node:\|from 'electron'" apps/desktop/src/pages apps/desktop/src/components apps/desktop/src/lib` | Zero | STATIC |

---

## 7. Known renderer risks to confirm or refute

| Risk | Statement |
|------|-----------|
| **R-01 (CRITICAL)** | Packaged app cannot reach the API — `/api/v1` resolves against `file://` |
| **R-06 (HIGH)** | No e2e test exists, so R-01 was invisible to 406 passing tests |
| R-15 | CSP is a meta tag with `connect-src 'self' ws:`; blocks an https API from `file://` |
| R-17 | SSE token in the query string |
| R-22 | Only 19 `aria-*` attributes across 12 pages |
| R-26 | Client types may duplicate `packages/shared` contracts |

---

## 8. Questions you must answer

1. **Does the packaged desktop app reach the API, or does it fall back to a relative `/api/v1` under `file://`?** Reproduce it in the built artefact, not in dev.
2. If it does not: which of the three fixes does the codebase best support, and what does each cost?
3. Does the chosen fix survive a custom protocol, a packaged install, and a CSP `connect-src`?
4. Which desktop tests were structurally blind to this defect, and what would have caught it?
5. Is there any second base-URL default elsewhere in the renderer (realtime, downloads, uploads)?
6. Can a renderer process reach Node or `ipcRenderer` directly, bypassing the preload bridge?

## 9. Commands to run

```bash
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund

# ---------- R-01 evidence ----------
sed -n '130,150p' apps/desktop/src/App.tsx
sed -n '145,200p' apps/desktop/src/api/client.ts
grep -n "base = '/api/v1'" apps/desktop/src/lib/realtime.ts
grep -n "proxy" -A6 apps/desktop/vite.config.ts
npm run build --workspace @idcp/desktop
grep -c "localhost:4000\|127.0.0.1:4000" apps/desktop/dist/assets/*.js   # expect 0
grep -o "api/v1" apps/desktop/dist/assets/*.js | wc -l
grep -n "loadFile\|loadURL" apps/desktop/src/main/electron-main.ts

# ---------- token handling ----------
grep -rn "localStorage\|sessionStorage\|document.cookie" apps/desktop/src
grep -n "401\|refresh\|onSessionExpired" apps/desktop/src/api/client.ts | head -30

# ---------- unsafe patterns ----------
grep -rn "dangerouslySetInnerHTML" apps/desktop/src
grep -rn "from 'electron'\|node:fs\|require(" apps/desktop/src/pages apps/desktop/src/components apps/desktop/src/lib

# ---------- renderer tests ----------
npx jest --config jest.config.cjs --selectProjects desktop --runInBand

# ---------- live run ----------
npm run db:migrate && npm run db:seed
npm run dev:backend &          # :4000
npm run dev:desktop &          # :5173 with /api proxy  ← dev works; packaged does not
#  open http://127.0.0.1:5173, sign in as owner@example.com / demo-password-change-me
```

---

## 10. Tests to perform

| # | Test | Procedure | Pass criterion |
|---|------|-----------|----------------|
| T-01 | **Packaged-app sign-in** | Build the renderer, load it via `loadFile` in Electron, sign in | **Expected to fail today** — this is the R-01 proof and the test to add to CI |
| T-02 | Control sweep | Click every control in the DESK-42 inventory | Every action occurs |
| T-03 | Route sweep | Visit all 15 hash routes | All render, none blank |
| T-04 | Auth edge cases | Expired token, revoked session, MFA required, wrong password | Correct, legible states |
| T-05 | Error injection | Force 400/401/403/429/500 on each page | Legible message; app usable |
| T-06 | Concurrent review | Two windows approve one document | No silent overwrite |
| T-07 | SSE drop | Stop the backend for 60 s | UI shows offline; reconnect works |
| T-08 | Refresh single-flight | Force 3 concurrent 401s | One refresh call |
| T-09 | Sign-out | Sign out | Token file gone, back to sign-in, no stale data |
| T-10 | Bulk approve | Mixed-validity selection | Skipped items reported |

---

## 11. Evidence required

```
docs/reviewers/evidence/R09/
├── r01-proof.md                 # the six R01-CONFIRM tasks + bundle grep output
├── r01-fix-proposal.md          # the three options with trade-offs and a recommendation
├── control-inventory.csv        # DESK-42 — every control, every page
├── page-states.md               # per page: loading / empty / error / destructive confirmations
├── token-lifecycle.md           # storage, refresh, sign-out, failure
├── realtime-review.md           # 10 events, backoff, offline visibility
├── transcripts/                 # T-01 … T-10
├── commands.log
└── findings.md                  # DESK-### register
```

---

## 12. Passing conditions (co-signs G2)

- [ ] **P1** R-01 is confirmed (or refuted with a reproduction that contradicts the assessment) and a fix is proposed with a recommended option (R01-CONFIRM-1 … 6).
- [ ] **P2** A **packaged-build sign-in test exists and passes** after the fix (T-01).
- [ ] **P3** The CSP in `index.html` permits the production API origin (DESK-03).
- [ ] **P4** Tokens are never in web storage; refresh is single-flight; sign-out is clean (DESK-07 … DESK-11).
- [ ] **P5** Every control on every page performs its action — no dead controls (DESK-42, DESK-43, T-02).
- [ ] **P6** Every page has loading, empty and error states (DESK-15 … DESK-17).
- [ ] **P7** Every destructive action is confirmed (DESK-30 … DESK-35).
- [ ] **P8** Realtime degradation is visible; all 10 events handled; cleanup on unmount (DESK-36 … DESK-41).
- [ ] **P9** Low-confidence-first review ordering matches the documented rule (DESK-23).
- [ ] **P10** No `dangerouslySetInnerHTML`, no Node/electron import in the renderer (DESK-50, DESK-52).

---

## 13. Blocked items

| Item ID | Blocker | What unblocks it | Owner |
|---------|---------|------------------|-------|
| T-01 | Needs a packaged Electron build | R10 supplies one | R10 |

---

## 14. Findings register

| ID | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
|----|----------|-----------|---------|----------------|-----------|---------------|-------|
| DESK-001 | | | | | | | |

---

## 15. Reviewer sign-off

| Field | Value |
|-------|-------|
| Reviewer name | |
| Date started | |
| Date completed | |
| **G2 co-sign result** | ☐ Pass ☐ Fail ☐ Abstain |
| Co-sign G2 / G7 | ☐ ☐ |
| **R-01 verdict** | ☐ Confirmed ☐ Refuted |
| Conditions failed (IDs) | |
| Reviewed commit | `43d384b` |
| Statement | *I read `App.tsx`, all 960 lines of `client.ts`, all 15 page files and `lib/realtime.ts`, clicked every control against a live backend, and produced the packaged-build reproduction for R-01.* |
| Signature | |
