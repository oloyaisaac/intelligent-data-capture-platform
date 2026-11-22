# Security

Security rulebook for the AI Universal Data Capture Platform. This product handles invoices, ID documents, contracts and personal data — treat every document as sensitive.

> Violating anything marked **MUST** is a release blocker.
> Found a vulnerability? Do not open a public issue; see §11.

---

## 1. Principles

1. **Least privilege** — every person, device, key and process gets the minimum access required.
2. **Defence in depth** — validate on the client, again on the server, and again at the data layer.
3. **Tenant isolation by default** — every query is scoped to the caller's organisation; isolation lives in the data layer, not only the UI.
4. **Assume the device is hostile** — authentication and authorisation are enforced server-side, always.
5. **Data minimisation** — do not collect, log or retain what you do not need.
6. **Fail closed** — if authorisation cannot be determined, refuse.

## 2. Threat model (summary)

| Threat              | Example                                        | Mitigation                                                                                    |
| ------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Credential theft    | QR code photographed and reused                | Short-lived single-use pairing tokens, hashed at rest, device revocation                      |
| Cross-tenant access | Guessing another organisation's document ID    | Tenant-scoped queries, `404` rather than `403`, tests (`TC-10`)                               |
| Document leakage    | Public bucket or unprotected download URL      | Private storage, brokered downloads, short-lived signed URLs                                  |
| Malicious upload    | Executable disguised as an image               | Content sniffing, MIME allow-list, size limits, no execution, no image-metadata passthrough   |
| Injection           | SQL or spreadsheet formula injection on export | Parameterised queries; CSV text prefixing and XLSX string cells provide partial mitigation    |
| Prompt/AI injection | Document text instructing the AI model         | Treat document text as untrusted data; never let it alter system behaviour or trigger actions |
| Insider misuse      | Employee exporting the whole database          | RBAC, audit trail, export rate limits, review of bulk actions                                 |
| Supply chain        | Compromised npm package                        | Lockfile, dependency scanning, no postinstall scripts from unvetted packages                  |

### Connector network boundary

The first-party HTTP connectors have HTTPS, DNS-address and redirect restrictions. These do **not**
protect SQL connector connections or filesystem connectors; deployments need separate egress and
filesystem isolation before allowing untrusted tenants to configure connectors. See
[connector network security](docs/connector-network-security.md) for the current controls,
compatibility changes and limitations.

## 3. Secrets

**MUST NOT** commit: `.env`, API keys, database passwords, JWT signing keys, OAuth client secrets, TLS private keys, connector credentials, customer documents or tokens in test fixtures.

- All configuration comes from environment variables (see `.env.example`).
- Production secrets live in the platform's secret manager, injected at deploy time — never in the repository or a built artefact.
- Secrets are separated per environment (dev/staging/production) and rotated on suspected exposure.
- Secrets must not be logged, returned by the API or included in error messages. This is a security
  requirement, **not an established guarantee**; see the connector configuration exception below
  and R01 findings ARC-016, ARC-017 and ARC-023.
- New or replaced connector configurations and credentials are encrypted together in
  `connectors.credentials_encrypted`, decrypted in the backend for use, and not returned by the
  connector DTO. **Existing rows can still contain plaintext** until the offline configuration
  migration is run and verified; database files, logs, replicas and backups may retain old copies.
  Review access and rotation of any previously exposed credentials. This is not process isolation,
  and historical error fields or other connector outputs may contain sensitive data. See
  `docs/connector-config-migration.md` and R01 findings ARC-016, ARC-017 and ARC-023.
- If a secret is committed by mistake: rotate it immediately, purge it from history, and record the incident.

## 4. Authentication

- Passwords hashed with **Argon2id** (memory ≥ 64 MB, iterations ≥ 3, parallelism 1) with per-user salts. Never SHA/MD5/hand-rolled crypto.
- Minimum password policy: 12 characters, checked against a breached-password list.
- Access tokens: JWT, ≤ 15 minutes, `HS256`/`RS256` with a per-environment key, containing only `sub`, `org`, `role`, `exp`, `iat`.
- Refresh tokens: opaque, single-use, rotating, hashed at rest, revocable, bound to a session record.
- Login: rate limited (5 attempts / 15 min per IP **and** per account), generic error messages, timing-safe comparison, lockout with exponential delay.
- Password reset tokens: 256-bit random, stored only as a SHA-256 hash, single-use, ≤ 1 hour
  (`PASSWORD_RESET_TTL_SECONDS`, default 3600), invalidated on use and on password change, never
  logged. `POST /auth/password/forgot` answers `202` identically whether or not the account exists,
  so it cannot be used to enumerate users (DEC-030).
- A successful reset or password change revokes **every** session for the account; the desktop
  Account page exposes the same through `GET /auth/sessions`, `DELETE /auth/sessions/{id}` and
  `POST /auth/logout-all`.
- Device credentials: 256-bit random, hashed at rest, stored on the device in **secure storage** (Android Keystore / iOS Keychain / OS keychain on desktop), never in plain preferences or AsyncStorage.
- Multi-factor authentication (TOTP, RFC 6238) is available on every account and **recommended** for
  `owner` and `admin` (DEC-034). It is not yet enforced by policy — an administrator cannot require
  it for a role, which is the remaining gap recorded in `AUDIT-2026-10.md` §4.1.
  - Enrolment (`POST /auth/mfa/enrol`) confirms the password and returns a secret plus an
    `otpauth://` URI; nothing is switched on until the first code is confirmed.
  - The secret is 160 bits of base32, encrypted at rest with AES-256-GCM and AAD `mfa:<userId>`, and
    is never returned again. An enabled factor is never bypassed if its secret is missing or
    undecryptable; a recovery code or a controlled support recovery is required.
  - `POST /auth/login` returns a five-minute `challengeToken` (JWT, `aud: idcp-mfa`) instead of a
    session. Only `POST /auth/mfa/verify` accepts it; it grants no refresh token on its own.
  - Codes are compared in constant time within ±1 time step. Verification is rate limited per client
    address, because the caller is not authenticated yet.
  - Ten single-use recovery codes are issued once, stored only as SHA-256 hashes of their normalised
    form, consumed on use and audited (`auth.mfa_recovery_used`).
  - Disabling requires the password **and** a live code, so a stolen session alone cannot remove it.
    Enabling, disabling and regenerating codes are all audited.

## 5. Authorisation

- Roles: `owner` > `admin` > `reviewer` > `operator` > `viewer`, scoped per organisation.
- Enforced in middleware **and** re-checked in the service layer for privileged actions.
- Every tenant-owned row carries `organisation_id`; the data access layer requires a tenant context and refuses queries without one.
- Objects are addressed by unguessable UUIDs, but this is never the only control.
- `404` is returned for resources outside the caller's organisation, so existence is not disclosed.
- Bulk operations (bulk approve, bulk export) re-check permission per item.

## 6. Data protection

### 6.1 In transit

- TLS 1.2+ everywhere, HSTS enabled, no mixed content.
- TLS only for the API and the server-push stream (`text/event-stream` over HTTPS); plaintext connections refused.

### 6.2 At rest

- Database encryption at rest (managed disk encryption, which for SQLite means the host volume) plus application-level encryption for connector credentials and device credential hashes.
- Object storage with server-side encryption (SSE-S3 or KMS); buckets private; no public objects at any time.
  The filesystem driver used by the shipped single-process deployment (DEC-029) relies on the host disk's
  encryption and on `STORAGE_PATH` being outside the web root; `s3` encryption applies once that driver is built.
- Backups encrypted and access-restricted; restore tested (`DEPLOYMENT.md`).

### 6.3 Desktop hardening (Electron)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no `remote` module.
- IPC is allow-listed, validated and typed; the renderer cannot reach the filesystem or shell directly.
- External links open in the system browser, never in an app window; `will-navigate` restricted to the app origin.
- Content Security Policy set, with no `unsafe-eval`.
- Tokens stored in the OS keychain, not local storage.
- Code signing on Windows and macOS; auto-update over HTTPS with signature verification.

### 6.4 Mobile hardening

- No secrets in the JS bundle; API base URL configured, not hardcoded per environment.
- Certificate pinning for the API domain (with a documented rotation plan).
- Screenshot protection on review screens where supported; no document content in app-switcher snapshots.
- Local queues encrypted at rest; wipe on sign-out.
- Debug builds are never distributed.

### 6.5 Personal data

- Inventorise fields marked 🔒 in `DATABASE.md` as personal data.
- Retention is configurable per organisation, but complete deletion is **not established**. The
  current retention job soft-deletes document metadata and attempts the primary file only; it skips
  already soft-deleted documents and does not remove separate page files, extraction/review data,
  backups or logs. Storage and database updates are not atomic. Do not represent `TC-11` as proof of
  complete deletion. Known cross-tenant references from documents, pages, exports and template
  samples block file deletion for retention, erasure and expired exports, but the check can race
  new references and storage changes. See R01 finding ARC-024 and `DEPLOYMENT.md`.
- No customer data is used to train models without explicit, revocable opt-in.
- Data-subject requests are served by the product, not by hand: `GET /me/export` returns everything held
  about the caller as a JSON attachment, and `POST /me/erase` anonymises the account, revokes its
  sessions and devices, deletes unreviewed drafts and their files, and audits
  `privacy.account_erased`. Approved records and the audit trail are retained, stripped of identifying
  details, because they belong to the organisation and may carry a retention duty.
- Data-residency is a pending decision (`PRD.json` Q-003).

## 7. Input and upload safety

- Validate every request body against a schema (Zod); reject unknown fields.
- Uploads: allow-list of MIME types, size limit (20 MB/image, 50 MB/request), content sniffing (magic bytes), image re-encoding to strip metadata (EXIF, GPS), filename never used as a storage path.
- Object storage keys are generated server-side; never derived from user input.
- CSV exports prefix formula-like headers and text values as a partial mitigation; XLSX uses string cells for text. Spreadsheet software and import modes can differ, and historical files are not sanitized. See `docs/csv-formula-safety.md`.
- All SQL through the ORM or parameterised queries; no string concatenation.
- User-supplied content is escaped in UI and email; no `dangerouslySetInnerHTML` with untrusted data.

## 8. AI-specific safety

- Document content is **data, not instructions**. Prompts must place extracted text in a clearly delimited, untrusted block and never execute actions based on it.
- AI output is validated against the UDM schema; malformed or out-of-range output is rejected, not coerced.
- Confidence is preserved; below-threshold fields require human review before any external write.
- Cloud AI providers require approval (`PRD.json` Q-001), a data-processing agreement and a recorded decision. Send only the minimum page content needed.
- Local mode must work with outbound internet blocked.
- Log provider, model, latency and cost per call — never the document content.

## 9. Rate limiting and abuse

Limits from `API.md` §10 are enforced at the edge and in the app. Authentication, pairing, upload and export are the priority surfaces. 429 responses include `Retry-After`. Repeated abuse triggers account-level throttling and is audited.

## 9.1 Response hardening

Every response carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, a `default-src 'none'` Content-Security-Policy,
`Cross-Origin-Opener-Policy`/`Cross-Origin-Resource-Policy: same-origin` and a `Permissions-Policy`
that turns off camera, microphone and geolocation. `Strict-Transport-Security` is sent **only** when
`NODE_ENV=production`, because HSTS over a local HTTP server poisons a developer's browser. Asserted by
`apps/backend/test/web-surface.test.ts`.

## 9.2 Access log

Every request produces one structured line on response: method, path, status, duration, request id and
the authenticated user and organisation when there is one. Bodies, query strings and headers are not
logged, so credentials and tokens cannot leak through it.

## 10. Audit trail

Append-only `audit_logs`: authentication events (success/failure), device pairing and revocation, document access and deletion, review approvals and edits, export creation and download, connector creation/use, role and retention changes. Never editable or deletable through the application. Retained ≥ 24 months.

## 11. Reporting a vulnerability

Report privately to the project owner (see `DECISIONS.md` DEC-011) with steps to reproduce and impact. Do not exploit beyond proof of concept, do not access other users' data, and do not disclose publicly before a fix ships. Acknowledgement within 3 working days.

## 12. Incident response

1. **Contain** — revoke tokens/keys, disable the affected device or connector, isolate the environment if needed.
2. **Assess** — what data, whose, how much, from the audit trail and logs.
3. **Eradicate and recover** — patch, rotate secrets, restore from verified backup.
4. **Notify** — owner and affected customers as required by law and contract.
5. **Review** — post-incident notes, add a regression test, record a decision if the architecture changes.

## 13. Pre-release security checklist

- [ ] No secrets in the repository, history, logs or artefacts.
- [ ] Dependency audit clean (or exceptions documented).
- [ ] All non-public endpoints authenticated and authorised; tenant isolation tested (`TC-10`).
- [ ] Upload validation, rate limits and export injection protection verified (`TC-08`, `TC-12`).
- [ ] Audit records emitted for privileged actions.
- [ ] Electron/mobile hardening flags confirmed in shipped builds.
- [ ] Retention and deletion verified (`TC-11`).
- [ ] Backups encrypted and a restore has been tested.
- [ ] Privacy/security disclosures updated for app-store submission.
- [ ] `legal/` placeholders replaced and `npm run test:legal` green (`AUDIT-2026-10.md` §2).
- [ ] Password recovery exercised end to end, including the production path where no `resetUrl`
      is returned and the operator delivers the link.
