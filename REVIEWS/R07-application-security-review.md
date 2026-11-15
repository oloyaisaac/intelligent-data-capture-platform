# REVIEWER NAME: Application Security Engineer (R07)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R07-application-security.md` (80 checklist items)
**STATUS:** ☑ Complete — penetration test **not performed** (no external vendor engaged)

---

## AREAS EXAMINED

Dependency advisories · Electron shell hardening · CSP · upload validation · storage traversal · SSRF · secrets in history · log redaction · CSV injection · error masking · connector isolation.

---

## 1. Summary of examination

I re-ran the dependency audit, read the Electron main process in full, extracted the CSP, tested the storage-key guard and the SSRF validator, scanned full git history for key material, and inspected the CSV export and log redaction paths.

**Verdict: the security engineering is real and above average for a pre-production product.** Magic-byte upload validation, `nosniff`/frame/referrer/CORP headers, parameterised SQL everywhere, CSV formula defusal, log redaction, and a clean git history. The serious defects are in the **desktop shell** — where the renderer's privileges are not constrained — and in the **dependency tree**.

---

## 2. Files and components inspected

| File | Checked |
|---|---|
| `apps/desktop/src/main/electron-main.ts` | 157 LOC — full read |
| `apps/desktop/index.html` | CSP |
| `apps/backend/src/storage/index.ts` | `assertSafeKey`, `sniffMimeType` |
| `packages/connectors/src/crm/http.ts` | URL validation |
| `packages/shared/src/csv.ts` | formula injection |
| `apps/backend/src/logger.ts` | `redact` |
| `.github/workflows/ci.yml` | secrets job |
| `package-lock.json` | audit surface |

---

## 3. Features examined

Electron navigation · external links · CSP · upload acceptance · storage keys · SSRF · secrets · logging · exports · error responses · dependencies.

---

## 4. Tests performed

| # | Test | Result |
|---|---|---|
| T1 | `npm audit --omit=dev` | **FAIL** — 8 prod advisories (1 critical, 5 high, 2 moderate) |
| T2 | `openExternal` allow-list | **FAIL** — none (SEC-001) |
| T3 | `will-navigate` handler | **FAIL** — absent (SEC-002) |
| T4 | CSP `connect-src` | **FAIL for production API** — `'self' ws:` (SEC-003) |
| T5 | Upload magic-byte validation | **PASS** — JPEG/PNG/PDF/HEIC, `null` on unknown |
| T6 | Storage traversal guard | **PASS** — rejects `..`, absolute, normalised escapes |
| T7 | SSRF URL validation | **PARTIAL** — https-only enforced; no IP-range block (SEC-004) |
| T8 | Secrets in git history | **PASS** — no `.env`/`.pem`/`.key`/`id_rsa` ever added |
| T9 | Log redaction | **PASS** — password, authorization, tokens, UDMs redacted |
| T10 | CSV formula injection | **PASS** — defused by default |
| T11 | SQL injection | **PASS** — fully parameterised |
| T12 | External penetration test | **NOT PERFORMED** |
| T13 | Sandbox / `contextIsolation` / `nodeIntegration` | **PASS** — verified set |

---

## 5. Successful findings

1. **Upload validation sniffs content, not the header**, and returns `null` (fail-closed) on an unrecognised type. It does not trust `Content-Type`.
2. **`assertSafeKey` is defence-in-depth**: regex allowlist *and* `..` rejection *and* normalisation *and* absolute-path rejection. Four independent checks for one function.
3. **Full git history is clean** — no key material has ever been committed, and CI enforces it going forward.
4. **Log redaction is real**: `password`, `authorization`, `accessToken`, and UDM field values are replaced before serialisation.
5. **CSV exports defuse formula injection by default** — the safe behaviour is the default, not an option.
6. **`contextIsolation`, `sandbox` and `nodeIntegration: false` are correctly set** on the `BrowserWindow`.
7. **Every SQL statement is parameterised**, and the dynamic `WHERE` builders bind rather than interpolate.

---

## 6. Identified problems

### SEC-001 — `shell.openExternal` is called with an unvalidated URL

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | `apps/desktop/src/main/electron-main.ts:129-130` |
| **Evidence** | `window.webContents.setWindowOpenHandler(({ url }) => { void api.shell.openExternal(url); ... })`. The `url` comes from the rendered page and is passed straight to the OS handler. |
| **Expected** | Only `https:`/`http:` URLs are opened, or an allow-list of origins |
| **Actual** | Any scheme reaching a `window.open`/`target=_blank` is handed to the operating system. On Windows this includes `file:`, `smb:`, `ms-msdt:` and other protocol handlers that have historically been remote-code-execution vectors; on macOS `file:` can open local paths. |
| **Verification** | STATIC — read lines 128-131; confirm no scheme check |

**Recommended correction:** Parse the URL and permit only `https:` (and `http:` in dev). Reject everything else. Better: an origin allow-list of the API and documentation domains.

**Verification requirements:** A test calling the handler with `file:///etc/passwd`, `smb://evil/share`, and `javascript:alert(1)` asserting no `openExternal` call.

---

### SEC-002 — No `will-navigate` handler: the renderer can be navigated away from the app

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | `apps/desktop/src/main/electron-main.ts` (absent) |
| **Evidence** | `grep -c "will-navigate" apps/desktop/src/main/electron-main.ts` → **0**. There is no `webContents.on('will-navigate')` guard. |
| **Expected** | Navigation away from the app document is blocked or intercepted |
| **Actual** | If any renderer code navigates the main frame (a link, a redirect, injected markup), the app loads a remote origin **with the preload bridge still attached** — meaning `window.idcpDesktop` becomes available to a page the developers do not control. |
| **Verification** | STATIC; grep returns zero |

**Why this compounds SEC-001:** the preload exposes token storage (`BridgeTokenStorage`). A navigated page inheriting that bridge could read or overwrite the session. The combination is the most serious issue in this review after R-01.

**Recommended correction:** `window.webContents.on('will-navigate', (e, url) => { if (url !== expected) e.preventDefault(); })`, and keep the existing `setWindowOpenHandler` for legitimate external links.

**Verification requirements:** A test asserting navigation to `https://evil.example` is prevented while the app's own route change still works.

---

### SEC-003 — CSP `connect-src 'self' ws:` cannot permit a production API origin

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | `apps/desktop/index.html:8` |
| **Evidence** | `content="default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; script-src 'self'"` |
| **Expected** | The packaged app can reach its configured API origin |
| **Actual** | Under `file://`, `'self'` is the file origin. Even after R-01 supplies a correct absolute API URL, the CSP will block the request. **Fixing R-01 alone is insufficient.** |
| **Verification** | Read the meta tag; reason about `file://` origin semantics |

**Recommended correction:** Define `connect-src` from the same source as the API base URL at build/runtime (a `connect-src 'self' https://api.example.com wss://api.example.com` derived value). This must be fixed in the **same change** as R-01 or the fix will appear not to work.

**Verification requirements:** A packaged-build test that performs a real fetch to the configured API and asserts a 200.

---

### SEC-004 — SSRF protection is protocol-only; no IP-range or metadata blocking

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | `packages/connectors/src/crm/http.ts:40-50` |
| **Evidence** | The validator enforces `https:` (or `http:` for literal loopback hosts) and rejects a malformed URL. It performs **no DNS resolution**, so a hostname resolving to `10.0.0.5` or `169.254.169.254` passes validation and is fetched by the backend. |
| **Expected** | Outbound fetches cannot reach internal networks or cloud metadata endpoints |
| **Actual** | A user who can set a connector `baseUrl` can target internal services **if they control the DNS name** |
| **Verification** | STATIC — read the validator; note the absence of any `dns.lookup` or IP check |

**Correction to the parent assessment:** the audit described this as "no private-range/metadata-endpoint block … expected: attempts to connect". That is accurate as stated, but the validator **does** enforce https and reject non-URL input, which the assessment did not credit. The gap is narrower than reported but still real.

**Recommended correction:** Resolve the hostname and reject private/link-local/loopback ranges before connecting, re-checking after redirect. Accepting literal loopback for development is reasonable but should be gated on `NODE_ENV !== 'production'`.

**Verification requirements:** Tests for `https://169.254.169.254/`, a hostname resolving to RFC1918, and a redirect to a private IP.

---

### SEC-005 — 8 production dependency advisories, one critical, including a direct dependency

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | `package-lock.json` |
| **Evidence** | `npm audit --omit=dev` → `{critical: 1, high: 5, moderate: 2, total: 8}`. Critical: `shell-quote` (command injection via line terminator) reached through `@idcp/mobile → react-native → react-devtools-core`. High: `zod` (**direct** production dependency, memory exhaustion on oversized constrained collections), `image-size` (JXL/HEIF infinite loop), `decode-uri-component`/`query-string` (DoS), `@react-navigation/core`. |
| **Expected** | Zero critical/high in the production tree, or a signed dated exception |
| **Actual** | 6 critical/high advisories; documentation elsewhere states "9 advisories, all transitive or build-time" and describes `zod` as transitive — both incorrect |
| **Verification** | `npm audit --omit=dev --json`; `grep '"zod"' apps/backend/package.json` shows a direct dependency |

**Recommended correction:** Migrate `zod` (v3 → current) as the highest-value item since it is directly imported and used on every request. For `shell-quote`, determine whether the mobile devtools path is reachable in production (likely not shipped) and record that determination rather than assuming it.

**Verification requirements:** Post-migration `npm audit --omit=dev` showing zero critical/high, or a dated exception document naming the compensating control.

---

### SEC-006 — The renderer is not restricted to the preload bridge in all cases

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | `apps/desktop/src/main/electron-main.ts`; `preload.ts` |
| **Evidence** | `sandbox`, `contextIsolation` and `nodeIntegration: false` are set correctly. However, combined with SEC-002 (no navigation guard), a navigated page retains the preload bridge. The isolation is correct; its persistence across navigation is not. |
| **Expected** | Bridge availability is bound to the trusted document |
| **Actual** | Bound to the window |
| **Verification** | STATIC |

**Recommended correction:** Resolved by fixing SEC-002. Note the coupling.

---

## 7. Missing functionality

| Item | Status |
|---|---|
| External penetration test | **Not performed** |
| `openExternal` allow-list | **Not implemented** |
| `will-navigate` guard | **Not implemented** |
| Production-capable CSP | **Not implemented** |
| IP-range SSRF blocking | **Not implemented** |
| CSP delivered as an HTTP header (not just meta) | **Not implemented** |
| Secret scanning beyond file-name matching | **Partial** — CI matches filenames only, not entropy |

---

## 8. Security concerns

Consolidated above. The most serious combination is **SEC-002 + SEC-001 + SEC-006**: a renderer that can be navigated to an attacker origin retains a preload bridge exposing token storage, and any link is handed to the OS. Individually each is HIGH; together they form a chain worth fixing as one unit.

---

## 9. Performance concerns

None. Argon2id cost is intentional (see R05/R17).

---

## 10. Recommendations

1. **Fix SEC-002 first** — it is the highest-severity item in the domain and cheap to implement.
2. Add the `openExternal` scheme allow-list (SEC-001).
3. Fix SEC-003 **in the same change as R-01**, or R-01's fix will appear broken.
4. Migrate `zod` (SEC-005) — the only direct, per-request dependency with an advisory.
5. Add IP-range SSRF blocking (SEC-004).
6. Commission the external penetration test before Gate 3.

---

## EVIDENCE CLASSIFICATION

| Class | Items |
|---|---|
| **A. Verified working** | Upload sniffing, storage guard, git history, log redaction, CSV defusal, parameterised SQL, isolation flags |
| **B. Verified failing** | SEC-001, SEC-002, SEC-003, SEC-004, SEC-005 |
| **C. Not implemented** | Pen test, allow-list, navigate guard, prod CSP, SSRF IP block, CSP header, entropy scanning |
| **D. Partially implemented** | SSRF (protocol yes, IP no); secret scanning (filename yes, content no) |
| **E. Unable to verify** | Real-world exploitability without a packaged build and a network environment |

---

## ISSUE SUMMARY

| ID | Severity | Title |
|---|---|---|
| SEC-001 | **HIGH** | `openExternal` unvalidated URL |
| SEC-002 | **HIGH** | No `will-navigate` guard; bridge survives navigation |
| SEC-003 | **HIGH** | CSP blocks any production API origin |
| SEC-004 | MEDIUM | SSRF protection is protocol-only |
| SEC-005 | **HIGH** | 8 prod advisories incl. direct `zod` |
| SEC-006 | MEDIUM | Preload bridge bound to window, not document |

**Totals: 0 CRITICAL · 4 HIGH · 2 MEDIUM · 0 LOW**
