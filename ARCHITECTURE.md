# Architecture

Technical blueprint of the AI Universal Data Capture Platform (IDCP).

> **Reality check:** this document describes the **target** architecture. Only the documentation and a dependency manifest exist today (see `AGENT_STATE.md`). Sections marked *(planned)* are not implemented yet.

---

## 1. System overview

```
┌──────────────────┐        ┌──────────────────┐        ┌───────────────────┐
│   Mobile app     │        │  Desktop app     │        │  Third-party      │
│  Android / iOS   │        │ Win · macOS · Lin│        │  destinations     │
│  (React Native)  │        │   (Electron)     │        │ Excel/Sheets/SQL  │
└────────┬─────────┘        └────────┬─────────┘        │ CRM / ERP / API   │
         │ capture + upload          │ review + jobs   └─────────▲─────────┘
         │ QR pairing / Socket.IO    │ Socket.IO / HTTPS         │
         └───────────────┬───────────┘                           │
                         ▼                                       │
              ┌──────────────────────────────────────────────────┴────┐
              │                     Backend                               │
              │  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐ │
              │  │  REST API   │  │  Job queue   │  │ Connector      │ │
              │  │  (Fastify)  │  │  (BullMQ)    │  │ runtime        │ │
              │  └──────┬──────┘  └──────┬───────┘  └───────┬────────┘ │
              │         │                │                  │          │
              │  ┌──────▼────────────────▼──────────────────▼───────┐  │
              │  │ Domain services: documents · extraction · review │  │
              │  │ mapping · export · audit · devices · tenants     │  │
              │  └──────┬───────────────────────┬───────────────────┘  │
              └─────────┼───────────────────────┼──────────────────────┘
                        ▼                       ▼
              ┌──────────────────┐    ┌────────────────────┐    ┌───────────────┐
              │  PostgreSQL 16   │    │  Object storage    │    │ AI providers  │
              │  metadata, UDM,  │    │  S3 / MinIO        │    │ local OCR +   │
              │  audit, jobs     │    │  document images   │    │ cloud (opt-in)│
              └──────────────────┘    └────────────────────┘    └───────────────┘
```

## 2. Components

### 2.1 Mobile app (`apps/mobile`) — React Native *(planned)*

Responsibilities: QR pairing, camera capture, edge detection/crop/enhancement, offline queue, upload, status display, review of simple fields, secure device credential storage.

- Navigation: React Navigation 7 (stack for flows, bottom tabs for areas).
- State: local persistence for the queue (SQLite/MMKV) plus a lightweight query cache; server state is the source of truth once online.
- Native modules: camera, barcode scanning, document edge detection, secure storage, file system.
- Talks to the backend **only** over HTTPS and authenticated Socket.IO.

### 2.2 Desktop app (`apps/desktop`) — Electron + React *(planned)*

Responsibilities: pairing QR display and device management, live job dashboard, full human-in-the-loop review, mapping configuration, connector setup, exports, analytics later.

- Main process: OS integration, keychain access, auto-update, filesystem writes for exports.
- Renderer: React UI with **no** Node access; all privileged operations go through a validated, allow-listed IPC bridge.
- Security posture per `SECURITY.md` §6.3.

### 2.3 Backend API (`apps/backend`) — Node.js 22 + TypeScript *(planned)*

Split into stateless API and worker process, both from one codebase:

- **API process:** HTTP endpoints, authentication, authorisation, validation, job enqueueing, realtime gateway.
- **Worker process:** OCR/extraction jobs, mapping and connector writes, scheduled retention purges. Horizontally scalable; each job is idempotent.

Domain boundaries (folders under `src/`): `auth`, `authz`, `orgs`, `devices`, `pairing`, `documents`, `ai`, `review`, `mapping`, `connectors`, `export`, `audit`, `retention`, `realtime`.

### 2.4 Shared package (`packages/shared`) *(planned)*

Single source of truth for: Universal Data Model types and Zod schemas, API request/response types, error codes, confidence/review thresholds, i18n catalogues, date/number formatters. Consumed by mobile, desktop and backend.

### 2.5 Connector package (`packages/connectors`) *(planned)*

The connector contract (manifest, capabilities, schema discovery, health check) plus first-party connectors. Connectors are isolated: a failing connector reports an error and never crashes the host process.

### 2.6 AI layer *(planned)*

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
Backend stores image in object storage, creates document + job, emits document.queued
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

| Concern | Choice | Decision |
| --- | --- | --- |
| Mobile | React Native 0.86 / React 19 | DEC-001 |
| Monorepo | npm workspaces + TypeScript | DEC-002 |
| Database | PostgreSQL 16 + Prisma | DEC-003 |
| Interchange format | Universal Data Model (Zod + JSON Schema) | DEC-004 |
| Pairing | Short-lived single-use QR token | DEC-005 |
| Realtime | Socket.IO | DEC-006 |
| AI | Provider abstraction, local-first | DEC-007 |
| Jobs | Redis-backed queue, idempotent workers | DEC-008 |
| Desktop | Electron + React | DEC-009 |
| File storage | S3-compatible object storage | DEC-010 |

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
