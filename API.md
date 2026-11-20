# API

Contract between the mobile app, desktop app, backend and integrators.

> **Status:** implemented and enforced. `docs/openapi.yaml` is checked against the registered routes
> by `npm run test:api`, so a route that is not documented (or a documented route that does not
> exist) fails CI. Paths below are relative to the versioned prefix: the health endpoint, for
> example, is `GET /api/v1/health` — there is no bare `/health`.

---

## 1. Conventions

- Base URL: `https://api.<domain>/api/v1` (production). Local: `http://localhost:4000/api/v1`.
- Transport: HTTPS only. JSON request and response bodies (`Content-Type: application/json`), except uploads (`multipart/form-data`).
- Versioning: path-based (`/api/v1`). Breaking changes require a new major path segment.
- Auth: `Authorization: Bearer <access-token>`; device-scoped endpoints also accept a device credential.
- IDs: UUID strings. Timestamps: ISO-8601 UTC.
- Pagination: `?limit=` (default 25, max 100) and cursor `?cursor=`; responses include `nextCursor`.
- Idempotency: mutating endpoints that write data accept `Idempotency-Key`.
- Request tracing: every response includes `X-Request-Id`; send your own to correlate logs.

### Error envelope

```json
{
  "error": {
    "code": "FIELD_VALIDATION_FAILED",
    "message": "Total amount must be a number.",
    "details": [{ "path": "fields.total.amount", "message": "expected number" }],
    "requestId": "req_01HZX..."
  }
}
```

| HTTP | Code examples                             | Meaning                                             |
| ---- | ----------------------------------------- | --------------------------------------------------- |
| 400  | `FIELD_VALIDATION_FAILED`, `INVALID_JSON` | Malformed or invalid input                          |
| 401  | `UNAUTHENTICATED`, `TOKEN_EXPIRED`        | Missing/invalid credentials                         |
| 403  | `FORBIDDEN`, `ROLE_REQUIRED`              | Authenticated but not allowed                       |
| 404  | `NOT_FOUND`                               | Resource absent or outside your organisation        |
| 409  | `CONFLICT`, `DUPLICATE_KEY`               | State conflict                                      |
| 413  | `PAYLOAD_TOO_LARGE`                       | Upload exceeds limit                                |
| 415  | `UNSUPPORTED_MEDIA_TYPE`                  | File content not allowed                            |
| 422  | `UNPROCESSABLE`                           | Valid shape, cannot process (e.g. expired QR token) |
| 429  | `RATE_LIMITED`                            | Too many requests — honour `Retry-After`            |
| 500  | `INTERNAL_ERROR`                          | Unexpected failure, safe message only               |

Never leak stack traces, SQL, internal paths or another tenant's identifiers.

---

## 2. System

### `GET /health`

No auth. Returns `200` when the API and its critical dependencies are reachable. `dependencies` reports
each one by name; the database is the only external dependency of the shipped runtime (DEC-029).

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptimeSeconds": 4213,
  "dependencies": { "db": "ok" }
}
```

---

## 3. Authentication

| Method | Path                       | Purpose                                                       |
| ------ | -------------------------- | ------------------------------------------------------------- |
| POST   | `/auth/register`           | Create account + organisation (owner role)                    |
| POST   | `/auth/login`              | Email + password → access + refresh token                     |
| POST   | `/auth/refresh`            | Rotate refresh token, issue new access token                  |
| POST   | `/auth/logout`             | Revoke the presented refresh token                            |
| POST   | `/auth/password/forgot`    | Send reset link (always 202, never reveals account existence) |
| POST   | `/auth/password/reset`     | Consume single-use reset token                                |
| POST   | `/auth/password/change`    | Change the password of the signed-in user                     |
| GET    | `/auth/sessions`           | Live sessions for the caller                                  |
| DELETE | `/auth/sessions/{id}`      | Revoke one of the caller's own sessions                       |
| POST   | `/auth/logout-all`         | Sign out everywhere                                           |
| POST   | `/auth/terms/accept`       | Accept the current legal pack (DEC-032)                       |
| GET    | `/auth/me`                 | Current user, roles and organisation                          |
| GET    | `/auth/mfa`                | Whether this account has a second factor (DEC-034)            |
| POST   | `/auth/mfa/enrol`          | Start TOTP enrolment: secret + `otpauth://` URI               |
| POST   | `/auth/mfa/enrol/confirm`  | Confirm the first code, receive recovery codes                |
| POST   | `/auth/mfa/verify`         | Exchange a login challenge for a session                      |
| POST   | `/auth/mfa/disable`        | Turn the second factor off (password + live code)             |
| POST   | `/auth/mfa/recovery-codes` | Replace the recovery codes (live code required)               |

`POST /auth/login`

```json
// request
{ "email": "ops@example.com", "password": "…" }
// response 200
{
  "accessToken": "eyJ…", "expiresIn": 900,
  "refreshToken": "rt_…", "user": { "id": "uuid", "displayName": "Amina", "role": "admin", "organisationId": "uuid" }
}
```

**Two-factor sign-in (DEC-034).** When the account has a second factor, the same request answers
`200` with a challenge instead of a session:

```json
// response 200 — second factor required
{ "mfaRequired": true, "challengeToken": "eyJ…", "expiresInSeconds": 300 }
```

Discriminate on `mfaRequired`. Exchange the challenge at `POST /auth/mfa/verify` with a six-digit
code, or with one of the ten recovery codes (each works once):

```json
// POST /auth/mfa/verify
{ "challengeToken": "eyJ…", "code": "123456" }
// response 200 — the usual token pair
{ "accessToken": "eyJ…", "expiresIn: 900, "refreshToken": "rt_…", "user": { … } }
```

The challenge is a five-minute JWT (`aud: idcp-mfa`) that only this endpoint accepts; it carries no
refresh token, so an abandoned sign-in leaves nothing behind. Enrolment is two steps — `POST
/auth/mfa/enrol` (password in, secret + `otpauth://` URI out, nothing enabled yet) then `POST
/auth/mfa/enrol/confirm` (first code in, `{ enabledAt, recoveryCodes }` out). The recovery codes are
shown exactly once: only their hashes are stored, so they cannot be read back — regenerate with
`POST /auth/mfa/recovery-codes`, which invalidates the old set. `POST /auth/mfa/disable` requires the
password **and** a live code.

Every token pair also carries `sessionId`, which identifies the server-side session: it is what
`GET /auth/sessions?current=<id>` uses to mark "this device", and it survives refresh rotation.

Rules: access tokens ≤ 15 minutes; refresh tokens rotate on every use and are single-use; login is
rate limited per IP and per account.

**Password recovery (DEC-030).** `POST /auth/password/forgot` always answers `202 { "accepted": true }`
— whether or not the address exists. This deployment sends no email, so outside production the body
also carries `resetUrl` (token included) so the flow can be completed locally; in production the
token is neither returned nor logged, and the operator delivers the link out of band. `POST
/auth/password/reset` is single-use and revokes every session for the account.

**Changing a password** revokes the other sessions; send your own `refreshToken` to keep the current
one alive. `POST /auth/logout-all` revokes everything, including the caller — that is the point of it.

**Terms acceptance (DEC-032).** `POST /auth/register` requires `acceptTerms: true`; the server records
the timestamp and `LEGAL_VERSION` (from `@idcp/shared`), not the client. `GET /auth/me` returns
`terms: { acceptedAt, version, current }`, and `POST /auth/terms/accept` writes the record for an
account created before the pack existed or whose pack has been revised. `current: false` is a prompt,
never a lockout.

**Sessions** are listed newest first with `createdAt`, `expiresAt`, `userAgent` and `current`. Auth
tokens are stateless, so a revoked session stops refreshing immediately while its access token
remains valid for up to 15 minutes; that is the documented window, not an accident.

---

## 4. Pairing and devices

| Method | Path                    | Purpose                                                     |
| ------ | ----------------------- | ----------------------------------------------------------- |
| POST   | `/pairing/sessions`     | Desktop requests a pairing session (returns token + expiry) |
| GET    | `/pairing/sessions/:id` | Poll status (`pending`/`completed`/`expired`)               |
| POST   | `/pairing/complete`     | Mobile exchanges the scanned token for a device credential  |
| GET    | `/devices`              | List paired devices                                         |
| PATCH  | `/devices/:id`          | Rename device                                               |
| DELETE | `/devices/:id`          | Revoke device (immediate)                                   |

`POST /pairing/sessions` → `201`

```json
{
  "id": "uuid",
  "token": "pair_7f3c…",
  "endpoint": "https://api.example.com/api/v1",
  "expiresAt": "2026-10-26T14:58:00Z",
  "qrPayload": "idcp://pair?e=https%3A%2F%2Fapi.example.com%2Fapi%2Fv1&t=pair_7f3c…"
}
```

QR payload contains only the endpoint and the short-lived token — no user identity, no organisation secrets.

`POST /pairing/complete`

```json
// request
{ "token": "pair_7f3c…", "device": { "name": "Pixel 8", "platform": "android", "appVersion": "0.1.0" } }
// response 200
{ "deviceId": "uuid", "deviceCredential": "dev_…", "organisationId": "uuid", "expiresAt": null }
```

Errors: `422 PAIRING_TOKEN_EXPIRED`, `422 PAIRING_TOKEN_USED`, `404 PAIRING_SESSION_NOT_FOUND`.

---

## 5. Documents

| Method | Path                       | Purpose                                                                                    |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------ |
| POST   | `/documents`               | Upload a document (multipart: `file`, optional `documentType`, `templateId`)               |
| GET    | `/documents`               | List/filter (`status`, `type`, `deviceId`, `from`, `to`)                                   |
| GET    | `/documents/:id`           | Metadata + processing status                                                               |
| GET    | `/documents/:id/file`      | Stream the original image (authorised, never public)                                       |
| GET    | `/documents/:id/result`    | Current extraction (UDM + flattened fields/tables)                                         |
| POST   | `/documents/:id/reprocess` | Re-run extraction (admin/reviewer); returns 409 while extraction is queued or running      |
| DELETE | `/documents/:id`           | Soft delete (the retention worker currently skips already-deleted records and their files) |

`POST /documents` — requires `Idempotency-Key`; max 20 MB per image, JPEG/PNG/PDF/HEIC.

```json
// response 201
{ "id": "uuid", "status": "queued", "jobId": "uuid", "pageCount": 1 }
```

---

## 5b. Batches (BATCH-001)

| Method | Path                       | Purpose                                                        |
| ------ | -------------------------- | -------------------------------------------------------------- |
| POST   | `/batches`                 | Upload up to 100 files in one multipart request (`files[]`)    |
| GET    | `/batches`                 | Recent batches with derived progress                           |
| GET    | `/batches/:id`             | One batch with per-item status                                 |
| GET    | `/batches/:id/items`       | `total`, `processed`, `succeeded`, `failed`, `status`, `items` |
| GET    | `/batches/:id/results.csv` | Per-item results as CSV (UTF-8 with BOM, formula-escaped)      |

Form fields: `name` (optional), `projectId` (optional), `documentType` (optional). Each file
becomes its own document and job.

```json
// response 201 — partial success is normal, so the batch itself always succeeds
{
  "id": "uuid",
  "name": "Morning intake",
  "total": 3,
  "processed": 1,
  "succeeded": 1,
  "failed": 1,
  "status": "completed_with_errors",
  "items": [
    { "position": 0, "filename": "a.png", "documentId": "uuid", "status": "succeeded" },
    {
      "position": 1,
      "filename": "notes.txt",
      "documentId": null,
      "status": "failed",
      "error": "That file type is not supported."
    }
  ]
}
```

An unsupported or unreadable file is recorded as a failed item with an `error`; it never fails the
request and never blocks the other files.

---

## 6. Review

| Method | Path                         | Purpose                                                           |
| ------ | ---------------------------- | ----------------------------------------------------------------- |
| GET    | `/review/queue`              | Documents awaiting review, low-confidence first                   |
| GET    | `/review/corrections`        | Correction aggregates by field and document type (`REV-002`)      |
| POST   | `/review/corrections/export` | Corrections for training — admin, requires opt-in (`REV-002`)     |
| POST   | `/documents/:id/review`      | Open or resume a review                                           |
| PATCH  | `/review/:id/fields`         | Apply field corrections                                           |
| POST   | `/review/:id/approve`        | Approve the record (blocked while required fields are unresolved) |
| POST   | `/review/:id/reject`         | Reject with a reason                                              |
| POST   | `/review/bulk-approve`       | Approve many, skipping any with unresolved low-confidence fields  |

`PATCH /review/:id/fields`

```json
{ "changes": [{ "fieldPath": "invoice.number", "value": "INV-1043" }] }
```

Every change is stored in `review_changes` with the actor and the previous value. Reprocessing
supersedes all open reviews of the document without deleting their history. Open, correction,
approval and rejection return 409 when the document is queued, processing, failed, approved or
otherwise unavailable for review, when extraction work is active, or when a review is closed or no
longer refers to the latest extraction. Once reprocessing succeeds, open a new review for its result.
Bulk approval skips unavailable records as well as those with unresolved fields. Reprocessing and
review writes are serialized in the database. Approved-snapshot reads for connector previews, sends
and exports require a currently approved document, no active extraction and an approval of the
latest extraction. This is a point-in-time check: external sends and exports can still race with later
reprocessing. This protection requires every API and worker to use the new locking protocol. Stop older processes
before deploying; rolling overlap with older binaries or direct database writers is not protected.
A rollback to older code can reopen the race. Review history can now contain status `superseded`.

---

## 7. Exports and connectors

| Method   | Path                     | Purpose                                                        |
| -------- | ------------------------ | -------------------------------------------------------------- |
| POST     | `/exports`               | Create an export job (`format`: `xlsx` \| `csv`, plus filters) |
| GET      | `/exports/:id`           | Status + expiring download URL                                 |
| GET      | `/exports`               | Export history                                                 |
| GET      | `/connectors`            | List connectors (config is write-only)                         |
| POST     | `/connectors`            | Create connector                                               |
| PATCH    | `/connectors/:id`        | Update or disable                                              |
| DELETE   | `/connectors/:id`        | Remove connector and its credentials                           |
| POST     | `/connectors/:id/test`   | Health check                                                   |
| GET      | `/connectors/:id/schema` | Destination schema for mapping (tables/columns)                |
| GET/POST | `/mapping-profiles`      | List/create mapping profiles                                   |
| PATCH    | `/mapping-profiles/:id`  | Update mapping, duplicate policy                               |
| POST     | `/documents/:id/send`    | Send an approved record through a connector                    |

Export creation failures return generic guidance rather than internal storage or database details.
A failed response does not prove that no file was written; interrupted exports may require operator
reconciliation (see `DEPLOYMENT.md` and R01 ARC-026).

**Connector configuration:** `config` and `credentials` are write-only. Responses include an empty
`config` object for compatibility with the response shape, rather than returning stored settings.
Creating or replacing configuration encrypts both objects; credentials override matching config
keys and the merged settings are validated. PATCH `config` replaces the complete configuration
object while preserving existing credentials; PATCH does not update credentials. Existing plaintext
rows require the offline migration in `docs/connector-config-migration.md`, and prior copies may
need rotation or secure disposal. See `SECURITY.md` and R01 finding ARC-023.

`POST /documents/:id/send`

```json
{ "connectorId": "uuid", "mappingProfileId": "uuid" }
// 202
{ "runId": "uuid", "status": "queued" }
```

### 7b. Connector marketplace (MARKET-001)

| Method | Path                                 | Purpose                                                       |
| ------ | ------------------------------------ | ------------------------------------------------------------- |
| GET    | `/marketplace`                       | Signed catalogue with disclosed permissions and install state |
| POST   | `/marketplace/install`               | Install a package onto a connector of the same type (admin)   |
| POST   | `/marketplace/installs/:id/rollback` | Return to the version installed before this one               |

```json
{ "packageId": "hubspot-crm", "connectorId": "uuid", "version": "1.1.0" }
// 201
{ "id": "uuid", "packageId": "hubspot-crm", "version": "1.1.0", "permissions": ["documents:read"] }
```

A package is a manifest, never code: `type` must already exist in the connector registry.
A signature that does not verify, or permissions edited after signing, are refused. Withdrawn
packages stay listed with `revokedReason` but cannot be installed.

### 7c. Workflow automation (AGENT-001)

| Method | Path                                     | Purpose                                                       |
| ------ | ---------------------------------------- | ------------------------------------------------------------- |
| GET    | `/workflows`                             | Rules for this organisation                                   |
| POST   | `/workflows`                             | Create a rule (admin; `auto_approve` needs an owner)          |
| PATCH  | `/workflows/:id`                         | Pause or enable                                               |
| DELETE | `/workflows/:id`                         | Delete the rule; its run history stays                        |
| POST   | `/workflows/evaluate`                    | Evaluate every enabled rule for a trigger and log the outcome |
| GET    | `/workflows/runs`                        | Run log, newest first                                         |
| GET    | `/workflows/runs/:id`                    | Inspect one run and its recorded plan                         |
| POST   | `/workflows/runs/:id/approve`            | Approve one pending run and execute its actions (reviewer)    |
| POST   | `/workflows/runs/:id/cancel-interrupted` | Cancel one reviewed interrupted run (signed-in owner)         |

```json
{
  "name": "File large invoices",
  "trigger": "document.approved",
  "documentType": "invoice",
  "conditions": [{ "field": "total.amount", "operator": "greater_than", "value": 100 }],
  "actions": [
    { "type": "notify" },
    { "type": "send_to_connector", "config": { "connectorId": "uuid" } }
  ],
  "approvalPolicy": "always_ask"
}
```

Triggers: `document.approved`, `document.extracted`, `document.needs_review`, `batch.completed`.
Actions: `notify`, `send_to_connector`, `create_export`, `delete_document` — the last three are
destructive, so their run is held as `awaiting_approval` until a person approves that specific run,
unless an owner has set `auto_approve`. `notify`, `send_to_connector` and `create_export` are not
implemented: a matched plan containing any of them fails without executing any actions, including a
preceding delete. Approval-required plans remain pending until approval, which returns 409 and marks
the run failed. Historical completed runs may have contained placeholder outputs; they do not prove
any delivery. Workflow `delete_document` is a soft-delete only. For current-version executions, the
run is locked and its deletion, audit and completion commit in one database transaction. Automatic
runs start as `matched`; a crash can leave a matched run requiring investigation, not automatic retry.
A signed-in owner may inspect a run and send `{"confirmReviewed":true,"incidentReference":"INC-42"}`
to `cancel-interrupted`. This marks an eligible `matched` run failed without executing or retrying its
plan, and records an owner audit in the same transaction. Only new protocol-1 runs with consistent
pending state are eligible; existing and old-binary runs are protocol 0 and must not be assumed safe.
The incident reference is a non-secret 1–80 character ASCII identifier using letters, digits or
`_.:@/-`. Stop or fence old binaries and investigate the run and any possible effects first; the
confirmation does not prove this was done. If the response is ambiguous, inspect the run before
acting. Creating a fresh evaluation can execute other plans or duplicate effects. This does not remove
files, repair historical runs, or fence older application versions. The response to
`/workflows/evaluate` is `{ plans[], runs[] }`, including runs that skipped.

---

## 8. Organisation, users and audit

| Method | Path                         | Purpose                                                                                  |
| ------ | ---------------------------- | ---------------------------------------------------------------------------------------- |
| GET    | `/organisation`              | Current organisation and settings                                                        |
| PATCH  | `/organisation`              | Update name, retention, AI provider (owner/admin)                                        |
| GET    | `/users`                     | Members and roles                                                                        |
| POST   | `/users/invite`              | Invite member; returns a single-use link (no email delivery)                             |
| PATCH  | `/users/:id/role`            | Change role                                                                              |
| DELETE | `/users/:id`                 | Remove member                                                                            |
| GET    | `/audit-logs`                | Filter by actor, action, target, date range (admin)                                      |
| GET    | `/audit-logs.csv`            | The same rows as a CSV attachment; the export is itself audited                          |
| GET    | `/stats`                     | Counts for the dashboard                                                                 |
| POST   | `/retention/purge`           | Queue retention work (admin); returns an existing queued/running purge job if one exists |
| GET    | `/documents/{id}/duplicates` | Preview duplicate matches against a destination (`DUP-001`)                              |
| POST   | `/documents/{id}/send`       | Send with the mapping profile's duplicate policy (`DUP-001`)                             |
| GET    | `/templates`                 | Document templates, optionally by document type                                          |
| POST   | `/templates`                 | Create a template (from scratch or a processed document)                                 |
| GET    | `/templates/:id`             | Template with its version history                                                        |
| PATCH  | `/templates/:id`             | Update a template; a field-list change creates a version                                 |
| DELETE | `/templates/:id`             | Disable a template (history is kept)                                                     |
| GET    | `/api-keys`                  | API keys (secrets are never returned)                                                    |
| POST   | `/api-keys`                  | Create a key — the secret is returned in this response only                              |
| DELETE | `/api-keys/:id`              | Revoke a key                                                                             |
| GET    | `/events`                    | Server-sent events for the desktop (see §9)                                              |

### 8b. Projects and invitations (TEAM-001)

| Method | Path                         | Purpose                                                            |
| ------ | ---------------------------- | ------------------------------------------------------------------ |
| GET    | `/projects`                  | Projects; archived ones only with `includeArchived=true`           |
| POST   | `/projects`                  | Create a project (admin); `key` derived from the name              |
| PATCH  | `/projects/:id`              | Rename, archive or restore (admin)                                 |
| DELETE | `/projects/:id`              | Archive — documents keep their assignment                          |
| GET    | `/invitations`               | Pending and used invitations (admin), never with tokens            |
| DELETE | `/invitations/:id`           | Revoke an invitation (admin)                                       |
| POST   | `/invitations/:token/accept` | Public: establish or verify password, activate membership, sign in |

`POST /users/invite` stores only the SHA-256 hash of the token and returns the link once:

```json
{
  "status": "invited",
  "invitation": {
    "id": "uuid",
    "email": "person@example.com",
    "role": "reviewer",
    "expiresAt": "2026-11-02T10:00:00.000Z",
    "token": "…",
    "acceptUrl": "http://localhost:5173/#/accept-invite?token=…"
  }
}
```

The public accept endpoint requires the invitation token and a password. A new account sets its
password; an existing account must supply its current password, which is not changed. If MFA is
enabled, also provide a `code` from the authenticator app or a recovery code. Invitations expire
after `INVITATION_TTL_SECONDS` and are single-use; a recovery code is consumed only if acceptance
commits. A weak password is `400`; invalid invitation credentials are `401`. Administrators receive
invitation tokens, so this flow does not yet satisfy an account-enumeration-resistance guarantee.

---

## 9. Realtime

Two transports publish the same events through the `RealtimeHub` interface (DEC-016).

### 9.1 Server-sent events (implemented, used by the desktop)

`GET /events` streams the caller's organisation events as `text/event-stream`. Authentication is
the normal `Authorization` header; because `EventSource` cannot set headers, the endpoint also
accepts `?access_token=<access token>`. A `: ping` comment every 25 s keeps proxies from closing an
idle stream, and the first frame is `job:progress` with `{ "stage": "connected" }`.

Each frame is `event: <name>` followed by `data: <json>`; the names and payloads are the table in
§9.3. Unauthenticated requests get `401` before any stream is opened. Payloads carry identifiers
only — never document content or personal data.

### 9.2 Socket.IO (planned)

Connect: `wss://api.<domain>` with `auth: { deviceCredential }` or `{ accessToken }`. Unauthenticated sockets are disconnected immediately. Room: `org:<organisationId>` plus `user:<userId>`. Not yet implemented; add it behind the same `RealtimeHub` interface if bidirectional device messages are needed.

### 9.3 Event catalogue

#### Client → server (Socket.IO only)

| Event                | Payload          | Purpose                            |
| -------------------- | ---------------- | ---------------------------------- |
| `document:subscribe` | `{ documentId }` | Watch a specific document          |
| `job:cancel`         | `{ jobId }`      | Request cancellation (best effort) |
| `device:ping`        | `{}`             | Keep-alive / presence              |

#### Server → client (both transports)

| Event                   | Payload                                                 |
| ----------------------- | ------------------------------------------------------- |
| `device:paired`         | `{ deviceId, name, platform, pairedAt }`                |
| `device:revoked`        | `{ deviceId }`                                          |
| `document:queued`       | `{ documentId, jobId }`                                 |
| `job:progress`          | `{ jobId, documentId, stage, percent }`                 |
| `document:extracted`    | `{ documentId, extractionId, confidence, needsReview }` |
| `document:needs_review` | `{ documentId, lowConfidenceFields: ["total.amount"] }` |
| `document:approved`     | `{ documentId, reviewedBy }`                            |
| `document:failed`       | `{ documentId, code, message }`                         |
| `connector:run_updated` | `{ runId, status }`                                     |
| `export:ready`          | `{ exportId, url }`                                     |

Rules: messages are small; never send document content or personal data over sockets — send IDs and re-fetch if needed. Events are additive-only within `v1`. Extraction failure messages are generic worker guidance, not raw OCR, storage or database exceptions; they no longer identify the specific cause.

---

## 10. Privacy — my data

| Method | Path         | Purpose                                                         |
| ------ | ------------ | --------------------------------------------------------------- |
| GET    | `/me/export` | Everything held about the caller, as a JSON attachment          |
| POST   | `/me/erase`  | Anonymise the caller's account (password + `confirm: "DELETE"`) |

`/me/export` returns the account, organisations with roles, documents uploaded by that person,
reviews they performed and the most recent 1,000 audit entries. It never includes another
organisation's rows, and it is not stored server-side.

`/me/erase` anonymises the account (`deleted-<id>@erased.invalid`, "Erased account"), revokes every
session and device, deletes the person's unreviewed drafts and their files, and audits
`privacy.account_erased`. Approved records and the audit trail are kept — they belong to the
organisation and may be subject to a retention duty — with no identifying details. It is refused with
`409` while the person is one of several owners, because the organisation would be left without an
accountable owner; a sole owner erases the organisation's identity with them.

## 11. Legal documents

| Method | Path            | Purpose                                     |
| ------ | --------------- | ------------------------------------------- |
| GET    | `/legal`        | List published documents (slug, title, URL) |
| GET    | `/legal/{slug}` | Fetch one as `text/plain` (Markdown)        |

Public on purpose: someone deciding whether to sign up has to be able to read the privacy policy, and
a customer's auditor has to be able to fetch the DPA without an account. Slugs are `privacy`, `terms`,
`dpa`, `subprocessors`, `security` and are matched against a fixed list — the filesystem path is never
built from the request. Files live in `legal/` and are checked by `npm run test:legal`.

## 12. Rate limits (v1 defaults)

| Scope                          | Limit                                        |
| ------------------------------ | -------------------------------------------- |
| `POST /auth/login`             | 5 / 15 min per IP + per account              |
| `POST /auth/mfa/enrol`         | `RATE_LIMIT_AUTH_PER_15_MIN` (5) per account |
| `POST /auth/mfa/enrol/confirm` | same budget, per account                     |
| `POST /auth/mfa/verify`        | same budget, per IP                          |
| `POST /pairing/sessions`       | 10 / min per user                            |
| `POST /pairing/complete`       | 10 / min per IP                              |
| `POST /documents`              | 60 / min per device                          |
| `POST /exports`                | 10 / hour per organisation                   |
| All other authenticated routes | 300 / min per user                           |

`429` responses include `Retry-After`.

---

## 13. Webhooks _(Phase 3)_

Outbound webhooks for `document.approved`, `connector.run_failed` and `export.ready`, signed with HMAC-SHA256 in `X-IDCP-Signature`, retried with exponential backoff for 24 hours, with a replay window and documented payload versioning.

---

## 14. Documentation duties

When an endpoint or socket event changes: update this file, bump the OpenAPI document (`docs/openapi.yaml`, `DEVAPI-001`) and add a `CHANGELOG.md` note. Never change a live response shape in place inside `v1`.
