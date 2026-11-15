# REVIEWER 05 — AUTHENTICATION ENGINEER

| Field | Value |
|-------|-------|
| **Reviewer ID** | R05 |
| **Title** | Authentication Engineer |
| **Board** | B — Identity, security & privacy |
| **Wave** | 2 (weeks 3–5) |
| **Effort** | 9 person-days |
| **Gate chaired** | none |
| **Co-signs** | G3 |
| **Evidence to** | G1, G2 (contributes findings, not an approver) |
| **Finding prefix** | `AUTH-###` |
| **Upstream** | R01 (layer map), R02 (route matrix) |
| **Downstream** | blocks Wave 3 sign-off; R09/R11 consume the token lifecycle you document |
| **Status** | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Determine whether a user can be authenticated securely and can **recover** when they cannot be: password
hashing, token issuance and rotation, MFA, recovery codes, password reset, session revocation. You own
the answer to *"is the credential lifecycle sound?"*

**Scope boundary (important, because two other reviewers overlap by design):**
- **You** own credential **strength and lifecycle** — is the hash strong, is the token single-use, can a code be replayed.
- **R06** owns **authorisation** — who may do what to whose row.
- **R07** owns the **attacker's** view — can a credential be bypassed entirely, and is the crypto correct.
Each fails on a different criterion. Do not audit the role matrix (R06) or run offensive tooling (R07).

**Specific to this repository:** `auth-service.ts` is **903 LOC** — the largest service in the system — and
handles login, MFA, reset, sessions, registration and erasure. `tokens.ts` uses **one `JWT_SECRET`** for
access tokens, MFA challenges, *and* (via `crypto.ts`) as the seed for connector-credential encryption.
Whether that key reuse is acceptable is a finding you must make, not inherit.

---

## 2. Required expertise

- Password hashing: Argon2id parameters, OWASP ASVS v4 §2.4
- JWT best practices: algorithm pinning, claims, audience/issuer, expiry, key management
- Opaque tokens, refresh-token rotation and **reuse detection**
- TOTP (RFC 6238), recovery codes, MFA enrolment UX and threat model
- Account recovery threat modelling (enumeration, token replay, timing)
- Session management and revocation semantics

---

## 3. Repository context (self-contained)

**Product.** IDCP stores photographs of business documents — often IDs, invoices and contracts — for
multi-tenant organisations. There are **5 roles** (`owner`, `admin`, `reviewer`, `operator`, `viewer`) and
three credential types: user bearer token, paired-device credential, API key.

**Authentication surface:**

| Element | Path | Size |
|---------|------|------|
| Password hashing + strength | `apps/backend/src/auth/password.ts` | 57 |
| Token service + rate limiter | `apps/backend/src/auth/tokens.ts` | 141 |
| TOTP implementation | `apps/backend/src/auth/totp.ts` | 116 |
| Auth domain logic | `apps/backend/src/services/auth-service.ts` | **903** |
| Auth persistence | `apps/backend/src/repositories/auth-repo.ts` | 477 |
| Auth routes | `apps/backend/src/http/routes/auth-routes.ts` | 257 (19 routes) |
| Envelope encryption (MFA secret, connector creds) | `apps/backend/src/services/crypto.ts` | 54 |
| Guard (3 credential types) | `apps/backend/src/http/guards.ts` | 107 |
| Limiter wiring | `apps/backend/src/services/container.ts` | 146 |
| Desktop token bridge | `apps/desktop/src/main/electron-main.ts` | 157 |
| Desktop sign-in UI | `apps/desktop/src/pages/LoginPage.tsx` | 312 |
| Desktop account UI | `apps/desktop/src/pages/AccountPage.tsx` | 506 |
| Mobile sign-in | `apps/mobile/src/screens/SignInScreen.tsx` | 157 |
| Mobile credential storage | `apps/mobile/src/auth/secureStore.ts` | 92 |

**Documented parameters (verify each):**

| Control | Stated value | Source |
|---------|--------------|--------|
| Password hash | Argon2id, m=65 536 KiB, t=3, p=1 | `password.ts` |
| Password minimum | 12 characters, max 256 | `password.ts` |
| Weak-password blocklist | 7 hardcoded strings | `password.ts` |
| Access token | JWT HS256, ≤900 s, claims `sub`/`org`/`role`, issuer `idcp`, audience `idcp-api` | `tokens.ts`, `config.ts` |
| MFA challenge token | JWT HS256, 300 s, audience `idcp-mfa`, `scope: 'mfa'` | `tokens.ts` |
| Refresh token | Opaque, 32 bytes, stored as SHA-256 hash, rotated on use | `tokens.ts`, `auth-repo.ts` |
| Refresh TTL | 30 days | `config.ts` |
| Device credential | `dev_` + 32 bytes, hashed | `tokens.ts` |
| Recovery codes | 10, single-use, stored as hashes, shown `XXXX-XXXX` | `auth-service.ts`, DEC-034 |
| Password reset TTL | 1 hour | `PASSWORD_RESET_TTL_SECONDS` |
| Auth rate limit | 5 attempts / 15 min (in-process) | `RATE_LIMIT_AUTH_PER_15_MIN` |

---

## 4. Exact files and components to examine

### 4.1 Must read **in full, line by line**

| # | File | Why the whole file |
|---|------|--------------------|
| 1 | `apps/backend/src/services/auth-service.ts` (903) | Every auth outcome lives here; copy-paste between login/MFA/reset is the likely defect class |
| 2 | `apps/backend/src/auth/tokens.ts` (141) | Token issuance, verification, rotation, and the limiter |
| 3 | `apps/backend/src/auth/totp.ts` (116) | Window, drift, base32 handling, constant-time compare |
| 4 | `apps/backend/src/auth/password.ts` (57) | Hashing options, strength rules, the weak list |
| 5 | `apps/backend/src/repositories/auth-repo.ts` (477) | Every auth SQL statement: sessions, resets, recovery hashes, MFA secret storage |
| 6 | `apps/backend/src/http/routes/auth-routes.ts` (257) | All 19 routes: which are public, which are rate-limited |
| 7 | `apps/backend/src/services/crypto.ts` (54) | Envelope encryption and key derivation |
| 8 | `apps/backend/src/http/guards.ts` (107) | How each credential becomes an actor |
| 9 | `apps/backend/src/services/container.ts` (146) | Limiter configuration and TTL wiring |

### 4.2 Must read (client side — to verify the protocol is implementable)

`apps/desktop/src/pages/LoginPage.tsx` · `apps/desktop/src/pages/AccountPage.tsx` (MFA enrolment, session list,
password change) · `apps/desktop/src/api/client.ts` (token storage, single-flight refresh) ·
`apps/mobile/src/screens/SignInScreen.tsx` · `apps/mobile/src/auth/secureStore.ts`

### 4.3 Tests you must read and extend mentally

`apps/backend/test/auth.test.ts` (206) · `auth-recovery.test.ts` (241) · `mfa.test.ts` (209) ·
`totp.test.ts` (84) · `terms.test.ts` (114) · `security.test.ts` (214)

### 4.4 Configuration keys you must verify

`JWT_SECRET` (min 16 default, **≥32 enforced in production**) · `ACCESS_TOKEN_TTL_SECONDS` (900) ·
`REFRESH_TOKEN_TTL_SECONDS` (30 d) · `PAIRING_TOKEN_TTL_SECONDS` (120) · `PASSWORD_RESET_TTL_SECONDS` (1 h) ·
`RATE_LIMIT_ENABLED` · `RATE_LIMIT_AUTH_PER_15_MIN` (5) · `TRUST_PROXY` (default **true**)

### 4.5 Explicit non-goals

Role/tenant authorisation → R06 · offensive bypass testing and crypto review → R07 · mail delivery of the
reset link → R02/R19 (you record it as a functional gap) · accessibility of the login screen → R13.

---

## 5. Upstream artefacts required

| From | Artefact | Why |
|------|----------|-----|
| R02 | `evidence/R02/route-matrix.csv` | Confirms which of the 19 auth routes are public |
| R01 | `evidence/R01/state-inventory.md` | Confirms the limiter is in-process |

---

## 6. Checklist

### 6.1 Password storage

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| AUTH-01 | Argon2id is the algorithm (not Argon2i/d) | `password.ts` `Algorithm.Argon2id` | Confirmed | STATIC |
| AUTH-02 | Parameters meet OWASP (m≥19 MiB, t≥2, p≥1) | `OPTIONS` constant | m=65 536, t=3, p=1 → exceeds | STATIC |
| AUTH-03 | Verification is constant-time and never throws on a malformed hash | `verify()` wrapped in try/catch returning false | Confirmed | STATIC |
| AUTH-04 | Rehash-on-login exists (upgrading old parameters) | Search for a rehash path | Present, or recorded as a gap | STATIC |
| AUTH-05 | Password length bounds enforced server-side | `validatePasswordStrength` | 12 ≤ len ≤ 256 | STATIC |
| AUTH-06 | The weak-password list is credible | Read the 7 entries | **7 entries is far too small** — quantify and recommend a breached-password check (documented follow-up) | STATIC |
| AUTH-07 | Repeated-character and common-pattern rules | `/(.)\1+/` | Confirmed | STATIC |
| AUTH-08 | No password ever logged | `grep -rn "password" apps/backend/src/logger.ts` + logging call sites | Zero | STATIC |
| AUTH-09 | Password change requires the current password | `POST /auth/password/change` | Required | STATIC |
| AUTH-10 | Password change revokes other sessions (or is documented) | Read the flow | Explicit decision recorded | STATIC |

### 6.2 Tokens

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| AUTH-11 | Access token TTL ≤15 min and configurable downward only | `config.ts` `IntFromString(900, 60, 86_400)` | Max 24 h allowed — assess whether that ceiling is acceptable | STATIC |
| AUTH-12 | Algorithm pinned on **verify**, not just sign | `jwt.verify(..., { algorithms: ['HS256'] })` | Pinned (prevents `alg:none` / confusion) | STATIC |
| AUTH-13 | Issuer and audience validated | `issuer: 'idcp'`, `audience: 'idcp-api'` on verify | Both present | STATIC |
| AUTH-14 | Access token carries minimum claims | `sub`, `org`, `role` | Confirmed; note that `org`/`role` are **re-read** server-side | STATIC |
| AUTH-15 | Refresh token is opaque and stored only as a hash | `createRefreshToken` → 32 random bytes + SHA-256 | No plaintext stored | STATIC |
| AUTH-16 | Refresh tokens **rotate** on use | `auth-repo.ts` revoke + issue | Confirmed by test | STATIC |
| AUTH-17 | **Reuse detection** exists (a replayed old refresh token kills the family) | Search for reuse detection | **Likely absent — determine and record** | STATIC |
| AUTH-18 | Refresh expiry is absolute and enforced | `sessions.expires_at` | Enforced | STATIC |
| AUTH-19 | Logout revokes server-side, not only client-side | `POST /auth/logout` | Session revoked | STATIC |
| AUTH-20 | `logout-all` revokes every session and is audited | Route + audit | Both | STATIC |
| AUTH-21 | Access tokens cannot be revoked before expiry (stateless JWT) | Read + quantify the ≤15 min window | Documented residual risk | STATIC |

### 6.3 Key management (the reuse question)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| AUTH-22 | Enumerate every use of `JWT_SECRET` | `grep -rn "JWT_SECRET\|config.JWT_SECRET" apps/backend/src` | Access token, MFA challenge, and (via `crypto.ts`) connector-credential key | STATIC |
| AUTH-23 | Assess the consequence of the shared secret | `crypto.ts` `scryptSync(secret, 'idcp-connector-credentials', 32)` | Rotating the JWT secret makes all stored connector credentials **undecryptable**; assess and recommend a dedicated key + versioning | STATIC |
| AUTH-24 | MFA secret encryption uses the same box | `mfa_secret_enc` via `SecretBox` | Confirm; same rotation consequence | STATIC |
| AUTH-25 | Production refuses the development default secret | `config.ts` production block | Enforced (default rejected, ≥32 chars) | STATIC |
| AUTH-26 | No key material in logs or responses | `grep -rn "secret\|key" apps/backend/src/logger.ts` | Redacted | STATIC |

### 6.4 MFA (DEC-034)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| AUTH-27 | Enrolment is: start → confirm → active | Read the 3 routes | Confirmed | STATIC |
| AUTH-28 | TOTP window is ±1 step at most | `totp.ts` | Documented and tight | STATIC |
| AUTH-29 | TOTP comparison is constant-time | `timingSafeEqual` or equivalent | Confirmed | STATIC |
| AUTH-30 | The TOTP secret is encrypted at rest | `mfa_secret_enc` | Confirmed | STATIC |
| AUTH-31 | The secret is shown once, at enrolment | Read the enrolment response | Confirmed | STATIC |
| AUTH-32 | The MFA challenge token is single-purpose | `audience: 'idcp-mfa'`, `scope: 'mfa'` | Confirmed; cannot be used as an access token | STATIC |
| AUTH-33 | The challenge token expires in 5 min | `expiresIn: 300` | Confirmed | STATIC |
| AUTH-34 | The challenge is bound to the password step (cannot be obtained without it) | Read the login flow | Confirmed | STATIC |
| AUTH-35 | 10 recovery codes, single-use, hashed | `auth-repo.ts` `mfa_recovery_hashes` | Confirmed | STATIC |
| AUTH-36 | A recovery code is consumed atomically | Read the verify path | One code cannot be used twice concurrently | STATIC |
| AUTH-37 | Recovery codes are regenerable and the old set invalidated | `POST /auth/mfa/recovery-codes` | Confirmed | STATIC |
| AUTH-38 | Disabling MFA requires **password AND code** | `POST /auth/mfa/disable` | Both required | STATIC |
| AUTH-39 | A lost/undecryptable secret re-enrols rather than locking the user out | Search the "secret will not decrypt" path | Present (documented in AUDIT-2026-10) | STATIC |
| AUTH-40 | MFA state changes are audited | Audit entries for enrol/disable/regenerate | Confirmed | STATIC |
| AUTH-41 | **MFA cannot be enforced by an organisation** | Search for a policy/required flag | Absent — record as R/AUDIT §4.1 medium finding | STATIC |

### 6.5 Password recovery (DEC-030)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| AUTH-42 | Forgot-password **always** returns 202 (no enumeration) | Read the route and the service | Identical response and (ideally) timing for unknown emails | **RUNTIME** |
| AUTH-43 | Reset token is random, hashed, single-use, TTL 1 h | `password_resets` table + service | Confirmed | STATIC |
| AUTH-44 | Requesting a second reset invalidates the first | `auth-repo.ts` bulk-invalidate | Confirmed | STATIC |
| AUTH-45 | Using a reset token marks it used atomically | `UPDATE … WHERE used_at IS NULL` | Confirmed | STATIC |
| AUTH-46 | Reset revokes existing sessions | Read the flow | Confirmed or documented | STATIC |
| AUTH-47 | **The reset link is never delivered — no mail transport exists** | `grep -rniE "nodemailer\|smtp\|sendgrid\|mailgun\|resend\|postmark" package.json apps/*/package.json apps/backend/src` | Zero hits → **CRITICAL functional finding (R-02)** | **RUNTIME** |
| AUTH-48 | The reset token cannot leak via logs | Check logging on the forgot route | No token logged | STATIC |

### 6.6 Rate limiting and brute force

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| AUTH-49 | Login is limited per IP **and** per account | `container.ts` limiter keys | Both | STATIC |
| AUTH-50 | The limiter is in-process (resets on restart, no cross-replica coordination) | `AttemptLimiter` | Confirmed — quantify the bypass | STATIC |
| AUTH-51 | The `hits` map never evicts expired entries | `tokens.ts` | **Memory growth under abuse — confirm and report** | STATIC |
| AUTH-52 | The limiter key uses the real client IP | `request.ip` + `TRUST_PROXY` (default **true**) | A forged `X-Forwarded-For` bypasses per-IP limits unless `TRUST_PROXY=false` — confirm exploitability | **RUNTIME** |
| AUTH-53 | 429 responses carry `Retry-After` | Route behaviour | Present | STATIC |
| AUTH-54 | Successful login resets the failure counter | Search for `.reset(` | Present or absent — record | STATIC |

### 6.7 Credential transport in clients

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| AUTH-55 | Desktop stores tokens only via `safeStorage` (OS keychain) | `electron-main.ts` `writeTokens` | Encrypted, mode 0o600, deleted on sign-out | STATIC |
| AUTH-56 | Desktop never uses `localStorage`/`sessionStorage` for tokens | `grep -rn "localStorage\|sessionStorage" apps/desktop/src` | Zero | STATIC |
| AUTH-57 | Desktop refresh is single-flight | `apps/desktop/src/api/client.ts` | Concurrent 401s do not each rotate | STATIC |
| AUTH-58 | Mobile stores credentials only in the keychain | `secureStore.ts` `ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY` | Confirmed | STATIC |
| AUTH-59 | Mobile has no plaintext fallback | `memoryStore.ts` is tests-only | Confirm it is never used in production paths | STATIC |
| AUTH-60 | Sign-out clears both stores | Desktop + mobile | Confirmed | STATIC |

---

## 7. Known authentication risks to confirm or refute

| Risk | Statement |
|------|-----------|
| **R-02 (CRITICAL)** | Password reset has no delivery mechanism — recovery is impossible for an end user |
| R-25 (LOW/MEDIUM) | One secret is used for JWT signing and credential encryption |
| R-18 (MEDIUM) | `AttemptLimiter` is in-process, unbounded, and IP-spoofable behind `TRUST_PROXY=true` |
| R-08 | `AUDIT-2026-10.md` claims MFA closed the last security-review blocker — verify each claim rather than trusting it |

---

## 8. Questions you must answer

1. Can a stolen refresh token be used twice? If yes, is the theft detectable?
2. Is a phished TOTP code replayable within its window? What limits it?
3. What is the exact sequence that turns the shared `JWT_SECRET` into a credential-rotation incident?
4. How does a user who forgot their password actually recover the account **today**?
5. What does "sign out everywhere" guarantee, and what does it not guarantee (stateless access tokens)?
6. How many login attempts can an attacker make per hour against one account, and against many accounts?
7. If a user's phone is stolen, what must they do, and in what order, to prevent document leakage?

---

## 9. Commands to run

```bash
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund
npm run db:migrate && npm run db:seed
npm run dev:backend &

# --- unit + integration suites for auth ---
npx jest --config jest.config.cjs --selectProjects backend --runInBand \
  -t "password|token|login|logout|session|MFA|TOTP|recovery|reset"

# --- no mail transport (AUTH-47) ---
grep -rniE "nodemailer|smtp|sendgrid|mailgun|resend|postmark|amazon-ses" \
  package.json apps/*/package.json apps/backend/src ; echo "exit=$?  (no hits = confirmed)"

# --- secret usage census (AUTH-22) ---
grep -rn "JWT_SECRET" apps/backend/src
grep -rn "scryptSync\|createCipheriv\|createDecipheriv" apps/backend/src

# --- token handling ---
grep -n "expiresIn\|algorithms\|issuer\|audience" apps/backend/src/auth/tokens.ts
grep -rn "localStorage\|sessionStorage" apps/desktop/src apps/mobile/src

# --- enumeration probe ---
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:4000/api/v1/auth/password/forgot \
  -H 'content-type: application/json' -d '{"email":"known@example.com"}'
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:4000/api/v1/auth/password/forgot \
  -H 'content-type: application/json' -d '{"email":"nobody@example.com"}'   # must be identical

# --- brute force / spoofing ---
for i in $(seq 1 8); do
  curl -s -o /dev/null -w "%{http_code} " -X POST http://127.0.0.1:4000/api/v1/auth/login \
    -H 'content-type: application/json' -d '{"email":"owner@example.com","password":"wrong"}'
done; echo
curl -s -o /dev/null -w "spoof=%{http_code}\n" -X POST http://127.0.0.1:4000/api/v1/auth/login \
  -H 'X-Forwarded-For: 203.0.113.9' -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","password":"wrong"}'
```

---

## 10. Tests to perform

| # | Test | Procedure | Pass criterion |
|---|------|-----------|----------------|
| T-01 | Refresh token replay | Rotate once, replay the old token | Rejected; ideally the family is revoked |
| T-02 | Concurrent refresh | Fire the same refresh token twice in parallel | Exactly one succeeds |
| T-03 | Recovery code replay | Use one code, use it again | Second rejected |
| T-04 | TOTP boundary | Code from t−1, t, t+1, t+2 steps | Only the documented window accepted |
| T-05 | MFA disable with one factor | Password only, then code only | Both rejected |
| T-06 | MFA challenge misuse | Use the challenge JWT as a bearer token | Rejected (audience mismatch) |
| T-07 | JWT tampering | Flip `org`, `role`, `sub`; try `alg:none`; try a foreign signature | All rejected |
| T-08 | Reset token replay | Use a token twice | Second rejected |
| T-09 | Reset invalidation | Two forgot requests, use the first link | Rejected |
| T-10 | Enumeration | Forgot/login with known vs unknown email | Identical status; timing difference recorded |
| T-11 | Brute force | 8 failed logins from one IP | Rate limited with `Retry-After` |
| T-12 | Header spoofing | Repeat with a rotating `X-Forwarded-For` | Document the actual result under `TRUST_PROXY=true` |
| T-13 | Limiter memory | Drive 100 000 distinct keys, inspect RSS | Report growth; confirm the map never evicts |
| T-14 | Session revocation | Revoke a session, retry refresh | Rejected |
| T-15 | Logout-all | Revoke all, retry an existing refresh | Rejected |
| T-16 | Production config refusal | `NODE_ENV=production` with the default secret | Startup fails with an actionable message |

---

## 11. Evidence required

```
docs/reviewers/evidence/R05/
├── credential-lifecycle.md      # issued → used → rotated → revoked, per credential type
├── key-management.md            # every use of JWT_SECRET + rotation consequence
├── mfa-review.md                # enrolment, challenge, recovery, disable, enforcement gap
├── recovery-gap.md              # R-02 evidence + the blocked user journey
├── rate-limit-analysis.md       # limits, evasion paths, memory growth measurement
├── transcripts/                 # T-01 … T-16 raw output
├── commands.log
└── findings.md                  # AUTH-### register
```

---

## 12. Passing conditions (co-signs G3)

- [ ] **P1** Argon2id at or above OWASP parameters, constant-time verify, no plaintext logging (AUTH-01 … AUTH-08).
- [ ] **P2** Access tokens pinned to HS256 with issuer/audience validation and ≤15 min TTL (AUTH-11 … AUTH-14).
- [ ] **P3** Refresh tokens are opaque, hashed, rotated, and **reuse is detected or its absence is accepted in writing** (AUTH-15 … AUTH-18).
- [ ] **P4** Key reuse across token signing and credential encryption is either separated or formally accepted with a rotation plan (AUTH-22 … AUTH-25).
- [ ] **P5** MFA: constant-time, encrypted secret, single-purpose challenge, atomic recovery codes, two-factor disable (AUTH-27 … AUTH-40).
- [ ] **P6** No user enumeration on forgot-password or login (AUTH-42, T-10).
- [ ] **P7** Rate limiting exists on every credential endpoint, and its bypass paths are documented (AUTH-49 … AUTH-54).
- [ ] **P8** Client token storage is keychain-only on both platforms (AUTH-55 … AUTH-60).
- [ ] **P9** **R-02 is recorded as CRITICAL**: password recovery is undeliverable, so the feature is not usable (AUTH-47).
- [ ] **P10** Every claim in `AUDIT-2026-10.md` §4.1 relevant to authentication has been independently re-verified.

---

## 13. Blocked items

| Item ID | Blocker | What unblocks it | Owner |
|---------|---------|------------------|-------|
| AUTH-47 | A mail transport does not exist to test delivery | R19 to add one; until then the finding stands | R19 |
| AUTH-13 | No Electron runtime to verify client refresh single-flight in a packaged app | R10 supplies a packaged build | R10 |

---

## 14. Findings register

| ID | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
|----|----------|-----------|---------|----------------|-----------|---------------|-------|
| AUTH-001 | | | | | | | |

---

## 15. Reviewer sign-off

| Field | Value |
|-------|-------|
| Reviewer name | |
| Date started | |
| Date completed | |
| **G3 co-sign result** | ☐ Pass ☐ Fail ☐ Abstain |
| Conditions failed (IDs) | |
| Reviewed commit | `43d384b` |
| Statement | *I read `auth-service.ts`, `tokens.ts`, `totp.ts`, `password.ts`, `auth-repo.ts` and `auth-routes.ts` in full, and executed T-01 … T-16 against a running server.* |
| Signature | |
