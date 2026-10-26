# Database

Data model reference for the shipped schema. The authoritative DDL is
`apps/backend/src/db/migrations.ts` — this document explains it and lists what each table is for.

> **Status:** implemented. Seven forward-only migrations
> (`001_initial_schema` … `007_workflows`) create 30 tables on SQLite (`node:sqlite`, the local and
> tested path) or PostgreSQL (the production path). There is no ORM: repositories hold the SQL, and
> one schema serves both drivers (DEC-013). Types below are written in PostgreSQL terms; on SQLite
> the same columns are `text`/`integer`/`real` and timestamps are ISO-8601 text.

---

## 1. Conventions

- Table names: plural `snake_case`. Column names: `snake_case`.
- Primary keys: `id` — UUID v7 (time-sortable) unless stated otherwise.
- Every table has `created_at`; mutable rows also have `updated_at` (`timestamptz`, UTC). Append-only tables (audit, runs, deliveries) deliberately have none.
- Every tenant-owned table has `organisation_id uuid not null` referencing `organisations(id)`.
- Soft delete only where stated (`deleted_at`); audit records are never deleted.
- Enums are stored as `text` with a check constraint, never a database enum type — the same DDL has to run on SQLite and PostgreSQL.
- Money: `numeric(18,4)` plus `currency char(3)` — never floats.
- Personal data columns are marked 🔒; they are subject to retention and deletion (`SEC-001`).

## 2. Entity overview

```
organisations 1─┬─* users ──* memberships (role)     org-scoped roles; sessions per user
                ├─* devices ──* pairing_sessions
                ├─* documents ─┬─* document_pages
                │              ├─* extractions ──* extraction_fields   (tables live in extractions.udm)
                │              ├─* reviews ──* review_changes
                │              └─* jobs
                ├─* batches ──* batch_items (document_id)
                ├─* projects ──* documents.project_id
                ├─* invitations
                ├─* connectors ─┬─* mapping_profiles
                │               ├─* connector_runs
                │               └─* marketplace_installs
                ├─* exports
                ├─* templates ──* template_versions
                ├─* workflows ──* workflow_runs
                ├─* api_keys
                ├─* webhooks ──* webhook_deliveries
                └─* audit_logs (append-only)
```

## 3. Tables

### 3.1 `organisations`

| Column                  | Type                            | Notes                                       |
| ----------------------- | ------------------------------- | ------------------------------------------- |
| id                      | uuid PK                         |                                             |
| name                    | text not null                   |                                             |
| slug                    | text unique not null            | URL-safe identifier                         |
| plan                    | text not null default `'free'`  | `free`, `team`, `enterprise`                |
| retention_days          | integer not null default 90     | 0 = keep until deleted                      |
| ai_provider             | text not null default `'local'` | `local`, or an approved cloud provider      |
| learning_opt_in         | integer not null default 0      | 1 = corrections may feed training (REV-002) |
| settings                | jsonb not null default `'{}'`   | non-critical toggles                        |
| created_at / updated_at | timestamptz                     |                                             |

### 3.2 `users`

| Column                  | Type                         | Notes                                          |
| ----------------------- | ---------------------------- | ---------------------------------------------- |
| id                      | uuid PK                      |                                                |
| email 🔒                | text unique not null         | compared lower-cased in code                   |
| password_hash           | text                         | Argon2id; null for invited-not-activated users |
| display_name 🔒         | text                         |                                                |
| locale                  | text not null default `'en'` |                                                |
| email_verified_at       | timestamptz                  |                                                |
| last_login_at           | timestamptz                  |                                                |
| disabled_at             | timestamptz                  |                                                |
| created_at / updated_at | timestamptz                  |                                                |

### 3.3 `memberships`

Join between users and organisations; owns the role.

| Column                  | Type                    | Notes                                              |
| ----------------------- | ----------------------- | -------------------------------------------------- |
| id                      | uuid PK                 |                                                    |
| organisation_id         | uuid FK → organisations |                                                    |
| user_id                 | uuid FK → users         |                                                    |
| role                    | text not null           | `owner`, `admin`, `reviewer`, `operator`, `viewer` |
| invited_by              | uuid FK → users null    |                                                    |
| accepted_at             | timestamptz null        |                                                    |
| created_at / updated_at | timestamptz             |                                                    |

Unique: `(organisation_id, user_id)`.

### 3.4 `sessions`

| Column             | Type                 | Notes                     |
| ------------------ | -------------------- | ------------------------- |
| id                 | uuid PK              |                           |
| user_id            | uuid FK → users      |                           |
| refresh_token_hash | text unique not null | never store the raw token |
| user_agent         | text                 |                           |
| ip_hash            | text                 | hashed, not raw IP        |
| expires_at         | timestamptz not null |                           |
| revoked_at         | timestamptz          |                           |
| created_at         | timestamptz          |                           |

### 3.5 `devices`

| Column                  | Type                 | Notes                       |
| ----------------------- | -------------------- | --------------------------- |
| id                      | uuid PK              |                             |
| organisation_id         | uuid FK              |                             |
| user_id                 | uuid FK → users      | owner of the pairing        |
| name                    | text not null        | e.g. "Pixel 8 — Finance"    |
| platform                | text not null        | `android`, `ios`, `desktop` |
| app_version             | text                 |                             |
| credential_hash         | text unique not null | device credential, hashed   |
| last_seen_at            | timestamptz          |                             |
| revoked_at              | timestamptz          |                             |
| created_at / updated_at | timestamptz          |                             |

### 3.6 `pairing_sessions`

| Column          | Type                   | Notes                                          |
| --------------- | ---------------------- | ---------------------------------------------- |
| id              | uuid PK                |                                                |
| organisation_id | uuid FK                |                                                |
| created_by      | uuid FK → users        | who opened the desktop dialog                  |
| token_hash      | text unique not null   | single-use token, hashed                       |
| status          | text not null          | `pending`, `completed`, `expired`, `cancelled` |
| device_id       | uuid FK → devices null | set on completion                              |
| expires_at      | timestamptz not null   | ≤ now() + 2 minutes                            |
| completed_at    | timestamptz            |                                                |
| created_at      | timestamptz            |                                                |

### 3.7 `documents`

| Column                  | Type                       | Notes                                                                                     |
| ----------------------- | -------------------------- | ----------------------------------------------------------------------------------------- |
| id                      | uuid PK                    |                                                                                           |
| organisation_id         | uuid FK                    |                                                                                           |
| uploaded_by             | uuid FK → users null       |                                                                                           |
| device_id               | uuid FK → devices null     |                                                                                           |
| idempotency_key         | text                       | unique per organisation                                                                   |
| storage_key             | text not null              | object storage path; never public                                                         |
| mime_type               | text not null              | sniffed, not trusted                                                                      |
| size_bytes              | bigint not null            |                                                                                           |
| sha256                  | text not null              | dedupe + integrity                                                                        |
| page_count              | integer not null default 1 |                                                                                           |
| document_type           | text                       | `form`,`receipt`,`invoice`,`id`,`contract`,`table`,`handwritten`,`unknown`                |
| status                  | text not null              | `uploaded`,`queued`,`processing`,`extracted`,`needs_review`,`approved`,`failed`,`deleted` |
| template_id             | uuid FK → templates null   |                                                                                           |
| project_id              | uuid FK → projects null    | TEAM-001 grouping label; never widens visibility                                          |
| deleted_at              | timestamptz                | soft delete before purge                                                                  |
| created_at / updated_at | timestamptz                |                                                                                           |

Unique: `(organisation_id, idempotency_key)`. Index: `(organisation_id, status, created_at desc)`.

### 3.8 `document_pages`

| Column         | Type                | Notes                                    |
| -------------- | ------------------- | ---------------------------------------- |
| id             | uuid PK             |                                          |
| document_id    | uuid FK → documents |                                          |
| page_number    | integer not null    | 1-based                                  |
| storage_key    | text not null       | normalised page image                    |
| width / height | integer             |                                          |
| ocr_text 🔒    | text                | extracted text                           |
| ocr_words      | jsonb               | word boxes: `[{text, bbox, confidence}]` |
| created_at     | timestamptz         |                                          |

Unique: `(document_id, page_number)`.

### 3.9 `extractions`

One current extraction per document per attempt; history retained.

| Column          | Type                          | Notes                                  |
| --------------- | ----------------------------- | -------------------------------------- |
| id              | uuid PK                       |                                        |
| document_id     | uuid FK                       |                                        |
| organisation_id | uuid FK                       |                                        |
| attempt         | integer not null              | increments on re-run                   |
| udm             | jsonb not null                | full Universal Data Model record       |
| udm_version     | text not null                 | e.g. `1.0`                             |
| provider        | text not null                 | `local-tesseract`, cloud provider name |
| model_version   | text                          |                                        |
| confidence      | numeric(4,3)                  | overall 0–1                            |
| needs_review    | boolean not null default true |                                        |
| latency_ms      | integer                       |                                        |
| cost_micros     | integer                       | for budget tracking                    |
| created_at      | timestamptz                   |                                        |

Unique: `(document_id, attempt)`. Index: `(organisation_id, created_at desc)`.

### 3.10 `extraction_fields`

Flattened projection of UDM fields, so review and search are queryable.

| Column           | Type                  | Notes                                         |
| ---------------- | --------------------- | --------------------------------------------- |
| id               | uuid PK               |                                               |
| extraction_id    | uuid FK → extractions |                                               |
| field_path       | text not null         | e.g. `invoice.number`, `table[2].description` |
| field_label      | text                  | display name                                  |
| value_text 🔒    | text                  |                                               |
| value_normalised | text                  | typed JSON string for comparison              |
| confidence       | numeric(4,3)          |                                               |
| bbox             | jsonb                 | source geometry on the page                   |
| page_number      | integer               |                                               |
| needs_review     | boolean not null      | true when below threshold                     |
| created_at       | timestamptz           |                                               |

Index: `(extraction_id)`, `(extraction_id, needs_review)`.

### 3.11 `extraction_tables` — no such table (by design)

Tables are **not** a separate table. They live inside `extractions.udm` as a `tables: [{ name,
columns: [{key, label, type}], rows: [[cell, …]] }]` array, because a line-item table has no
independent lifecycle: it is part of the extraction it came from, is versioned with it, and would
otherwise need a join to be exported or mapped. Per-cell review of a table goes through
`extraction_fields` with a `table[n].column` path.

### 3.12 `reviews`

| Column                  | Type            | Notes                                 |
| ----------------------- | --------------- | ------------------------------------- |
| id                      | uuid PK         |                                       |
| document_id             | uuid FK         |                                       |
| extraction_id           | uuid FK         |                                       |
| reviewer_id             | uuid FK → users |                                       |
| status                  | text not null   | `in_progress`, `approved`, `rejected` |
| approved_udm            | jsonb           | snapshot of the approved record       |
| notes                   | text            |                                       |
| completed_at            | timestamptz     |                                       |
| created_at / updated_at | timestamptz     |                                       |

### 3.13 `review_changes`

Immutable record of every field edit — the basis of learning and audit.

| Column              | Type            | Notes                                        |
| ------------------- | --------------- | -------------------------------------------- |
| id                  | uuid PK         |                                              |
| review_id           | uuid FK         |                                              |
| field_path          | text not null   |                                              |
| original_value 🔒   | text            | AI value                                     |
| corrected_value 🔒  | text            | human value                                  |
| original_confidence | numeric(4,3)    |                                              |
| document_type       | text            | type at the time of the correction (REV-002) |
| changed_by          | uuid FK → users |                                              |
| created_at          | timestamptz     |                                              |

### 3.14 `marketplace_installs`

One row per installation of a reviewed package against a connector. Rows are never deleted, so a
rollback has a version to return to.

| Column          | Type        | Notes                                                  |
| --------------- | ----------- | ------------------------------------------------------ |
| id              | uuid PK     |                                                        |
| organisation_id | uuid FK     |                                                        |
| package_id      | text        | catalogue id, e.g. `hubspot-crm`                       |
| package_version | text        | semver as published                                    |
| connector_type  | text        | must match `connectors.type`                           |
| connector_id    | uuid FK     |                                                        |
| permissions     | jsonb/text  | the permissions disclosed at install time (MARKET-001) |
| status          | text        | `active` or `rolled_back`                              |
| installed_by    | uuid FK     | admin who installed it                                 |
| installed_at    | timestamptz |                                                        |
| rolled_back_at  | timestamptz | null while active                                      |
| install_seq     | integer     | per-organisation counter; rollback order uses this     |

### 3.15 `workflows` and `workflow_runs`

A workflow is a rule; a run is what that rule decided for one document. Definitions are editable and
deletable, runs are append-only (AGENT-001).

| `workflows` column    | Type        | Notes                                                                                       |
| --------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| id                    | uuid PK     |                                                                                             |
| organisation_id       | uuid FK     |                                                                                             |
| name                  | text        |                                                                                             |
| trigger_event         | text        | `document.approved` \| `document.extracted` \| `document.needs_review` \| `batch.completed` |
| document_type         | text        | null for any type                                                                           |
| conditions            | jsonb/text  | `[{field, operator, value}]`, evaluated as one AND                                          |
| actions               | jsonb/text  | `[{type, config}]`                                                                          |
| approval_policy       | text        | `always_ask` (default) or `auto_approve`                                                    |
| enabled               | integer     | 0 pauses without deleting the rule                                                          |
| created_by            | uuid FK     | admin who created it                                                                        |
| created_at/updated_at | timestamptz |                                                                                             |

| `workflow_runs` column | Type        | Notes                                                                    |
| ---------------------- | ----------- | ------------------------------------------------------------------------ |
| id                     | uuid PK     |                                                                          |
| organisation_id        | uuid FK     |                                                                          |
| workflow_id            | uuid        | kept after the rule is deleted                                           |
| document_id            | uuid        | null for document-less triggers                                          |
| trigger_event          | text        | what fired                                                               |
| status                 | text        | `matched` \| `skipped` \| `awaiting_approval` \| `completed` \| `failed` |
| matched                | integer     | 0 when a condition or the type did not match                             |
| explanation            | text        | the sentence shown in the UI                                             |
| actions                | jsonb/text  | the plan, including `requiresApproval` and `reason`                      |
| outputs                | jsonb/text  | what each action actually did                                            |
| failure                | text        | the message when an action threw                                         |
| approved_by            | uuid FK     | the person who approved the run                                          |
| approved_at            | timestamptz |                                                                          |
| created_at             | timestamptz |                                                                          |

Indexes: `(organisation_id, created_at DESC)` on both, plus `(status, created_at DESC)` on runs so
the approval queue is a cheap query.

### 3.16 `connectors`

| Column                  | Type           | Notes                                                                    |
| ----------------------- | -------------- | ------------------------------------------------------------------------ |
| id                      | uuid PK        |                                                                          |
| organisation_id         | uuid FK        |                                                                          |
| type                    | text not null  | `google_sheets`,`csv`,`xlsx`,`mysql`,`postgres`,`sqlite`, future `crm_*` |
| name                    | text not null  | user label                                                               |
| config                  | jsonb not null | non-secret settings (sheet id, host, database)                           |
| credentials_encrypted   | bytea          | encrypted at rest; never returned by the API                             |
| status                  | text not null  | `active`, `disabled`, `error`                                            |
| last_health_check_at    | timestamptz    |                                                                          |
| last_error              | text           |                                                                          |
| created_at / updated_at | timestamptz    |                                                                          |

### 3.17 `mapping_profiles`

| Column                  | Type                           | Notes                                                              |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------ |
| id                      | uuid PK                        |                                                                    |
| organisation_id         | uuid FK                        |                                                                    |
| connector_id            | uuid FK → connectors null      | null = generic export profile                                      |
| document_type           | text not null                  |                                                                    |
| name                    | text not null                  |                                                                    |
| field_map               | jsonb not null                 | `[{udmPath, destinationField, transform, defaultValue, required}]` |
| duplicate_policy        | text not null default `'skip'` | `skip`, `update`, `append`, `merge`                                |
| duplicate_keys          | jsonb                          | e.g. `["invoice.number","supplier.taxId"]`                         |
| created_at / updated_at | timestamptz                    |                                                                    |

### 3.18 `connector_runs`

| Column             | Type          | Notes                                                        |
| ------------------ | ------------- | ------------------------------------------------------------ |
| id                 | uuid PK       |                                                              |
| connector_id       | uuid FK       |                                                              |
| mapping_profile_id | uuid FK null  |                                                              |
| document_id        | uuid FK null  |                                                              |
| operation          | text not null | `create`,`read`,`update`,`search`                            |
| status             | text not null | `queued`,`running`,`succeeded`,`failed`, `skipped_duplicate` |
| request_summary    | jsonb         | redacted                                                     |
| response_summary   | jsonb         | redacted                                                     |
| error              | text          |                                                              |
| duration_ms        | integer       |                                                              |
| created_at         | timestamptz   |                                                              |

### 3.19 `exports`

| Column          | Type            | Notes                               |
| --------------- | --------------- | ----------------------------------- |
| id              | uuid PK         |                                     |
| organisation_id | uuid FK         |                                     |
| requested_by    | uuid FK → users |                                     |
| format          | text not null   | `xlsx`,`csv`                        |
| filter          | jsonb           | date range, status, document types  |
| row_count       | integer         |                                     |
| storage_key     | text            | generated file location             |
| status          | text not null   | `queued`,`ready`,`failed`,`expired` |
| expires_at      | timestamptz     | generated files are time-limited    |
| created_at      | timestamptz     |                                     |

### 3.20 `jobs`

| Column                   | Type                       | Notes                                                                   |
| ------------------------ | -------------------------- | ----------------------------------------------------------------------- |
| id                       | uuid PK                    |                                                                         |
| organisation_id          | uuid FK                    |                                                                         |
| type                     | text not null              | `ocr`,`extract`,`classify`,`export`,`connector_write`,`retention_purge` |
| document_id              | uuid FK null               |                                                                         |
| payload                  | jsonb                      |                                                                         |
| status                   | text not null              | `queued`,`running`,`succeeded`,`failed`,`dead`                          |
| attempts                 | integer not null default 0 |                                                                         |
| max_attempts             | integer not null default 5 |                                                                         |
| last_error               | text                       |                                                                         |
| run_after                | timestamptz                | backoff schedule                                                        |
| started_at / finished_at | timestamptz                |                                                                         |
| created_at               | timestamptz                |                                                                         |

Index: `(status, run_after)` for the worker poll.

### 3.21 `templates`

| Column                  | Type                          | Notes                              |
| ----------------------- | ----------------------------- | ---------------------------------- |
| id                      | uuid PK                       |                                    |
| organisation_id         | uuid FK                       |                                    |
| name                    | text not null                 |                                    |
| document_type           | text not null                 |                                    |
| fields                  | jsonb not null                | expected fields + validation rules |
| sample_storage_key      | text                          |                                    |
| version                 | integer not null default 1    |                                    |
| active                  | boolean not null default true |                                    |
| created_at / updated_at | timestamptz                   |                                    |

### 3.22 `audit_logs` (append-only)

| Column                  | Type                 | Notes                                                        |
| ----------------------- | -------------------- | ------------------------------------------------------------ |
| id                      | uuid PK              |                                                              |
| organisation_id         | uuid FK              |                                                              |
| actor_type              | text not null        | `user`,`device`,`system`,`api_key`                           |
| actor_id                | uuid                 |                                                              |
| action                  | text not null        | e.g. `document.approve`, `device.revoke`, `connector.create` |
| target_type / target_id | text / uuid          |                                                              |
| ip_hash                 | text                 | hashed                                                       |
| metadata                | jsonb                | no secrets, no document content                              |
| created_at              | timestamptz not null |                                                              |

Rules: `UPDATE` and `DELETE` are revoked for the application role; retention is longer than any business table (default 24 months).

### 3.23 `template_versions`

Snapshot of a template's field list, written on creation and on every field-list change
(migration `003_template_versions`).

| Column          | Type                | Constraints                 | Notes                           |
| --------------- | ------------------- | --------------------------- | ------------------------------- |
| id              | uuid                | PK                          |                                 |
| template_id     | uuid FK → templates | NOT NULL, ON DELETE CASCADE |                                 |
| organisation_id | uuid                | NOT NULL                    | Tenant scope                    |
| version         | integer             | NOT NULL                    | `UNIQUE (template_id, version)` |
| fields          | jsonb               | NOT NULL                    | Field list at that version      |
| created_by      | uuid FK → users     | NULL                        | Who made the change             |
| created_at      | timestamptz         | NOT NULL                    |                                 |

### 3.24 `projects` _(TEAM-001)_

A grouping label inside one organisation (branch, client, month). Not a second tenant: every
query still filters by `organisation_id` first.

| Column                  | Type            | Constraints                               | Notes                     |
| ----------------------- | --------------- | ----------------------------------------- | ------------------------- |
| id                      | uuid            | PK                                        |                           |
| organisation_id         | uuid FK → orgs  | NOT NULL                                  | Tenant scope              |
| name                    | text            | NOT NULL                                  | ≤ 120 characters          |
| key                     | text            | NOT NULL, `UNIQUE (organisation_id, key)` | Uppercase identifier      |
| created_by              | uuid FK → users | NULL                                      |                           |
| archived_at             | timestamptz     | NULL                                      | Archive instead of delete |
| created_at / updated_at | timestamptz     | NOT NULL                                  |                           |

### 3.25 `batches` / `batch_items` _(BATCH-001)_

A batch records _which files were asked for_; progress is derived from the documents, so a counter
can never disagree with reality.

`batches`: `id`, `organisation_id`, `name`, `project_id` (nullable), `created_by`,
`created_at`.

`batch_items`: `id`, `batch_id` FK (cascade), `document_id` (nullable — a file rejected before a
document existed), `position`, `filename`, `error`, `created_at`, `UNIQUE (batch_id, position)`.

### 3.26 `invitations` _(TEAM-001)_

Expiring, single-use invitation links. Only the SHA-256 hash of the token is stored, so a database
leak cannot be replayed as invitations.

| Column          | Type            | Constraints        | Notes                                        |
| --------------- | --------------- | ------------------ | -------------------------------------------- |
| id              | uuid            | PK                 |                                              |
| organisation_id | uuid FK → orgs  | NOT NULL           | Tenant scope                                 |
| user_id         | uuid FK → users | NOT NULL           | Existing or newly-created, passwordless user |
| email           | text            | NOT NULL           | Invitation target                            |
| role            | text            | NOT NULL           | Applied to the membership                    |
| token_hash      | text            | NOT NULL, `UNIQUE` | SHA-256 of the token                         |
| invited_by      | uuid FK → users | NULL               |                                              |
| expires_at      | timestamptz     | NOT NULL           | `INVITATION_TTL_SECONDS` (default 7 days)    |
| used_at         | timestamptz     | NULL               | Set once; the guard is a conditional update  |
| created_at      | timestamptz     | NOT NULL           |                                              |

### 3.27 `api_keys` _(DEVAPI-001)_

Machine credentials for the developer API. Only the SHA-256 hash is stored; `key_prefix` exists so a
person can recognise a key in the list without the secret being recoverable.

`id`, `organisation_id`, `name`, `key_hash` (unique), `key_prefix`, `scopes` (JSON array of
`documents:read`, `documents:write`, `exports:read`, …), `created_by`, `last_used_at`, `revoked_at`,
`created_at`.

### 3.28 `webhooks` and `webhook_deliveries` _(DEVAPI-001)_

A webhook is an endpoint an organisation subscribes to; a delivery is one attempt to call it. The
signing secret is encrypted with the same AES-256-GCM keyring as connector credentials, and a
delivery records its own attempt count and next retry so the worker can back off without holding a
job open for days.

| `webhooks` column | Type        | Notes                                             |
| ----------------- | ----------- | ------------------------------------------------- |
| id                | uuid PK     |                                                   |
| organisation_id   | uuid FK     |                                                   |
| url               | text        | https only outside a loopback host                |
| events            | jsonb/text  | subscribed event names, from the §9.3 catalogue   |
| secret_encrypted  | text        | AES-256-GCM ciphertext, never returned by the API |
| active            | integer     | 0 pauses delivery without deleting the endpoint   |
| created_at        | timestamptz |                                                   |

| `webhook_deliveries` column | Type        | Notes                                     |
| --------------------------- | ----------- | ----------------------------------------- |
| id                          | uuid PK     |                                           |
| webhook_id                  | uuid FK     | cascade delete with the webhook           |
| event                       | text        |                                           |
| status                      | text        | `pending` \| `delivered` \| `failed`      |
| attempts                    | integer     | incremented per try                       |
| response_status             | integer     | null until the endpoint answers           |
| last_error                  | text        | the failure in words, for the audit trail |
| next_attempt_at             | timestamptz | null when nothing is queued               |
| created_at                  | timestamptz |                                           |

`schema_migrations` (`id`, `applied_at`) is the framework table: one row per applied migration.

## 4. Universal Data Model storage

The UDM record is persisted twice, deliberately:

1. **`extractions.udm` (jsonb)** — the complete, versioned record. This is the source of truth for export and connectors.
2. **`extraction_fields`** — a flattened projection of the scalar fields for the review UI, search and statistics. Table rows are **not** projected; they are read from `udm.tables`.

Invariant: the projection must always be derivable from `udm`. If they disagree, `udm` wins.

Example UDM shape (illustrative, see `packages/shared` for the enforced schema):

```json
{
  "udmVersion": "1.0",
  "documentType": "invoice",
  "documentTypeConfidence": 0.94,
  "source": { "documentId": "uuid", "pageCount": 1, "provider": "local-tesseract" },
  "fields": {
    "invoice.number": {
      "label": "Invoice number",
      "value": "INV-1042",
      "confidence": 0.98,
      "page": 1
    },
    "total.amount": {
      "label": "Total",
      "value": 1250000,
      "type": "currency",
      "currency": "UGX",
      "confidence": 0.71,
      "page": 1
    }
  },
  "tables": [
    {
      "name": "line_items",
      "columns": [{ "key": "description", "label": "Description" }],
      "rows": [["Cement 50kg x 10"]]
    }
  ],
  "needsReview": true
}
```

## 5. Indexes and performance

- `documents (organisation_id, status, created_at desc)` — dashboard and review queues.
- `extractions (organisation_id, created_at desc)` — history and analytics.
- `extraction_fields (extraction_id, needs_review)` — review prioritisation.
- `jobs (status, run_after)` — worker polling.
- `audit_logs (organisation_id, created_at desc)` and `(actor_id, created_at desc)` — audit search.
- Consider `pg_trgm` on `extraction_fields.value_normalised` for duplicate fuzzy matching (`DUP-001`).

## 6. Retention and deletion

| Data                      | Default retention                   | Mechanism                                                                 |
| ------------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| Document images           | `organisations.retention_days` (90) | scheduled `retention_purge` job → storage delete + `documents.deleted_at` |
| Extracted values          | same as document                    | row deletion after purge, except approved records retained per policy     |
| Generated exports         | 7 days                              | `exports.expires_at` + purge                                              |
| Sessions / pairing tokens | expiry                              | cleanup job                                                               |
| Audit logs                | 24 months minimum                   | archival, never application-deleted                                       |
| Backups                   | 30 days                             | documented in `DEPLOYMENT.md`                                             |

Deletion must remove the storage object and the database rows, and must be recorded in `audit_logs`.

## 7. Migration policy

- Every schema change is a migration; no manual production edits.
- Migrations are forward-only once released; write a new migration instead of editing a released one.
- Destructive migrations (drop/rename) require a two-step release: add-and-backfill, then remove.
- `DB-001` must include a seed script creating one demo organisation, one admin user and one disabled sample connector.
- Applied migrations, in order, recorded in `schema_migrations`:
  `001_initial_schema` (the 19 core tables), `002_api_keys_and_webhooks`, `003_template_versions`,
  `004_batches_projects_invitations`, `005_corrections_learning_opt_in` (`review_changes.document_type`
  and `organisations.learning_opt_in`, REV-002), `006_marketplace_installs` (MARKET-001) and
  `007_workflows` (`workflows`, `workflow_runs`, AGENT-001).
- `npm run db:migrate` applies pending migrations and is safe to re-run; `npm run db:seed` creates one
  demo organisation, one owner and a sample export without duplicating them on a second run.
