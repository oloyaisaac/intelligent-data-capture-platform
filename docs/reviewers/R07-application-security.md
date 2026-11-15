# REVIEWER 07 — APPLICATION SECURITY ENGINEER (includes offensive testing)

| Field              | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| **Reviewer ID**    | R07                                                                |
| **Title**          | Application Security Engineer                                      |
| **Board**          | B — Identity, security & privacy                                   |
| **Wave**           | 2 (weeks 3–5)                                                      |
| **Effort**         | 15 person-days                                                     |
| **Gate chaired**   | **G3 — Security & privacy approval**                               |
| **Co-signs**       | G5                                                                 |
| **Finding prefix** | `SEC-###`                                                          |
| **Upstream**       | R01 (architecture), R02 (route matrix)                             |
| **Downstream**     | R10, R15, R19, R21 (all consume your findings)                     |
| **Status**         | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Break the application. You are the only reviewer whose job is to find out what an **unauthenticated or
low-privilege attacker can do that the designers did not intend**, and to determine whether the
cryptographic and transport controls are correct rather than merely present.

**Scope boundary (deliberate overlap):**

- **R05** audits credential strength; **R06** audits who may see whose row.
- **You** audit whether those controls can be **bypassed or defeated** — and everything else that is
  security-relevant: upload handling, path traversal, SSRF, Electron hardening, dependency exploitability,
  applied cryptography, secret hygiene.

**Two findings are already established by the parent assessment and must be confirmed or refuted
independently — do not simply copy them:**

| ID   | Claim                                                                                                                                                         | Evidence location                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| R-03 | Electron `shell.openExternal(url)` is called with **no protocol allow-list**, and there is **no `will-navigate` handler**                                     | `apps/desktop/src/main/electron-main.ts:129-131`       |
| R-05 | `npm audit` reports **23** advisories (8 in the production tree); the docs claim 9 and call them "all dev/build"; **`zod` is a direct production dependency** | `npm audit`, `AGENT_STATE.md`, `AUDIT-2026-10.md` §4.2 |

---

## 2. Required expertise

- OWASP Top 10 (2021) and OWASP ASVS v4
- Applied cryptography: AES-GCM, key derivation, IV/nonce reuse, AAD, constant-time comparison
- File-upload security: magic bytes, polyglots, decompression bombs, archive handling
- SSRF, path traversal, TOCTOU, injection
- Electron/Tauri hardening (context isolation, sandbox, navigation guards, `openExternal`)
- Supply-chain analysis and dependency exploitability triage
- Offensive tooling and evidence discipline

---

## 3. Repository context (self-contained)

**Product.** IDCP ingests untrusted files (photographs/PDFs of business documents) from mobile devices,
stores them on a filesystem, runs OCR through a **subprocess**, and writes records into **external systems
chosen by the tenant** (SQL and HTTP). Every one of those is an attack surface.

**Security-relevant implementation:**

| Element                                                                    | Path                                              | Size  |
| -------------------------------------------------------------------------- | ------------------------------------------------- | ----- |
| Fastify assembly, CSP/headers, CORS, multipart, error envelope, access log | `apps/backend/src/http/app.ts`                    | 238   |
| Authentication/authorisation guard (3 credential types)                    | `apps/backend/src/http/guards.ts`                 | 107   |
| Envelope encryption (AES-256-GCM + AAD)                                    | `apps/backend/src/services/crypto.ts`             | 54    |
| Password hashing (Argon2id)                                                | `apps/backend/src/auth/password.ts`               | 57    |
| JWT/lifecycle + rate limiter                                               | `apps/backend/src/auth/tokens.ts`                 | 141   |
| Upload validation and storage                                              | `apps/backend/src/services/document-service.ts`   | 300   |
| Storage key generation and traversal guard                                 | `apps/backend/src/storage/index.ts`               | 152   |
| OCR subprocess invocation                                                  | `apps/backend/src/ai/providers/tesseract.ts`      | 116   |
| Cloud AI HTTP provider                                                     | `apps/backend/src/ai/providers/cloud.ts`          | 124   |
| Connector outbound SQL/HTTP (user-supplied endpoints)                      | `packages/connectors/src/**`                      | 2 936 |
| Connector transport                                                        | `packages/connectors/src/crm/http.ts`             | 228   |
| SSE with query-string token                                                | `apps/backend/src/http/routes/realtime-routes.ts` | 86    |
| Legal document serving (path allowlist)                                    | `apps/backend/src/http/routes/legal-routes.ts`    | 66    |
| Electron main (window, IPC, `openExternal`)                                | `apps/desktop/src/main/electron-main.ts`          | 157   |
| Electron preload (4 allow-listed channels)                                 | `apps/desktop/src/main/preload.ts`                | 62    |
| Renderer CSP (meta tag only)                                               | `apps/desktop/index.html`                         | 16    |
| Vite dev server config                                                     | `apps/desktop/vite.config.ts`                     | 27    |
| Logger + redaction                                                         | `apps/backend/src/logger.ts`                      | 74    |
| CI secret scan                                                             | `.github/workflows/ci.yml`                        | 70    |

**Documented controls to test rather than trust:** `SECURITY.md` (13.9 KB rulebook) and
`AUDIT-2026-10.md` §1.1 ("What was checked and found correct"). Notably `AUDIT-2026-10.md` §1.1 asserts
"no credential, token or key material is committed" and "tenant isolation" — verify independently.

**A claim to check carefully:** `ARCHITECTURE.md` §5 refers to a **"connector sandbox"**. Connectors are
TypeScript imported into the backend process. There is no sandbox. Confirm and escalate.

---

## 4. Exact files and components to examine

### 4.1 Must read in full

`apps/backend/src/http/app.ts` · `apps/backend/src/http/guards.ts` · `apps/backend/src/services/crypto.ts` ·
`apps/backend/src/services/document-service.ts` · `apps/backend/src/storage/index.ts` ·
`apps/backend/src/auth/{password,tokens,totp}.ts` · `apps/backend/src/logger.ts` ·
`apps/backend/src/config.ts` · `apps/backend/src/http/routes/{realtime,document,legal,connector}-routes.ts` ·
`apps/desktop/src/main/{electron-main,preload}.ts` · `apps/desktop/index.html` · `apps/desktop/vite.config.ts` ·
`apps/desktop/electron-builder.json` · `.github/workflows/ci.yml` · `SECURITY.md` · `AUDIT-2026-10.md`
· `apps/backend/test/{security,web-surface}.test.ts`

### 4.2 Must analyse

| Scope                                                          | What                                                                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/connectors/src/**` (14 files)                        | Every outbound connection: URL/connection string handling, timeouts, TLS, identifier validation, error leakage |
| `packages/connectors/src/{sqlite,postgres,mysql}-connector.ts` | `assertIdentifier` correctness; quoting after validation                                                       |
| `packages/shared/src/csv.ts`                                   | Formula-injection neutralisation (`=`, `+`, `-`, `@`, `\t`, `\r`)                                              |
| `packages/shared/src/ids.ts`                                   | `hashToken`, `hashIp`, `isUuid` — salt/entropy correctness                                                     |
| `package-lock.json` + every `package.json`                     | Direct and transitive production dependencies                                                                  |
| `apps/mobile/src/api/client.ts`                                | `assertSecureEndpoint` TLS enforcement regex                                                                   |
| `apps/mobile/src/auth/secureStore.ts`                          | Keychain accessibility                                                                                         |
| `apps/desktop/src/api/client.ts`                               | Token handling, no `localStorage`                                                                              |

### 4.3 Explicit non-goals

Credential lifecycle design → R05 · role/tenant matrix → R06 · DSAR completeness → R08 ·
performance impact of security controls → R17.

---

## 5. Upstream artefacts required

| From | Artefact                          | Why                                   |
| ---- | --------------------------------- | ------------------------------------- |
| R02  | `evidence/R02/route-matrix.csv`   | The attack surface list               |
| R06  | `evidence/R06/route-role-map.csv` | Which routes are public               |
| R01  | `evidence/R01/state-inventory.md` | In-process state that could be abused |

---

## 6. Checklist

### 6.1 Upload and file handling

| ID     | Item                                                                    | How to verify                                              | Expected                                           | Type        |
| ------ | ----------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------- | ----------- |
| SEC-01 | Content type is decided by **magic bytes**, not the header              | `storage/index.ts` `sniffMimeType`; `document-service.ts`  | Confirmed                                          | STATIC      |
| SEC-02 | Only an allowlist of types is accepted                                  | `LIMITS.allowedUploadMimeTypes`                            | JPEG/PNG/HEIC/PDF only                             | STATIC      |
| SEC-03 | A named `.jpg` containing PHP/HTML/SVG/ZIP is rejected                  | T-01 polyglot suite                                        | Rejected `UNSUPPORTED_MEDIA_TYPE`                  | **RUNTIME** |
| SEC-04 | Multipart limits are enforced (`files:1`, `fileSize`)                   | `document-routes.ts`                                       | Enforced                                           | STATIC      |
| SEC-05 | A truncated upload fails closed with 413 and **nothing is stored**      | `file.truncated` check                                     | Confirmed                                          | **RUNTIME** |
| SEC-06 | Uploaded files are never served with a client-controlled `Content-Type` | Download route sets `nosniff`                              | Confirmed                                          | STATIC      |
| SEC-07 | `Content-Disposition` prevents inline rendering of HTML/SVG             | Read the download route                                    | `attachment` or safe type                          | STATIC      |
| SEC-08 | SVG is not in the allowlist                                             | Check `LIMITS`                                             | Confirmed                                          | STATIC      |
| SEC-09 | Decompression-bomb resistance (HEIC/PDF)                                | Upload a crafted PDF with a large embedded stream          | Bounded by `MAX_UPLOAD_MB`; no unbounded expansion | **RUNTIME** |
| SEC-10 | PDFs are not parsed with JavaScript or external fetches                 | Check OCR path — tesseract on an image, not a PDF renderer | No remote fetch                                    | STATIC      |
| SEC-11 | Filename is never used as a path                                        | `buildStorageKey` uses uuid + extension                    | Confirmed                                          | STATIC      |
| SEC-12 | Batch upload applies the same validation per file                       | `batch-service.ts`                                         | Confirmed                                          | STATIC      |

### 6.2 Path traversal and storage

| ID     | Item                                                                   | How to verify                                     | Expected                        | Type        |
| ------ | ---------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------- | ----------- |
| SEC-13 | `assertSafeKey` rejects `..`, absolute paths, and normalisation tricks | Read + T-02                                       | Rejected with `INTERNAL_ERROR`  | STATIC      |
| SEC-14 | `extensionForMimeType` cannot emit `..` or a separator                 | Read the function                                 | Fixed map                       | STATIC      |
| SEC-15 | Legal route allowlist prevents traversal                               | `GET /legal/..%2F..%2Fpackage.json`               | 404                             | **RUNTIME** |
| SEC-16 | Export download cannot be used to read another tenant's file           | T-03                                              | 404                             | **RUNTIME** |
| SEC-17 | Storage root is never served statically                                | Check for `@fastify/static` or equivalent         | Absent                          | STATIC      |
| SEC-18 | Symlink behaviour in `STORAGE_PATH`                                    | Create a symlink inside the storage root; read it | Documented behaviour; no escape | **RUNTIME** |

### 6.3 SSRF and outbound connections (connectors)

| ID     | Item                                                                      | How to verify                                                                                       | Expected                                            | Type        |
| ------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------- |
| SEC-19 | Connector endpoints are tenant-supplied and reachable from the **server** | Read `connector-service.ts` + connector configs                                                     | Confirmed — this is SSRF by design                  | STATIC      |
| SEC-20 | There is no private-range / metadata-endpoint block                       | Try `http://169.254.169.254/`, `http://127.0.0.1:4000/`, `http://10.0.0.1/` as a connector endpoint | Record what happens — expected: attempts to connect | **RUNTIME** |
| SEC-21 | Outbound HTTP has a timeout and no redirect following                     | `crm/http.ts`                                                                                       | Both                                                | STATIC      |
| SEC-22 | TLS verification is not disabled                                          | Search for `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED`                              | Zero                                                | STATIC      |
| SEC-23 | Connection strings are validated by scheme                                | `mysql://`, `postgres://` prefix checks                                                             | Confirmed                                           | STATIC      |
| SEC-24 | SQL identifiers are validated before quoting                              | `assertIdentifier` in `sqlite-connector.ts`, reused by mysql/postgres                               | Rejects quotes, spaces, `;`, unicode homoglyphs     | STATIC      |
| SEC-25 | Connector errors do not leak the connection string or credentials         | Read error paths                                                                                    | Redacted                                            | STATIC      |
| SEC-26 | An egress policy is documented                                            | Search `DEPLOYMENT.md`/`SECURITY.md` for egress                                                     | Present or recorded missing                         | STATIC      |
| SEC-27 | Connector code cannot exceed the backend's own privileges                 | Confirm: connectors run **in-process** (no sandbox)                                                 | Record the supply-chain consequence                 | STATIC      |

### 6.4 Cryptography

| ID     | Item                                                | How to verify                                          | Expected                                               | Type   |
| ------ | --------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------ | ------ |
| SEC-28 | AES-256-GCM with a fresh 12-byte IV per record      | `crypto.ts` `randomBytes(12)`                          | Confirmed; no nonce reuse possible                     | STATIC |
| SEC-29 | Tenant is bound as AAD                              | `cipher.setAAD(context)`                               | A ciphertext moved between tenants fails               | STATIC |
| SEC-30 | Auth tag verified (GCM `final()` throws on tamper)  | Read decrypt                                           | Confirmed                                              | STATIC |
| SEC-31 | Key derivation uses a domain-separated salt         | `scryptSync(secret, 'idcp-connector-credentials', 32)` | Present but **shares `JWT_SECRET`** — see AUTH-22/R-25 | STATIC |
| SEC-32 | `scryptSync` is not called on a hot request path    | Search call sites                                      | Called once at construction                            | STATIC |
| SEC-33 | No key versioning / rotation path                   | Confirm                                                | Recorded as R-25                                       | STATIC |
| SEC-34 | Randomness comes from `crypto.randomBytes` only     | `grep -rn "Math.random\|uuidv4()" apps/backend/src`    | No `Math.random` in security contexts                  | STATIC |
| SEC-35 | Token/IP hashing is not reversible-by-brute-force   | `packages/shared/src/ids.ts` `hashIp`                  | Salted, or recorded as a privacy issue for R08         | STATIC |
| SEC-36 | Recovery-code and token comparison is constant-time | Read the verify paths                                  | Confirmed                                              | STATIC |
| SEC-37 | Timing-safe comparison of recovery codes            | Same                                                   | Confirmed                                              | STATIC |

### 6.5 Transport, headers, CSP, CORS

| ID     | Item                                                                           | How to verify                                         | Expected                                                                                                                | Type        |
| ------ | ------------------------------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------- |
| SEC-38 | Security headers on every response                                             | T-04 against a live server                            | `x-content-type-options`, frame options, referrer policy, CORP, COOP, `permissions-policy`                              | **RUNTIME** |
| SEC-39 | Is a **CSP** sent as a response header by the backend?                         | Inspect headers                                       | Likely absent (only the renderer meta tag exists) — record                                                              | **RUNTIME** |
| SEC-40 | Is HSTS set anywhere?                                                          | Headers, proxy docs                                   | Absent or proxy-only — record                                                                                           | **RUNTIME** |
| SEC-41 | CORS is restrictive and `CORS_ORIGINS` is mandatory in production              | `config.ts`, `app.ts`                                 | Enforced                                                                                                                | STATIC      |
| SEC-42 | CORS does not reflect arbitrary origins                                        | T-05 with `Origin: https://evil.test`                 | No `access-control-allow-origin` echo                                                                                   | **RUNTIME** |
| SEC-43 | Renderer CSP in `index.html`                                                   | Read                                                  | `default-src 'self'`, `connect-src 'self' ws:`, `style-src 'unsafe-inline'`, no `object-src 'none'` — record weaknesses | STATIC      |
| SEC-44 | The renderer CSP will **not** permit an `https://` API from a `file://` origin | Reason about `connect-src 'self' ws:` vs packaged app | Confirmed tension with R-01 — record                                                                                    | STATIC      |
| SEC-45 | HSTS/preload via proxy documented                                              | `DEPLOYMENT.md`                                       | Present or recorded                                                                                                     | STATIC      |

### 6.6 Electron hardening

| ID     | Item                                                                | How to verify                                                                                          | Expected                                                                  | Type        |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ----------- |
| SEC-46 | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` | `electron-main.ts` `webPreferences`                                                                    | All three                                                                 | STATIC      |
| SEC-47 | IPC surface is exactly 4 channels, all payload-validated            | `preload.ts` + `ipcMain.handle`                                                                        | Confirmed; `sanitiseTokens` clamps length and type                        | STATIC      |
| SEC-48 | **`openExternal` has no protocol allow-list** (R-03)                | `electron-main.ts` `setWindowOpenHandler`                                                              | **Confirmed defect** — require `https:`-only                              | STATIC      |
| SEC-49 | **No `will-navigate` handler** (R-03)                               | `grep -rn "will-navigate"` → zero                                                                      | Confirmed defect — a remote navigation would load with the preload bridge | STATIC      |
| SEC-50 | `setPermissionRequestHandler` is absent                             | `grep`                                                                                                 | Camera/mic permissions are not gated by the app                           | STATIC      |
| SEC-51 | External links cannot load inside the shell                         | Attempt navigation to `https://example.com` in a packaged build                                        | Blocked (after fix)                                                       | **RUNTIME** |
| SEC-52 | Local file exfiltration via `window.open('file://…')`               | Attempt in a packaged build                                                                            | Blocked (after fix)                                                       | **RUNTIME** |
| SEC-53 | Token file is encrypted and `0600`                                  | `writeTokens`                                                                                          | Confirmed; verify by hexdump                                              | STATIC      |
| SEC-54 | Update mechanism does not accept unsigned payloads                  | `idcp:updates:check` returns a **hardcoded** `up_to_date` and publish URL is `updates.example.invalid` | No real updater exists — record                                           | STATIC      |
| SEC-55 | ASAR integrity / code signing plan                                  | `electron-builder.json`                                                                                | Documented; not executed                                                  | STATIC      |

### 6.7 Dependencies and supply chain

| ID     | Item                                                           | How to verify                                                                                               | Expected                                                                         | Type        |
| ------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------- |
| SEC-56 | Full advisory inventory                                        | `npm audit --json`                                                                                          | **Record the actual count** (parent assessment measured 23 total / 8 production) | **RUNTIME** |
| SEC-57 | Production-only inventory                                      | `npm audit --omit=dev --json`                                                                               | 8 (1 critical, 5 high) at time of assessment                                     | **RUNTIME** |
| SEC-58 | Direct vs transitive classification                            | Compare hit list against `package.json` files                                                               | `zod` and `exceljs` are **direct production** dependencies                       | **RUNTIME** |
| SEC-59 | Exploitability of the `zod` advisory through this request path | Reason about `MAX_REQUEST_MB` / `MAX_UPLOAD_MB` enforcement on **every** body, including JSON and multipart | Mitigation only; document the residual                                           | STATIC      |
| SEC-60 | The `shell-quote` critical advisory path                       | `npm ls shell-quote`                                                                                        | `@idcp/mobile → react-native → react-devtools-core`                              | **RUNTIME** |
| SEC-61 | The documented advisory count is accurate                      | Compare `AGENT_STATE.md` / `AUDIT-2026-10.md` §4.2 with `npm audit`                                         | **Docs are stale/wrong — correct them**                                          | STATIC      |
| SEC-62 | No CI dependency gate exists                                   | `.github/workflows/ci.yml`                                                                                  | Absent; recommend after the zod v4 migration                                     | STATIC      |
| SEC-63 | Lockfile integrity / install scripts                           | `package-lock.json`, `.npmrc`                                                                               | No unexpected `postinstall` from untrusted packages                              | STATIC      |
| SEC-64 | Marketplace package signature verification                     | `marketplace-service.ts`, `marketplace/catalog.ts`                                                          | Verified before install; test a tampered package                                 | STATIC      |
| SEC-65 | GitHub Actions are pinned to SHAs                              | `ci.yml`                                                                                                    | Currently tags (`@v4`) — record as hardening                                     | STATIC      |

### 6.8 Secrets and logging

| ID     | Item                                                 | How to verify                                                        | Expected                                                        | Type        |
| ------ | ---------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- | ----------- |
| SEC-66 | No secret material tracked                           | `.github/workflows/ci.yml` job + `git ls-files` scan                 | Clean                                                           | **RUNTIME** |
| SEC-67 | No secret in git **history**                         | `gitleaks`/`trufflehog` over full history                            | Clean                                                           | **RUNTIME** |
| SEC-68 | Access log omits query strings and bodies            | `app.ts` `onResponse` log                                            | Confirmed — note that a reverse proxy may log the SSE token     | STATIC      |
| SEC-69 | Log redaction covers sensitive keys                  | `logger.ts` `redact()`                                               | Enumerate the key list; check against what services log         | STATIC      |
| SEC-70 | No PII in logs (emails, names, document text)        | Scan service logging call sites                                      | Clean or recorded for R08                                       | STATIC      |
| SEC-71 | The SSE access token in the query string cannot leak | `realtime-routes.ts` + `eventsUrl()` in the desktop client           | Assess proxy logging risk; recommend a single-use stream ticket | STATIC      |
| SEC-72 | Error responses never include stack traces or SQL    | T-06 (force a 500)                                                   | Generic message + `requestId`                                   | **RUNTIME** |
| SEC-73 | Production refuses development defaults              | `NODE_ENV=production` with default `JWT_SECRET`/empty `CORS_ORIGINS` | Startup fails                                                   | **RUNTIME** |
| SEC-74 | `.env.example` contains no real credentials          | Read 5.6 KB file                                                     | Placeholders only                                               | STATIC      |

### 6.9 Mobile client

| ID     | Item                                                               | How to verify                                                                                       | Expected                               | Type        |
| ------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------- |
| SEC-75 | `assertSecureEndpoint` enforces `https://`                         | `apps/mobile/src/api/client.ts:83-88`                                                               | Enforced                               | STATIC      |
| SEC-76 | The loopback exception cannot be abused                            | Test `https://127.0.0.1.evil.test`, `https://evil.test/?h=127.0.0.1`, `https://evil.test/#10.0.2.2` | Rejected — regex must be anchored      | **RUNTIME** |
| SEC-77 | Credentials only in keychain with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` | `secureStore.ts`                                                                                    | Confirmed                              | STATIC      |
| SEC-78 | QR payload is validated as a pairing token, not a URL              | `capture/QrScannerView.tsx`, `pairing/pairing.ts`                                                   | A malicious QR cannot redirect the app | **RUNTIME** |
| SEC-79 | Document screenshots are not captured in the OS app switcher       | Search for `FLAG_SECURE`/blur equivalent                                                            | Likely absent — record                 | STATIC      |
| SEC-80 | The app has no WebView loading remote content                      | `grep -rn "WebView" apps/mobile/src`                                                                | Zero                                   | STATIC      |

---

## 7. Known security risks to confirm or refute

| Risk     | Statement                                                            | Severity (parent assessment) |
| -------- | -------------------------------------------------------------------- | ---------------------------- |
| **R-03** | Electron `openExternal` unguarded; no `will-navigate`                | HIGH                         |
| **R-05** | 23 advisories / 8 production; `zod` direct prod dep; docs understate | HIGH                         |
| R-16     | No connector sandbox despite docs claiming one                       | MEDIUM                       |
| R-17     | SSE token in query string                                            | MEDIUM                       |
| R-25     | One secret for JWT signing and credential encryption                 | LOW/MEDIUM                   |
| R-18     | In-process, unbounded, IP-spoofable rate limiter                     | MEDIUM                       |
| R-15     | CSP only as a meta tag; missing `object-src`/`frame-ancestors`       | MEDIUM                       |
| R-19     | SSRF via tenant-supplied connector endpoints                         | MEDIUM (assess)              |

---

## 8. Questions you must answer

1. What can an **unauthenticated** attacker do to this system?
2. What can an authenticated **viewer** do that they should not?
3. Can this system be made to connect to an internal address, and what does it return?
4. Is the file-upload path genuinely safe against polyglots and decompression bombs?
5. Which advisories are reachable through the request path, and which are build-time only?
6. Does the packaged desktop app expose any OS capability to renderer content?
7. Where could a secret leak in a real deployment, given the documented reverse proxy?

---

## 9. Commands to run

```bash
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund

# ---------- dependency reality ----------
npm audit --json  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);console.log(a.metadata.vulnerabilities);for(const[k,v]of Object.entries(a.vulnerabilities||{}))console.log(v.severity,k,v.isDirect?'DIRECT':'transitive')})"
npm audit --omit=dev --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);console.log(a.metadata.vulnerabilities)})"
npm ls shell-quote zod exceljs image-size uuid

# ---------- secrets ----------
git ls-files | grep -E '(^|/)\.env$|\.pem$|\.key$|\.p12$|id_rsa' ; echo "tracked-secrets-exit=$?"
npx --yes gitleaks@8 detect --source . --no-banner || true
git log --all -p -S 'BEGIN RSA PRIVATE KEY' --oneline | head

# ---------- headers / CORS ----------
npm run dev:backend &
curl -sD - -o /dev/null http://127.0.0.1:4000/api/v1/health | tr -d '\r'
curl -sD - -o /dev/null -H 'Origin: https://evil.test' http://127.0.0.1:4000/api/v1/health | tr -d '\r'

# ---------- traversal ----------
curl -s -o /dev/null -w "%{http_code}\n" 'http://127.0.0.1:4000/api/v1/legal/..%2F..%2Fpackage.json'

# ---------- SSRF (document only; do NOT attack third-party hosts) ----------
# register a connector whose endpoint is http://169.254.169.254/latest/meta-data/
# and observe whether the backend attempts the connection.

# ---------- upload polyglots ----------
# build: valid JPEG header + PHP body; SVG named .jpg; PDF with JS; zip bomb; 0-byte; 21MB

# ---------- tesseract subprocess ----------
grep -n "execFile\|timeout\|maxBuffer" apps/backend/src/ai/providers/tesseract.ts

# ---------- electron static evidence ----------
grep -n "setWindowOpenHandler\|openExternal\|will-navigate\|setPermissionRequestHandler" \
  apps/desktop/src/main/electron-main.ts
grep -n "Content-Security-Policy" -A2 apps/desktop/index.html
```

---

## 10. Tests to perform

| #    | Test                      | Procedure                                                                     | Pass criterion                                                        |
| ---- | ------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| T-01 | Upload polyglot suite     | 12 crafted files                                                              | All rejected or safely stored; none executed/served as active content |
| T-02 | Path traversal            | `../`, `..%2f`, absolute, unicode, null byte in every key-derived endpoint    | 404/400, never a file read                                            |
| T-03 | Cross-tenant file read    | Request another tenant's export/document file                                 | 404                                                                   |
| T-04 | Header capture            | `curl -D` on 5 endpoints                                                      | All documented headers present                                        |
| T-05 | CORS probe                | Arbitrary `Origin`                                                            | No permissive reflection                                              |
| T-06 | 500 error leak            | Force an internal error                                                       | No stack/SQL/path                                                     |
| T-07 | SSRF probe                | Connector endpoint → localhost/metadata                                       | Behaviour recorded; egress control specified                          |
| T-08 | JWT tamper                | `alg:none`, foreign signature, modified `role`/`org`                          | All rejected (coordinate with R05)                                    |
| T-09 | Electron navigation       | Packaged build: `window.open('file:///etc/passwd')`, `smb://`, external https | Denied (after fix)                                                    |
| T-10 | Production config refusal | Default secret / empty CORS                                                   | Startup fails                                                         |
| T-11 | Marketplace tamper        | Install a modified package                                                    | Signature check fails                                                 |
| T-12 | Secret history scan       | `gitleaks detect` over full history                                           | No findings                                                           |
| T-13 | Mobile endpoint bypass    | 4 crafted URLs against `assertSecureEndpoint`                                 | Rejected                                                              |
| T-14 | Malicious QR              | Pairing scanner given `https://evil.test`                                     | Rejected as a pairing payload                                         |

---

## 11. Evidence required

```
docs/reviewers/evidence/R07/
├── attack-surface.md            # every entry point and its trust level
├── upload-findings.md           # T-01 table with the 12 payloads and outcomes
├── traversal-findings.md        # T-02 results
├── ssrf-assessment.md           # connector egress analysis + recommended policy
├── crypto-review.md             # SEC-28 … SEC-37 with justification per control
├── dependency-triage.md         # every advisory: direct/transitive, reachable?, fix, owner
├── electron-hardening.md        # SEC-46 … SEC-55 with the exact fix for R-03
├── secrets-scan.log             # gitleaks + tracked-file scan
├── headers-capture.txt          # raw response headers
├── transcripts/                 # T-01 … T-14
├── commands.log
└── findings.md                  # SEC-### register
```

---

## 12. Passing conditions (chairs G3; co-signs G5)

- [ ] **P1** No critical or high advisory is reachable in the **production** dependency tree, or a dated owner exception exists with a compensating control (SEC-56 … SEC-62).
- [ ] **P2** The documented advisory count is corrected in `AGENT_STATE.md` and `AUDIT-2026-10.md` (SEC-61).
- [ ] **P3** Upload path is proven safe against polyglots, truncation and bombs (SEC-03, SEC-05, SEC-09).
- [ ] **P4** No path traversal and no cross-tenant file read (SEC-13 … SEC-18, T-02, T-03).
- [ ] **P5** Connector egress: SSRF risk is either blocked (private-range deny list) or formally accepted with a documented deployment control (SEC-19 … SEC-27).
- [ ] **P6** Crypto controls verified: GCM, AAD, random IV, constant-time comparison, no `Math.random` (SEC-28 … SEC-37).
- [ ] **P7** `openExternal` allow-listed and `will-navigate` blocked in the Electron shell (SEC-48, SEC-49).
- [ ] **P8** Security headers present on every response; CSP analysed and its production gap recorded (SEC-38 … SEC-42).
- [ ] **P9** No secret in the working tree **or** git history (SEC-66, SEC-67).
- [ ] **P10** No PII or credential material in logs (SEC-68 … SEC-70).
- [ ] **P11** An **external** penetration test is either completed or scheduled with a date — in-house review is not a substitute for the procurement artefact.

**If any of P1, P3, P4, P7, or P9 is false, G3 FAILS and no release may proceed.**

---

## 13. Blocked items

| Item ID                        | Blocker                                                                    | What unblocks it              | Owner |
| ------------------------------ | -------------------------------------------------------------------------- | ----------------------------- | ----- |
| SEC-48, SEC-49, SEC-51, SEC-52 | No Electron binary/display in the sandbox                                  | R10 produces a packaged build | R10   |
| SEC-20                         | SSRF probes against cloud metadata endpoints need a controlled environment | Isolated test VPC             | R19   |
| SEC-67                         | Full-history secret scan is slow; needs a full clone                       | `git clone --mirror`          | R19   |

---

## 14. Findings register

| ID      | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
| ------- | -------- | --------- | ------- | -------------- | --------- | ------------- | ----- |
| SEC-001 |          |           |         |                |           |               |       |

---

## 15. Reviewer sign-off

| Field                        | Value                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewer name                |                                                                                                                                                                            |
| Date started                 |                                                                                                                                                                            |
| Date completed               |                                                                                                                                                                            |
| **Gate G3 result**           | ☐ Pass ☐ Fail                                                                                                                                                              |
| **G5 co-sign result**        | ☐ Pass ☐ Fail ☐ Abstain                                                                                                                                                    |
| Critical findings still open |                                                                                                                                                                            |
| Conditions failed (IDs)      |                                                                                                                                                                            |
| Reviewed commit              | `43d384b`                                                                                                                                                                  |
| Statement                    | _I executed T-01 … T-14, independently reproduced or refuted R-03 and R-05, and verified every crypto and transport control in §6.4–§6.5 rather than reading its comment._ |
| Signature                    |                                                                                                                                                                            |
