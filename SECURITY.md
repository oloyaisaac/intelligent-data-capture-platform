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
| Injection           | SQL or spreadsheet formula injection on export | Parameterised queries, formula-neutralising on CSV/XLSX export                                |
| Prompt/AI injection | Document text instructing the AI model         | Treat document text as untrusted data; never let it alter system behaviour or trigger actions |
| Insider misuse      | Employee exporting the whole database          | RBAC, audit trail, export rate limits, review of bulk actions                                 |
| Supply chain        | Compromised npm package                        | Lockfile, dependency scanning, no postinstall scripts from unvetted packages                  |

## 3. Secrets

**MUST NOT** commit: `.env`, API keys, database passwords, JWT signing keys, OAuth client secrets, TLS private keys, connector credentials, customer documents or tokens in test fixtures.

- All configuration comes from environment variables (see `.env.example`).
- Production secrets live in the platform's secret manager, injected at deploy time — never in the repository or a built artefact.
- Secrets are separated per environment (dev/staging/production) and rotated on suspected exposure.
- Secrets are **never** logged, never returned by the API and never included in error messages.
- Connector credentials are stored encrypted (`connectors.credentials_encrypted`), decrypted only in the worker at the moment of use.
- If a secret is committed by mistake: rotate it immediately, purge it from history, and record the incident.

## 4. Authentication

- Passwords hashed with **Argon2id** (memory ≥ 64 MB, iterations ≥ 3, parallelism 1) with per-user salts. Never SHA/MD5/hand-rolled crypto.
- Minimum password policy: 12 characters, checked against a breached-password list.
- Access tokens: JWT, ≤ 15 minutes, `HS256`/`RS256` with a per-environment key, containing only `sub`, `org`, `role`, `exp`, `iat`.
- Refresh tokens: opaque, single-use, rotating, hashed at rest, revocable, bound to a session record.
- Login: rate limited (5 attempts / 15 min per IP **and** per account), generic error messages, timing-safe comparison, lockout with exponential delay.
- Password reset tokens: single-use, ≤ 30 minutes, invalidated on password change, never logged.
- Device credentials: 256-bit random, hashed at rest, stored on the device in **secure storage** (Android Keystore / iOS Keychain / OS keychain on desktop), never in plain preferences or AsyncStorage.
- Multi-factor authentication is required for the `owner` and `admin` roles before enterprise release.

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
- Socket.IO over `wss://` only; plaintext connections refused.

### 6.2 At rest

- Database encryption at rest (managed disk encryption) plus application-level encryption for connector credentials and device credential hashes.
- Object storage with server-side encryption (SSE-S3 or KMS); buckets private; no public objects at any time.
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
- Retention is configurable per organisation (`SEC-001`) and deletion is real (objects + rows), verified by `TC-11`.
- No customer data is used to train models without explicit, revocable opt-in.
- Data-subject requests (access, deletion, export) must be answerable from the audit trail and records.
- Data-residency is a pending decision (`PRD.json` Q-003).

## 7. Input and upload safety

- Validate every request body against a schema (Zod); reject unknown fields.
- Uploads: allow-list of MIME types, size limit (20 MB/image, 50 MB/request), content sniffing (magic bytes), image re-encoding to strip metadata (EXIF, GPS), filename never used as a storage path.
- Object storage keys are generated server-side; never derived from user input.
- CSV/XLSX export neutralises leading `=`, `+`, `-`, `@` to prevent formula injection.
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
