# AI Universal Data Capture Platform (IDCP)

**Photograph a document. Get clean data in the software you already use.**

IDCP is an AI-powered bridge between physical documents and digital business systems. You capture a form, receipt, invoice, ID or contract with a phone, AI extracts and structures the content, a human confirms anything uncertain, and the finished record is pushed into Excel, Google Sheets, CSV, a SQL database or — in later phases — a CRM, ERP or accounting system.

> **Project status: all 45 planned stories are built.**
> The repository contains the backend API (Fastify 5 over SQLite/PostgreSQL), the desktop renderer
> (React 19 + Vite with an Electron shell), the mobile app (React Native), the connector SDK and the
> test suite behind them: `npm run verify` typechecks, lints, checks the PRD/OpenAPI/packaging
> contracts and runs 389 tests in 28 suites. What is deliberately not here yet — signed installers,
> live-database connector runs and the Socket.IO transport — is listed in
> [`AGENT_STATE.md`](AGENT_STATE.md).

---

## Table of contents

- [Product overview](#product-overview)
- [Features](#features)
- [Architecture at a glance](#architecture-at-a-glance)
- [Technology](#technology)
- [Repository structure](#repository-structure)
- [Getting started](#getting-started)
- [Documentation index](#documentation-index)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Product overview

Businesses still run on paper. Someone photographs a delivery note, retypes it into a spreadsheet, and makes a mistake. IDCP replaces that loop:

```
Phone camera  →  AI extraction  →  Human review  →  Business system
   (capture)       (structure)       (approve)         (Excel, Sheets,
                                                          SQL, CRM, ERP)
```

Read the full vision and scope in [`uploads/PRD.md`](uploads/PRD.md) and [`REQUIREMENTS.md`](REQUIREMENTS.md).

## Features

### Available today

Everything in the phases below is built and covered by the test suite. The honest exceptions are
listed in [`AGENT_STATE.md`](AGENT_STATE.md): no signed installers, no live-database connector runs
(adapters are tested against recorded responses), and Socket.IO is replaced by SSE.

### Phase 1 — MVP

- **QR pairing** — pair a phone with the desktop app by scanning a QR code; encrypted channel, revocable devices.
- **Document capture** — camera capture with edge detection, crop, straightening and enhancement; offline-first queue.
- **AI document intelligence** — OCR, document classification, field/table/key-value extraction with per-field confidence.
- **Universal Data Model** — a versioned canonical record format used by every component.
- **Human-in-the-loop review** — side-by-side image and fields; low-confidence values surfaced first.
- **Excel and CSV export** — formatted `.xlsx` and RFC 4180 CSV with injection protection.
- **Desktop app** — Windows, macOS and Linux review and job dashboard.
- **Security baseline** — authentication, RBAC, audit trail, retention controls.

### Phase 2

Google Sheets, MySQL, PostgreSQL and SQLite connectors · field mapping · learning from corrections · duplicate detection and merge · document template builder · batch processing · teams and projects.

### Phase 3 — Enterprise

CRM/ERP/accounting connectors · public developer API · connector marketplace · workflow automation and AI business agents · analytics dashboard · multi-language support · voice commands and smart camera assistance.

## Architecture at a glance

```
        ┌─────────────┐   QR pairing over HTTPS    ┌──────────────┐
        │ Mobile app  │◄──────────────────────────►│              │
        │ Android/iOS │   capture & upload         │   Backend    │
        └─────────────┘                            │   API +      │
                                                   │   worker     │
        ┌─────────────┐   review, jobs, exports    │  (1 process) │
        │  Desktop    │◄──────────────────────────►│              │
        │ Win/mac/Lin │   SSE push                 └──────┬───────┘
        └─────────────┘                                   │
                                     ┌────────────────────┼────────────────────┐
                                     ▼                    ▼                    ▼
                              SQLite locally      Filesystem locally      AI providers
                              PostgreSQL for      S3 for scale-out       (local OCR +
                              production          (adapter pending)        cloud opt-in)
                                                                              │
                                                              ┌───────────────┴─────────────┐
                                                              ▼                             ▼
                                                     Universal Data Model        Excel / CSV / Sheets
                                                                                  SQL / CRM / ERP
```

Full detail, component responsibilities and data flow: [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Technology

| Layer        | Choice                                                                       |
| ------------ | ---------------------------------------------------------------------------- |
| Mobile       | React Native `0.86`, React `19`, React Navigation `7`                        |
| Desktop      | Electron + React `19` + Vite `6` + TypeScript                                |
| Backend      | Node.js 22 + Fastify `5` + TypeScript, no ORM                                |
| Database     | SQLite (`node:sqlite`) locally; PostgreSQL in production (DEC-013)           |
| Storage      | Filesystem via `STORAGE_PATH`; S3 is the scale-out path, adapter not written |
| Realtime     | Authenticated SSE; Socket.IO behind the same interface later (DEC-016)       |
| Shared types | `packages/shared` — Universal Data Model, Zod schemas                        |

Versions actually installed in this checkout: Node `22.22.3`, npm `10.9.8`, git `2.39.5`. See [`ENVIRONMENT.md`](ENVIRONMENT.md).

## Repository structure

```
intelligent-data-capture-platform/
├── apps/
│   ├── backend/          # Fastify API, worker, migrations, tests
│   ├── desktop/          # Electron shell + React renderer
│   └── mobile/           # React Native capture app
├── packages/
│   ├── shared/           # Universal Data Model, Zod contracts, i18n (en/sw/fr)
│   └── connectors/       # Connector SDK + first-party connectors
├── legal/                # Privacy policy, terms, DPA, sub-processors, security summary
├── scripts/              # PRD / OpenAPI / packaging / legal validators
├── docs/                 # openapi.yaml and the JSON schemas
├── uploads/              # Original product & requirements documents
├── PRD.json              # Master plan: epics, stories, statuses, acceptance criteria
├── REQUIREMENTS.md       # What the project needs (business → technical)
├── AI.md                 # Behaviour rules for AI coding agents
├── AGENT_STATE.md        # Handover: where the last agent stopped
├── TASKS.md              # Short-term work queue
├── CHANGELOG.md          # History of changes
├── DECISIONS.md          # Why decisions were made
├── ARCHITECTURE.md       # Technical blueprint
├── DATABASE.md           # Data model blueprint
├── API.md                # HTTP + realtime API contract
├── TESTING.md            # How to prove things work
├── SECURITY.md           # Security rulebook
├── DEPLOYMENT.md         # How to go live
├── ENVIRONMENT.md        # Development setup
├── CONTRIBUTING.md       # How to contribute
├── LICENSE               # Legal terms
├── .env.example          # Required configuration (no real secrets)
└── package.json          # Workspaces, scripts, Jest projects
```

## Getting started

### Prerequisites

- Node.js 22 LTS and npm 10+
- Git
- Android Studio + JDK 17 and/or Xcode 16+ for mobile work
- Nothing else: the backend runs on SQLite with filesystem storage and needs no database, cache or
  object store. PostgreSQL, a shared queue and S3 storage are the scale-out path (DEC-029).

### Install

```bash
git clone <repository-url>
cd intelligent-data-capture-platform
npm install
```

### Configure (optional)

```bash
cp .env.example .env    # every key documented, with its default
# Nothing has to be set for a local run: SQLite, filesystem storage and local OCR are the defaults.
```

### Run

```bash
npm run db:migrate     # create the local database and apply migrations
npm run db:seed        # demo organisation + owner account
npm run dev:backend    # API + worker on http://127.0.0.1:4000
npm run dev:desktop    # renderer on http://127.0.0.1:5173 (proxies /api)
npm run dev:mobile     # React Native Metro bundler
```

Sign in with `owner@example.com` / `demo-password-change-me`.

### Verify

```bash
npm run verify         # typecheck + lint + PRD/OpenAPI/packaging contracts + all tests
npm test               # Jest projects: shared, connectors, backend, desktop, mobile
```

`npm run verify` is the same command CI runs; it currently passes with 389 tests in 28 suites.

### Basic usage

1. Open the desktop app and choose **Pair a device** — a QR code appears.
2. Scan the QR code with the mobile app.
3. Photograph a document; it uploads automatically.
4. Watch AI extraction progress on the desktop.
5. Review highlighted fields, correct anything wrong, and approve.
6. Export to Excel or CSV, or send it straight into a connected system.

## Documentation index

| File                                   | What it answers                                         |
| -------------------------------------- | ------------------------------------------------------- |
| [`PRD.json`](PRD.json)                 | What must be built, story by story, and what is done    |
| [`REQUIREMENTS.md`](REQUIREMENTS.md)   | What the project needs                                  |
| [`AI.md`](AI.md)                       | How AI agents must behave while building it             |
| [`AGENT_STATE.md`](AGENT_STATE.md)     | Where the last agent stopped                            |
| [`TASKS.md`](TASKS.md)                 | What is being worked on now                             |
| [`ARCHITECTURE.md`](ARCHITECTURE.md)   | How the system is put together                          |
| [`DATABASE.md`](DATABASE.md)           | What data is stored and how                             |
| [`API.md`](API.md)                     | How components talk to each other                       |
| [`TESTING.md`](TESTING.md)             | How to verify behaviour                                 |
| [`SECURITY.md`](SECURITY.md)           | How data is protected                                   |
| [`DEPLOYMENT.md`](DEPLOYMENT.md)       | How to put it online                                    |
| [`ENVIRONMENT.md`](ENVIRONMENT.md)     | How to set up a dev machine                             |
| [`DECISIONS.md`](DECISIONS.md)         | Why architecture choices were made                      |
| [`CHANGELOG.md`](CHANGELOG.md)         | What changed and when                                   |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)   | How to contribute code                                  |
| [`legal/`](legal/README.md)            | Privacy policy, terms, DPA and the sub-processor list   |
| [`AUDIT-2026-10.md`](AUDIT-2026-10.md) | The October 2026 hardening audit and what is still open |

## Roadmap

| Milestone | Goal                                                                   | Status |
| --------- | ---------------------------------------------------------------------- | ------ |
| **M0**    | Foundation: docs, tooling, monorepo, CI                                | Done   |
| **M1**    | MVP vertical slice: pair → capture → extract → review → export         | Done   |
| **M2**    | Connector platform, mapping, templates, duplicates, teams              | Done   |
| **M3**    | Enterprise integrations, developer API, marketplace, agents, analytics | Done   |

Story-level detail and statuses live in [`PRD.json`](PRD.json).

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) and, if you are using an AI coding agent, [`AI.md`](AI.md). Work on one story at a time from `PRD.json`, keep `AGENT_STATE.md` and `CHANGELOG.md` updated, and never commit secrets.

## License

Proprietary — all rights reserved. See [`LICENSE`](LICENSE). The licensing model is still pending owner confirmation (`PRD.json` Q-002 / `DECISIONS.md` DEC-011).
