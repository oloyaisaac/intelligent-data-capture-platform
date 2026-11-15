# REVIEWER NAME: Authentication Engineer (R05)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R05-authentication-engineer.md` (60 checklist items)
**STATUS:** ☑ Complete

---

## AREAS EXAMINED

Password hashing · token issuance and verification · refresh rotation · password reset (DEC-030) · MFA/TOTP (DEC-034) · recovery codes · session invalidation · API keys · device credentials · rate limiting.

---

## 1. Summary of examination

I read `auth/password.ts`, `auth/tokens.ts`, `services/auth-service.ts` (903 LOC), `services/crypto.ts`, `http/guards.ts`, and the auth routes, then executed the auth-related suites (`auth`, `auth-recovery`, `mfa`, `totp`, `devapi`, `terms`).

**Verdict: the cryptographic primitives are correct and, in places, better than typical.** Argon2id at OWASP parameters, refresh tokens stored hashed with rotation, single-use reset and invitation tokens, and production refusing a weak `JWT_SECRET`. The defects are architectural rather than algorithmic — above all, **one secret serves three unrelated cryptographic purposes**, which makes key rotation unrecoverable.

---

## 2. Files and components inspected

| File | LOC | Checked |
|---|---|---|
| `apps/backend/src/auth/password.ts` | — | Argon2id parameters |
| `apps/backend/src/auth/tokens.ts` | 141 | JWT, `AttemptLimiter`, hashing |
| `apps/backend/src/services/auth-service.ts` | 903 | login, refresh, reset, MFA, invitations |
| `apps/backend/src/services/crypto.ts` | — | `SecretBox`, AES-256-GCM, AAD |
| `apps/backend/src/services/container.ts` | 88 | **key wiring — line 84** |
| `apps/backend/src/config.ts` | — | secret validation |
| `apps/backend/src/http/routes/auth-routes.ts` | — | 19 auth routes |

---

## 3. Features examined

Login · registration · refresh rotation · logout/session revocation · password reset · password change · MFA enrolment and verification · recovery codes · API key auth · device credential auth · rate limiting.

---

## 4. Tests performed

| Test | Method | Result |
|---|---|---|
| T1 Auth suites | `npx jest auth mfa totp auth-recovery terms` | **PASS** |
| T2 Argon2id params | read `password.ts:17-19` | **PASS** — 64 MiB, t=3, p=1 |
| T3 Refresh rotation | read `auth-service.ts` rotate path | **PASS** — old token invalidated |
| T4 Reset single-use | read `resetPassword` | **PASS** — `markUsed` guard |
| T5 Invitation single-use | read `auth-service.ts:807-819` | **PASS** |
| T6 Production secret strength | read `config.ts:122-127` | **PASS** — default rejected, ≥32 chars |
| T7 **Key separation** | read `container.ts:84` | **FAIL — see AUTH-001** |
| T8 Reset delivery | read `requestPasswordReset` | **FAIL in production — see AUTH-002** |
| T9 MFA enforceability | grep for org-level policy | **NOT IMPLEMENTED** — see AUTH-003 |
| T10 Client refresh single-flight | read `client.ts` | **PASS** (renderer) — untestable in packaged app |

---

## 5. Successful findings

1. **Argon2id at OWASP parameters** (`memoryCost: 65_536, timeCost: 3, parallelism: 1`) — not a placeholder, not bcrypt-with-cost-10.
2. **Refresh tokens are rotated and stored hashed.** A stolen DB does not yield usable refresh tokens.
3. **Reset and invitation tokens are single-use with a raced `markUsed` check** — the code comments note this is what makes concurrent submission safe, and it is.
4. **`setAAD(context)` binds ciphertext to tenant/user context**, so a ciphertext lifted from one row cannot be replayed into another.
5. **Production refuses the development secret** and enforces ≥32 characters.
6. **`AttemptLimiter` covers login, forgot and reset** with per-IP keys and `Retry-After` headers.

---

## 6. Identified problems

### AUTH-001 — `JWT_SECRET` is used for token signing **and** as the AES key for connector credentials **and** MFA secrets

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | `apps/backend/src/services/container.ts:84`; `services/crypto.ts:19` |
| **Evidence** | `const secretBox = createSecretBox(config.JWT_SECRET);` and inside `crypto.ts`, `const key = scryptSync(secret, 'idcp-connector-credentials', 32);`. The same `JWT_SECRET` therefore (a) signs access tokens, (b) derives the key encrypting Google/Odoo/HubSpot/QuickBooks/Postgres/MySQL credentials, and (c) encrypts `mfa_secret_enc`. |
| **Expected** | Independent keys per purpose, with independent rotation |
| **Actual** | Rotating `JWT_SECRET` — the standard response to a suspected token compromise — makes **every stored connector credential and every enrolled MFA secret permanently undecryptable**. Nonce and AAD are per-row, so the ciphertext cannot be re-derived. |
| **Verification** | Read the two lines; then `grep -rn "createSecretBox" apps/backend/src` → one call site |

**Why HIGH:** this converts a routine security operation (rotate a signing key) into a destructive one (all integrations break, all MFA users locked out). It also means a leak of `JWT_SECRET` compromises data-at-rest encryption, not just session integrity — a confidentiality escalation the architecture does not state anywhere.

**Recommended correction:** Introduce `ENCRYPTION_KEY` (or a KMS reference) as a separate config value; derive the `SecretBox` key from it. Add a key-version prefix to stored ciphertext so future rotation is possible without re-encrypting everything at once.

**Verification requirements:** Two distinct config values; a test asserting that changing `JWT_SECRET` alone does not break credential decryption; a documented rotation runbook.

---

### AUTH-002 — Password reset cannot be completed by an end user in production

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | `apps/backend/src/services/auth-service.ts` `requestPasswordReset`; `auth-routes.ts:116` |
| **Evidence** | In production the code logs `'password reset token not delivered: no email transport is configured (DEC-030)'` and returns `{ accepted: true }` — no link. Outside production it returns `resetUrl` in the response body. |
| **Expected** | A user who forgets their password can regain access unaided |
| **Actual** | Regaining access requires an operator to read the database or logs. The code comment states this is deliberate. |
| **Verification** | `grep -rniE "nodemailer\|smtp\|sendgrid" package.json apps/*/package.json` → zero hits; read the production branch |

**Important nuance:** this is a **deliberate architectural decision (DEC-030)**, not an oversight, and the code documents it honestly. That does not change its user-facing severity: the product's own Terms imply account recovery, and a self-serve SaaS cannot require operator intervention per reset.

**Recommended correction:** Add a transport (SMTP/SES/Resend) behind an interface, with a `NullTransport` for environments without one. The interface and the dev-mode `resetUrl` already exist, so the work is small.

**Verification requirements:** An end-to-end test that requests a reset with a test mail sink and completes the flow from the delivered link.

---

### AUTH-003 — MFA cannot be required by an organisation

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | `auth-service.ts` (MFA enrolment is per-user); no policy setting |
| **Evidence** | TOTP enrol/verify/recovery is implemented (DEC-034), but no organisation-level setting forces enrolment, and no route exposes one. |
| **Expected** | An owner can require a second factor for all members |
| **Actual** | Optional per user only |
| **Verification** | `grep -rn "require.*mfa\|mfa.*policy\|enforce_mfa" apps/backend/src` → zero |

**Recommended correction:** Add `organisations.require_mfa` and enforce it in `guards.authenticate` (reject tokens from unenrolled users). This is a standard enterprise procurement gate.

---

### AUTH-004 — Device credentials are long-lived with no rotation

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | `apps/backend/src/services/pairing*`; `guards.ts:30-40` |
| **Evidence** | `X-Device-Credential` is accepted indefinitely until the device is revoked. No expiry, no rotation after use. |
| **Expected** | Long-lived device credentials should be revocable (they are) **and** ideally rotate or expire |
| **Actual** | Revocation only |
| **Verification** | STATIC |

**Recommended correction:** Record the decision explicitly (revocation-only is defensible for paired hardware), or add rotation.

---

### AUTH-005 — Session revocation on password change does not explicitly cover device credentials

| Field | Value |
|---|---|
| **Severity** | **LOW** |
| **Affected** | `auth-service.ts` change-password path |
| **Evidence** | Refresh tokens are invalidated; paired devices continue to authenticate with their credential until separately revoked. |
| **Expected** | Documented behaviour either way |
| **Actual** | Implicit |
| **Verification** | STATIC |

**Recommended correction:** State the behaviour in `SECURITY.md`; consider revoking devices on password change.

---

## 7. Missing functionality

| Item | Status |
|---|---|
| Mail transport for reset/invitation | **Not implemented** (AUTH-002) |
| Organisation-level MFA policy | **Not implemented** (AUTH-003) |
| Separate encryption key | **Not implemented** (AUTH-001) |
| SSO / SAML / OIDC | **Not implemented** — no code |
| Key rotation runbook | **Not implemented** |
| WebAuthn / passkeys | **Not implemented** |

---

## 8. Security concerns

The dominant concern is AUTH-001 (key separation), which turns one secret into a three-way single point of failure. Secondary: no enforceable MFA (AUTH-003), and reset requires operator intervention (AUTH-002), which in practice encourages weak operational workarounds. No algorithmic weakness found in hashing, token generation, or the AEAD construction.

---

## 9. Performance concerns

Argon2id at 64 MiB is intentionally expensive; at high login concurrency this is a CPU/memory consideration. Deferred to R17.

---

## 10. Recommendations

1. **Separate the encryption key (AUTH-001).** Highest value, lowest cost, and it unblocks safe key rotation.
2. Add a mail transport behind the interface that already exists (AUTH-002).
3. Add enforceable MFA (AUTH-003) — a standard procurement requirement.
4. Document the device-credential lifetime decision (AUTH-004/005).

---

## EVIDENCE CLASSIFICATION

| Class | Items |
|---|---|
| **A. Verified working** | Argon2id params, refresh rotation, reset/invitation single-use, AAD tenant binding, production secret enforcement, rate limiting |
| **B. Verified failing** | AUTH-001, AUTH-002 |
| **C. Not implemented** | Mail transport, MFA policy, separate key, SSO, rotation runbook, WebAuthn |
| **D. Partially implemented** | MFA (works per-user, not enforceable); device credentials (revocable, not expiring) |
| **E. Unable to verify** | Packaged-app refresh single-flight (needs a packaged build); real mail delivery (no transport) |

---

## ISSUE SUMMARY

| ID | Severity | Title |
|---|---|---|
| AUTH-001 | **HIGH** | One `JWT_SECRET` signs tokens and encrypts credentials + MFA secrets |
| AUTH-002 | **HIGH** | Password reset undeliverable in production |
| AUTH-003 | MEDIUM | MFA not enforceable by organisation policy |
| AUTH-004 | MEDIUM | Device credentials never rotate or expire |
| AUTH-005 | LOW | Password change does not revoke device credentials |

**Totals: 0 CRITICAL · 2 HIGH · 2 MEDIUM · 1 LOW**
