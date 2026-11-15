# REVIEWER NAME: Desktop Renderer Engineer (R09)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R09-desktop-renderer.md` (52 checklist items)
**STATUS:** ☑ Complete — packaged-build sign-in **could not be executed** (no display, no packaged artifact)

---

## AREAS EXAMINED

14 pages · `App.tsx` · `client.ts` (960 LOC) · `lib/realtime.ts` · `components/ui.tsx` · control inventory · loading/empty/error states · destructive-action confirmation · CSP coupling.

---

## 1. Summary of examination

I read `App.tsx` in full, traced the base-URL resolution through `client.ts` and `realtime.ts`, built the renderer and **grepped the emitted bundle** for an absolute API origin, and inspected all 14 pages for control coverage and state handling.

**Verdict: R-01 is confirmed, in source and in the built artefact.** This is the highest-severity defect in the repository and I reproduced it directly rather than taking it from the parent assessment. The renderer is otherwise well-built: no `dangerouslySetInnerHTML`, no Node imports in the renderer, consistent loading and error states, and a real token-storage abstraction.

---

## 2. Files and components inspected

| File | LOC | Checked |
|---|---|---|
| `apps/desktop/src/App.tsx` | 368 | `createClient` L134, root `dir` L258 |
| `apps/desktop/src/api/client.ts` | 960 | base URL L154, refresh, storage |
| `apps/desktop/src/lib/realtime.ts` | 109 | `eventsUrl` L106 |
| `apps/desktop/src/components/ui.tsx` | 191 | `Field`, `Modal` |
| 14 page files | ~4,600 | controls, states, confirmations |
| `apps/desktop/index.html` | 16 | CSP |
| `apps/desktop/dist/assets/*.js` | built | **bundle grep** |

---

## 3. Features examined

Sign-in · session refresh · realtime events · document review · export · settings · account · invitations · destructive actions · error/loading states.

---

## 4. Tests performed

| # | Test | Result |
|---|---|---|
| T1 | Base-URL trace `App.tsx:134` → `client.ts:154` → `realtime.ts:106` | **FAIL — DESK-001** |
| T2 | Build renderer + grep bundle | `localhost:4000` = **0**, `api/v1` = **5** |
| T3 | Do tests inject `baseUrl`? | **8/8 construct `new ApiClient({ baseUrl: 'https://idcp.test/api/v1' })`** |
| T4 | `dangerouslySetInnerHTML` | **0 occurrences — PASS** |
| T5 | Node/Electron import in renderer | **0 — PASS** |
| T6 | Loading states | 18 occurrences across pages |
| T7 | Error states | 39 occurrences |
| T8 | Packaged-build sign-in | **NOT RUN** — no display, no packaged artifact |
| T9 | 65 controls inventoried | **NOT CLICKED** — needs a running backend + display |

---

## 5. Successful findings

1. **No `dangerouslySetInnerHTML` anywhere.** No XSS sink from rendered content.
2. **The renderer never imports `electron` or `node:fs`** — all privileged access goes through the preload bridge. Correct boundary.
3. **Token storage is abstracted** (`BridgeTokenStorage` / `MemoryTokenStorage`), and the access token lives in memory only — never `localStorage`. This is the right design.
4. **Loading and error states exist widely** (18 and 39 occurrences), not bolted on to one page.
5. **`dir={direction}` is wired at the root** (`App.tsx:258`) so RTL works for the whole tree from one place.

---

## 6. Identified problems

### DESK-001 — **R-01 CONFIRMED: the packaged desktop app cannot reach its backend**

| Field | Value |
|---|---|
| **Severity** | **CRITICAL** |
| **Affected** | `apps/desktop/src/App.tsx:134-142`; `apps/desktop/src/api/client.ts:154`; `apps/desktop/src/lib/realtime.ts:106` |
| **Evidence** | `createClient()` constructs `new ApiClient({ storage, onSessionExpired })` — **no `baseUrl`**. `client.ts:154`: `this.baseUrl = (options.baseUrl ?? '/api/v1').replace(/\/$/, '')`. `realtime.ts:106`: `eventsUrl(accessToken, base = '/api/v1')`. The built bundle contains `api/v1` ×5 and `localhost:4000` ×0. |
| **Expected** | A packaged app resolves an absolute API origin |
| **Actual** | Under `loadFile`, the document origin is `file://`, so `/api/v1` resolves to `file:///api/v1`. Every API call fails, including sign-in. |
| **Verification** | `npm run build -w @idcp/desktop && grep -c "localhost:4000" apps/desktop/dist/assets/*.js` → **0**; read the three lines above |

**Why 406 tests miss it:** all 8 `new ApiClient(...)` constructions in the test suite pass an absolute `baseUrl`. The tests exercise the client *with* a base URL, so the default path is never taken. There is no test that constructs the app the way `App.tsx` does.

**Recommended correction (I recommend option 3):**

| Option | Mechanism | Trade-off |
|---|---|---|
| 1. Build-time `VITE_API_BASE_URL` | `import.meta.env` baked at build | Simple, but one artefact per environment; `DEPLOYMENT.md` already claims this and it does **not** exist |
| 2. Runtime config injected by main | `preload` exposes `apiBaseUrl`; `createClient` reads it | One artefact, per-install config; small main-process change |
| 3. **Custom `app://` protocol** | `protocol.handle('app', ...)` serves the renderer from a privileged origin | **Fixes R-01 *and* the CSP problem (SEC-003) together**, gives a real origin for `'self'` |

Option 3 is best because option 1 and 2 both still leave the CSP unusable (see DESK-002).

**Verification requirements:** A packaged-build test (T-01 in the brief) that launches the built app, signs in against a live backend, and asserts a 200 from `/api/v1/me`. This test must be added to CI or the defect can return.

---

### DESK-002 — CSP `connect-src 'self' ws:` will block the corrected API origin

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | `apps/desktop/index.html:8` |
| **Evidence** | `connect-src 'self' ws:` — under `file://`, `'self'` is the file origin. |
| **Expected** | The CSP whitelists the API origin and its WebSocket/SSE counterpart |
| **Actual** | Even with DESK-001 fixed, the connection is blocked. **The two must be fixed together.** |
| **Verification** | Read the meta tag; reason about `file://` origin |
| **Cross-ref** | SEC-003 (R07) |

**Recommended correction:** Derive `connect-src` from the same source as the API base URL. Ship it as an HTTP header rather than only a meta tag.

---

### DESK-003 — `Modal` claims to trap focus but does not

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | `apps/desktop/src/components/ui.tsx:81-119` |
| **Evidence** | The JSDoc says *"A modal that traps focus, closes on Escape and restores focus on close."* It focuses the first focusable element on mount and restores focus on unmount, and handles Escape. There is **no Tab cycling** — no keydown handler for `Tab`, no sentinel elements. |
| **Expected** | Tab cannot leave the dialog while open (WCAG 2.1.2 / 2.4.3) |
| **Actual** | Tab moves focus out of the dialog into the page behind it |
| **Verification** | Read lines 98-112: the only key handler handles `Escape` |

**Recommended correction:** Add a `Tab`/`Shift+Tab` cycle between first and last focusable descendants, or adopt a tested primitive. Then the comment becomes true.

---

### DESK-004 — `Field` places the hint inside the `<label>`, polluting the accessible name

| Field | Value |
|---|---|
| **Severity** | **LOW** |
| **Affected** | `apps/desktop/src/components/ui.tsx:63-79` |
| **Evidence** | The structure is `<label><span class="label">{label}</span>{children}{hint && <span class="dim">{hint}</span>}</label>`. Implicit labelling is valid, but the hint text becomes part of the accessible name, so a screen reader announces "Password Minimum 12 characters, edit text" instead of using the hint as a description. |
| **Expected** | Hint exposed as `aria-describedby`, not as part of the name |
| **Actual** | Hint concatenated into the name |
| **Verification** | Read the component; confirm hint is inside the `<label>` element |

**Recommended correction:** Keep the implicit `<label>` for the name and move the hint outside it, referenced by `aria-describedby` with a generated id.

---

### DESK-005 — No packaged-build test exists in CI

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | Test architecture |
| **Evidence** | `apps/desktop/test/` contains `desktop.test.tsx` (1,511 LOC) and `shell.test.ts` (213 LOC); both inject `baseUrl`. No test loads the built renderer via `loadFile`. |
| **Expected** | A test that exercises the shipping configuration |
| **Actual** | Every test bypasses the defect |
| **Verification** | 8/8 client constructions pass `baseUrl` |

**Recommended correction:** This is the single most valuable test in the programme — it converts R-01 from "fixed once" to "cannot regress".

---

## 7. Missing functionality

| Item | Status |
|---|---|
| Packaged-build sign-in test | **Not implemented** (DESK-005) |
| Focus trap | **Not implemented** (DESK-003) |
| Production CSP | **Not implemented** (DESK-002) |
| Runtime API configuration | **Not implemented** (DESK-001) |
| Auto-update wiring | **Not implemented** — `publish` points at `updates.example.invalid` |

---

## 8. Security concerns

No XSS sink, no Node access from the renderer, tokens in memory only. The renderer is the *better* half of the desktop security story; the weaknesses are in the shell (R07/R10).

---

## 9. Performance concerns

`client.ts` is 960 LOC in one class; fine functionally, noted for maintainability. Realtime reconnect behaviour is untested against a real server.

---

## 10. Recommendations

1. **Fix DESK-001 with option 3 (`app://` protocol)** — it resolves DESK-001 and DESK-002 in one change.
2. **Add the packaged-build test (DESK-005) in the same PR.** Without it the fix is unverifiable and reversible by accident.
3. Fix the focus trap (DESK-003) and the Field hint (DESK-004).

---

## EVIDENCE CLASSIFICATION

| Class | Items |
|---|---|
| **A. Verified working** | No XSS sink, no renderer Node access, memory-only tokens, loading/error states, RTL root |
| **B. Verified failing** | **DESK-001 (CRITICAL)**, DESK-002, DESK-003, DESK-004 |
| **C. Not implemented** | Packaged-build test, focus trap, prod CSP, runtime config, auto-update |
| **D. Partially implemented** | Token storage (good), realtime (works in dev only) |
| **E. Unable to verify** | Packaged sign-in (no artifact/display), 65 control behaviours (no live backend) |

---

## ISSUE SUMMARY

| ID | Severity | Title |
|---|---|---|
| DESK-001 | **CRITICAL** | Packaged app cannot reach backend (R-01 confirmed) |
| DESK-002 | **HIGH** | CSP blocks any production API origin |
| DESK-003 | MEDIUM | Modal does not trap focus despite its comment |
| DESK-004 | LOW | Field hint pollutes accessible name |
| DESK-005 | **HIGH** | No packaged-build test in CI |

**Totals: 1 CRITICAL · 2 HIGH · 1 MEDIUM · 1 LOW**
