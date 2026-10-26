# AI Universal Data Capture Platform (IDCP)

**Photograph a document. Get clean data in the software you already use.**

IDCP is an AI-powered bridge between physical documents and digital business systems. You capture a form, receipt, invoice, ID or contract with a phone, AI extracts and structures the content, a human confirms anything uncertain, and the finished record is pushed into Excel, Google Sheets, CSV, a SQL database or — in later phases — a CRM, ERP or accounting system.

> **Project status: early foundation.**
> The repository currently contains the documentation pack, a dependency manifest and source requirement documents. There is no application source code, backend, database or test suite yet. See [`AGENT_STATE.md`](AGENT_STATE.md) and [`TASKS.md`](TASKS.md) for exactly where work stands.

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
Nothing functional yet — this is where the first working features will appear as they ship.

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
        ┌─────────────┐   QR pairing + Socket.IO   ┌──────────────┐
        │ Mobile app  │◄──────────────────────────►│              │
        │ Android/iOS │   capture & upload         │   Backend    │
        └─────────────┘                            │   API +      │
                                                   │   workers    │
        ┌─────────────┐   review, jobs, exports    │              │
        │  Desktop    │◄──────────────────────────►│              │
        │ Win/mac/Lin │                            └──────┬───────┘
        └─────────────┘                                   │
                                     ┌────────────────────┼────────────────────┐
                                     ▼                    ▼                    ▼
                              PostgreSQL           Object storage        AI providers
                              (metadata)           (document images)   (OCR / extraction)
                                                                              │
                                                              ┌───────────────┴─────────────┐
                                                              ▼                             ▼
                                                     Universal Data Model        Excel / CSV / Sheets
                                                                                  SQL / CRM / ERP
```

Full detail, component responsibilities and data flow: [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Technology

| Layer | Choice |
| --- | --- |
| Mobile | React Native `0.86`, React `19`, React Navigation `7`, Socket.IO client `4.8` |
| Desktop | Electron + React + TypeScript *(planned)* |
| Backend | Node.js 22 + TypeScript *(planned)* |
| Database | PostgreSQL 16 *(planned)* |
| Storage | S3-compatible object storage *(planned)* |
| Realtime | Socket.IO *(planned channel, client already a dependency)* |
| Shared types | `packages/shared` — Universal Data Model, Zod schemas *(planned)* |

Versions actually installed in this checkout: Node `22.22.3`, npm `10.9.8`, git `2.39.5`. See [`ENVIRONMENT.md`](ENVIRONMENT.md).

## Repository structure

```
intelligent-data-capture-platform/
├── PRD.json              # Master plan: epics, stories, statuses, acceptance criteria
├── REQUIREMENTS.md       # What the project needs (business → technical)
├── README.md             # You are here
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
├── .gitignore
├── uploads/              # Original product & requirements documents
│   ├── PRD.md
│   └── requirements-1.md
├── package.json          # Current React Native dependency manifest
└── node_modules/         # Not committed
```

Target layout once scaffolding (`FOUND-003`) lands:

```
apps/
  mobile/      # React Native (Android + iOS)
  desktop/     # Electron desktop client
  backend/     # API + workers
packages/
  shared/      # Universal Data Model, types, validation, i18n
  connectors/  # Connector SDK + first-party connectors
```

## Getting started

### Prerequisites

- Node.js 22 LTS and npm 10+
- Git
- Android Studio + JDK 17 and/or Xcode 16+ for mobile work
- Docker for PostgreSQL and local object storage (once the backend exists)

### Install

```bash
git clone <repository-url>
cd intelligent-data-capture-platform
npm install
```

### Configure

```bash
cp .env.example .env
# Fill in local values. Never commit .env.
```

### Run

The standard script surface (implemented by `FOUND-003`/`FOUND-004`) will be:

```bash
npm run dev            # start everything available
npm run dev:mobile     # React Native Metro bundler
npm run dev:desktop    # Electron desktop client
npm run dev:backend    # API + workers

npm test               # unit + integration tests
npm run lint           # ESLint
npm run typecheck      # TypeScript, no emit
```

Right now only `npm install` is meaningful. See [`TASKS.md`](TASKS.md) for the path to a runnable app.

### Basic usage (target Phase 1 experience)

1. Open the desktop app and choose **Pair a device** — a QR code appears.
2. Scan the QR code with the mobile app.
3. Photograph a document; it uploads automatically.
4. Watch AI extraction progress on the desktop.
5. Review highlighted fields, correct anything wrong, and approve.
6. Export to Excel or CSV, or send it straight into a connected system.

## Documentation index

| File | What it answers |
| --- | --- |
| [`PRD.json`](PRD.json) | What must be built, story by story, and what is done |
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | What the project needs |
| [`AI.md`](AI.md) | How AI agents must behave while building it |
| [`AGENT_STATE.md`](AGENT_STATE.md) | Where the last agent stopped |
| [`TASKS.md`](TASKS.md) | What is being worked on now |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the system is put together |
| [`DATABASE.md`](DATABASE.md) | What data is stored and how |
| [`API.md`](API.md) | How components talk to each other |
| [`TESTING.md`](TESTING.md) | How to verify behaviour |
| [`SECURITY.md`](SECURITY.md) | How data is protected |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | How to put it online |
| [`ENVIRONMENT.md`](ENVIRONMENT.md) | How to set up a dev machine |
| [`DECISIONS.md`](DECISIONS.md) | Why architecture choices were made |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed and when |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to contribute code |

## Roadmap

| Milestone | Goal | Status |
| --- | --- | --- |
| **M0** | Foundation: docs, tooling, monorepo, CI | In progress |
| **M1** | MVP vertical slice: pair → capture → extract → review → export | Pending |
| **M2** | Connector platform, mapping, templates, duplicates, teams | Pending |
| **M3** | Enterprise integrations, developer API, marketplace, agents, analytics | Pending |

Story-level detail and statuses live in [`PRD.json`](PRD.json).

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) and, if you are using an AI coding agent, [`AI.md`](AI.md). Work on one story at a time from `PRD.json`, keep `AGENT_STATE.md` and `CHANGELOG.md` updated, and never commit secrets.

## License

Proprietary — all rights reserved. See [`LICENSE`](LICENSE). The licensing model is still pending owner confirmation (`PRD.json` Q-002 / `DECISIONS.md` DEC-011).
