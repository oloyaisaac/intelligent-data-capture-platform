# Architecture

Technical blueprint of the AI Universal Data Capture Platform (IDCP).

> **Reality check:** the components in §2 exist and are tested; where the shipped runtime is simpler
> than the blueprint, the difference is stated inline and recorded in `DECISIONS.md` (notably DEC-013
> for the two database drivers, DEC-016 for SSE instead of Socket.IO, and DEC-029 for the single-process
> runtime). `AGENT_STATE.md` lists what is deliberately absent.

---

## 1. System overview

```
┌──────────────────┐        ┌──────────────────┐        ┌───────────────────┐
│   Mobile app     │        │  Desktop app     │        │  Third-party      │
│  Android / iOS   │        │ Win · macOS · Lin│        │  destinations     │
│  (React Native)  │        │   (Electron)     │        │ Excel/Sheets/SQL  │
└────────┬─────────┘        └────────┬─────────┘        │ CRM / ERP / API   │
         │ capture + upload          │ review + jobs   └─────────▲─────────┘
         │ QR pairing / HTTPS        │ SSE + HTTPS               │
         └───────────────┬───────────┘                           │
                         ▼                                       │
              ┌──────────────────────────────────────────────────┴────┐
              │                     Backend                               │
              │  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐ │
              │  │  REST API   │  │ Job worker   │  │ Connector      │ │
              │  │  (Fastify)  │  │ (in-process, │  │ runtime        │ │
              │  │             │  │  `jobs` tbl) │  │                │ │
              │  └──────┬──────┘  └──────┬───────┘  └───────┬────────┘ │
              │         │                │                  │          │
              │  ┌──────▼────────────────▼──────────────────▼───────┐  │
              │  │ Domain services: documents · extraction · review │  │
              │  │ mapping · export · audit · devices · tenants     │  │
              │  └──────┬───────────────────────┬───────────────────┘  │
              └─────────┼───────────────────────┼──────────────────────┘
                        ▼                       ▼
              ┌──────────────────┐    ┌────────────────────┐    ┌───────────────┐
              │ SQLite / Postgres│    │ Filesystem / S3    │    │ AI providers  │
              │ metadata, UDM,   │    │ original documents │    │ local OCR +   │
              │ audit, jobs      │    │ (STORAGE_PATH)     │    │ cloud (opt-in)│
              └──────────────────┘    └────────────────────┘    └───────────────┘
```

## 2. Components

### 2.1 Mobile app (`apps/mobile`) — React Native

Responsibilities: QR pairing, camera capture, edge detection/crop/enhancement, offline queue, upload, status display, review of simple fields, secure device credential storage.

- Navigation: React Navigation 7 (stack for flows, bottom tabs for areas).
- State: local persistence for the queue (SQLite/MMKV) plus a lightweight query cache; server state is the source of truth once online.
- Native modules: camera, barcode scanning, document edge detection, secure storage, file system.
- Talks to the backend **only** over HTTPS; the desktop holds the server-push stream (SSE), and the
  phone uploads when it has a connection because the queue is local-first.

### 2.2 Desktop app (`apps/desktop`) — Electron + React

Responsibilities: pairing QR display and device management, live job dashboard, full human-in-the-loop review, mapping configuration, connector setup, exports, analytics later.

- Main process: OS integration, keychain access, auto-update, filesystem writes for exports.
- Renderer: React UI with **no** Node access; all privileged operations go through a validated, allow-listed IPC bridge.
- Security posture per `SECURITY.md` §6.3.

### 2.3 Backend API (`apps/backend`) — Node.js 22 + TypeScript

One process today (DEC-029), split logically into two roles that can be separated later:

- **API role:** HTTP endpoints, authentication, authorisation, validation, job enqueueing, the SSE stream.
- **Worker role:** OCR/extraction jobs, mapping and connector writes, retention purges. It polls the
  `jobs` table, claims each job transactionally, and retries with exponential backoff; every job is
  idempotent, so two workers would be safe even though only one runs by default.

Layers, by folder under `src/`: `http/routes` (Fastify plugins, one per area) → `services` (domain
rules, role checks, auditing) → `repositories` (the only SQL) → `db` (driver, migrations). Pure logic
that needs no database lives beside its feature (`workflows/engine.ts`, `marketplace/catalog.ts`) so it
can be tested directly.

### 2.4 Shared package (`packages/shared`)

Single source of truth for: Universal Data Model types and Zod schemas, API request/response types, error codes, confidence/review thresholds, i18n catalogues, date/number formatters. Consumed by mobile, desktop and backend.

### 2.5 Connector package (`packages/connectors`)

The connector contract (manifest, capabilities, schema discovery, health check) plus first-party connectors. Connectors are isolated: a failing connector reports an error and never crashes the host process.

### 2.6 AI layer

```
upload → preprocess → OCR (text + geometry) → classify → extract fields/tables
        → normalise to UDM → score confidence → mark needs_review → persist
```

- Providers implement one interface: `ocr()`, `classify()`, `extract()`.
- Local engine is the default; cloud providers are opt-in per organisation and recorded in `DECISIONS.md`.
- Every output is validated against the UDM schema before persistence.
- Provenance (provider, model, version, latency, cost) is stored alongside the record.

## 3. Key data flows

### 3.1 Pairing

```
Desktop → POST /api/v1/pairing/sessions → { pairingCode, token, expiresAt }
Desktop renders QR (token + endpoint only)
Mobile scans → POST /api/v1/pairing/complete { token, deviceInfo }
Backend validates (single-use, unexpired) → issues device credential
Mobile stores credential in secure storage → authenticates socket
Desktop receives device.paired event and shows the device
```

### 3.2 Capture to reviewed record

```
Mobile captures → local queue → POST /api/v1/documents (idempotency key)
Backend writes the image to storage (filesystem), creates document + job, emits document.queued
Worker: OCR → classify → extract → validate UDM → persist extraction
Backend emits job.progress / document.needs_review
Desktop review UI: human confirms or corrects fields → POST /review
Record approved → eligible for export / connector write
```

### 3.3 Export and connector write

```
Approved record → UDM → mapping profile (destination fields + transforms)
             → duplicate check (keys + fuzzy score)
             → connector create/update/merge
             → result logged in audit trail + job record
```

## 4. Technology choices

| Concern            | Choice                                                                                 | Decision         |
| ------------------ | -------------------------------------------------------------------------------------- | ---------------- |
| Mobile             | React Native 0.86 / React 19                                                           | DEC-001          |
| Monorepo           | npm workspaces + TypeScript                                                            | DEC-002          |
| Database           | SQLite (dev/test) and PostgreSQL 16 (production); hand-written forward-only migrations | DEC-003, DEC-013 |
| Interchange format | Universal Data Model (Zod + JSON Schema)                                               | DEC-004          |
| Pairing            | Short-lived single-use QR token                                                        | DEC-005          |
| Realtime           | Authenticated SSE (Socket.IO behind the same interface later)                          | DEC-006, DEC-016 |
| AI                 | Provider abstraction, local-first                                                      | DEC-007          |
| Jobs               | `jobs` table + in-process worker, idempotent jobs; shared queue is the scale-out step  | DEC-008, DEC-029 |
| Desktop            | Electron + React                                                                       | DEC-009          |
| File storage       | Filesystem under `STORAGE_PATH`; S3-compatible store is the scale-out step             | DEC-010, DEC-029 |

## 5. Security zones

1. **Public:** only `POST /auth/login`, `POST /auth/register`, `POST /pairing/complete`, `GET /health` (rate limited, no data exposure).
2. **Authenticated user:** everything scoped to the user's organisation.
3. **Privileged (admin/owner):** device revocation, connector credentials, retention, exports of bulk data. Every action audited.
4. **Machine:** workers and connectors use short-lived internal credentials; the connector sandbox never receives the user's session token.

Cross-cutting: TLS in transit, encryption at rest, tenant scoping on every query, audit log append-only.

## 6. Target repository layout

```
intelligent-data-capture-platform/
├── apps/
│   ├── mobile/                 React Native app
│   │   ├── src/{navigation,capture,queue,pairing,review,ui}
│   │   └── android/ ios/
│   ├── desktop/                Electron app
│   │   └── src/{main,preload,renderer/{pairing,review,dashboard,mapping,devices}}
│   └── backend/
│       ├── src/{api,services,ai,connectors,realtime,jobs}
│       └── prisma/{schema.prisma,migrations,seed.ts}
├── packages/
│   ├── shared/                 UDM, schemas, error codes, i18n
│   └── connectors/             connector SDK + first-party connectors
├── docs/                       OpenAPI spec, generated JSON schema, ADR archive
├── uploads/                    Original source requirement documents
├── .github/workflows/          CI
├── tsconfig.base.json
├── package.json                Workspaces + scripts
└── <the root documentation files>
```

Placement rule: code used by two or more apps goes in `packages/`; code used by one app stays in that app. Never import across `apps/*`.

## 7. Non-functional architecture notes

- **Scalability:** API is stateless (scale horizontally); workers scale on queue depth; objects and database are managed services. No in-process session state.
- **Reliability:** upload and job idempotency; retries with exponential backoff; DLQ for poison jobs; visible failure states.
- **Observability:** structured JSON logs with request ID and tenant ID; metrics for queue depth, job latency, extraction failure rate, connector error rate; error tracking per environment.
- **Local/offline:** mobile works offline for capture; local AI mode allows a deployment with no third-party calls (pending Q-004 for a fully standalone desktop).
- **Multi-tenancy:** every table carries `organisation_id`; access always filtered by tenant in the data layer, not only in the UI.

## 8. Known gaps

- No application code, so none of the above is implemented.
- Queue, storage and provider choices are recorded as decisions but not yet validated against a real provider.
- Desktop standalone mode is undecided (`PRD.json` Q-004), which affects how much of the backend can run locally.
