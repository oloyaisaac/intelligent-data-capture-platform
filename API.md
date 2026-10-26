# API

Contract between the mobile app, desktop app, backend and integrators.

> **Status:** designed, not implemented. Base URL, versions and payloads below are the target contract for `BACK-001` and later stories. Nothing here is live yet.

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

No auth. Returns `200` when the API and its critical dependencies are reachable.

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptimeSeconds": 4213,
  "dependencies": { "db": "ok", "queue": "ok" }
}
```

---

## 3. Authentication

| Method | Path                    | Purpose                                                       |
| ------ | ----------------------- | ------------------------------------------------------------- |
| POST   | `/auth/register`        | Create account + organisation (owner role)                    |
| POST   | `/auth/login`           | Email + password → access + refresh token                     |
| POST   | `/auth/refresh`         | Rotate refresh token, issue new access token                  |
| POST   | `/auth/logout`          | Revoke the presented refresh token                            |
| POST   | `/auth/password/forgot` | Send reset link (always 202, never reveals account existence) |
| POST   | `/auth/password/reset`  | Consume single-use reset token                                |
| GET    | `/auth/me`              | Current user, roles and organisation                          |

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

Rules: access tokens ≤ 15 minutes; refresh tokens rotate on every use and are single-use; login is rate limited per IP and per account.

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

| Method | Path                       | Purpose                                                                      |
| ------ | -------------------------- | ---------------------------------------------------------------------------- |
| POST   | `/documents`               | Upload a document (multipart: `file`, optional `documentType`, `templateId`) |
| GET    | `/documents`               | List/filter (`status`, `type`, `deviceId`, `from`, `to`)                     |
| GET    | `/documents/:id`           | Metadata + processing status                                                 |
| GET    | `/documents/:id/file`      | Stream the original image (authorised, never public)                         |
| GET    | `/documents/:id/result`    | Current extraction (UDM + flattened fields/tables)                           |
| POST   | `/documents/:id/reprocess` | Re-run extraction (admin/reviewer)                                           |
| DELETE | `/documents/:id`           | Soft delete, then purge per retention policy                                 |

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

| Method | Path                    | Purpose                                                           |
| ------ | ----------------------- | ----------------------------------------------------------------- |
| GET    | `/review/queue`         | Documents awaiting review, low-confidence first                   |
| POST   | `/documents/:id/review` | Open or resume a review                                           |
| PATCH  | `/review/:id/fields`    | Apply field corrections                                           |
| POST   | `/review/:id/approve`   | Approve the record (blocked while required fields are unresolved) |
| POST   | `/review/:id/reject`    | Reject with a reason                                              |
| POST   | `/review/bulk-approve`  | Approve many, skipping any with unresolved low-confidence fields  |

`PATCH /review/:id/fields`

```json
{ "changes": [{ "fieldPath": "invoice.number", "value": "INV-1043" }] }
```

Every change is stored in `review_changes` with the actor and the previous value.

---

## 7. Exports and connectors

| Method   | Path                     | Purpose                                                        |
| -------- | ------------------------ | -------------------------------------------------------------- |
| POST     | `/exports`               | Create an export job (`format`: `xlsx` \| `csv`, plus filters) |
| GET      | `/exports/:id`           | Status + expiring download URL                                 |
| GET      | `/exports`               | Export history                                                 |
| GET      | `/connectors`            | List connectors (secrets never returned)                       |
| POST     | `/connectors`            | Create connector                                               |
| PATCH    | `/connectors/:id`        | Update or disable                                              |
| DELETE   | `/connectors/:id`        | Remove connector and its credentials                           |
| POST     | `/connectors/:id/test`   | Health check                                                   |
| GET      | `/connectors/:id/schema` | Destination schema for mapping (tables/columns)                |
| GET/POST | `/mapping-profiles`      | List/create mapping profiles                                   |
| PATCH    | `/mapping-profiles/:id`  | Update mapping, duplicate policy                               |
| POST     | `/documents/:id/send`    | Send an approved record through a connector                    |

`POST /documents/:id/send`

```json
{ "connectorId": "uuid", "mappingProfileId": "uuid" }
// 202
{ "runId": "uuid", "status": "queued" }
```

---

## 8. Organisation, users and audit

| Method | Path               | Purpose                                                      |
| ------ | ------------------ | ------------------------------------------------------------ |
| GET    | `/organisation`    | Current organisation and settings                            |
| PATCH  | `/organisation`    | Update name, retention, AI provider (owner/admin)            |
| GET    | `/users`           | Members and roles                                            |
| POST   | `/users/invite`    | Invite member; returns a single-use link (no email delivery) |
| PATCH  | `/users/:id/role`  | Change role                                                  |
| DELETE | `/users/:id`       | Remove member                                                |
| GET    | `/audit-logs`      | Filter by actor, action, target, date range (admin)          |
| GET    | `/stats`           | Counts for the dashboard                                     |
| POST   | `/retention/purge` | Purge expired documents now (admin)                          |
| GET    | `/templates`       | Document templates, optionally by document type              |
| POST   | `/templates`       | Create a template (from scratch or a processed document)     |
| GET    | `/templates/:id`   | Template with its version history                            |
| PATCH  | `/templates/:id`   | Update a template; a field-list change creates a version     |
| DELETE | `/templates/:id`   | Disable a template (history is kept)                         |
| GET    | `/api-keys`        | API keys (secrets are never returned)                        |
| POST   | `/api-keys`        | Create a key — the secret is returned in this response only  |
| DELETE | `/api-keys/:id`    | Revoke a key                                                 |
| GET    | `/events`          | Server-sent events for the desktop (see §9)                  |

### 8b. Projects and invitations (TEAM-001)

| Method | Path                         | Purpose                                                  |
| ------ | ---------------------------- | -------------------------------------------------------- |
| GET    | `/projects`                  | Projects; archived ones only with `includeArchived=true` |
| POST   | `/projects`                  | Create a project (admin); `key` derived from the name    |
| PATCH  | `/projects/:id`              | Rename, archive or restore (admin)                       |
| DELETE | `/projects/:id`              | Archive — documents keep their assignment                |
| GET    | `/invitations`               | Pending and used invitations (admin), never with tokens  |
| DELETE | `/invitations/:id`           | Revoke an invitation (admin)                             |
| POST   | `/invitations/:token/accept` | Public: set a password, activate membership, sign in     |

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

The accept endpoint is anonymous (the token is the credential), expires after
`INVITATION_TTL_SECONDS`, and is single-use: the second attempt returns `401`. A weak password is
`400`; an unknown, used or expired token is `401` with a message that does not say which.

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

Rules: messages are small; never send document content or personal data over sockets — send IDs and re-fetch if needed. Events are additive-only within `v1`.

---

## 10. Rate limits (v1 defaults)

| Scope                          | Limit                           |
| ------------------------------ | ------------------------------- |
| `POST /auth/login`             | 5 / 15 min per IP + per account |
| `POST /pairing/sessions`       | 10 / min per user               |
| `POST /pairing/complete`       | 10 / min per IP                 |
| `POST /documents`              | 60 / min per device             |
| `POST /exports`                | 10 / hour per organisation      |
| All other authenticated routes | 300 / min per user              |

`429` responses include `Retry-After`.

---

## 11. Webhooks _(Phase 3)_

Outbound webhooks for `document.approved`, `connector.run_failed` and `export.ready`, signed with HMAC-SHA256 in `X-IDCP-Signature`, retried with exponential backoff for 24 hours, with a replay window and documented payload versioning.

---

## 12. Documentation duties

When an endpoint or socket event changes: update this file, bump the OpenAPI document (`docs/openapi.yaml`, `DEVAPI-001`) and add a `CHANGELOG.md` note. Never change a live response shape in place inside `v1`.
