# Requirements

**Project:** AI Universal Data Capture Platform
**Version:** 1.0
**Date:** 2026-10-26
**Sources:** `uploads/requirements-1.md`, `uploads/PRD.md`

This document states **what the project needs**. It is the input to `PRD.json`, which turns these requirements into buildable stories. Requirement IDs are stable and referenced from stories and tests.

Traceability rule: every requirement below maps to at least one story in `PRD.json`; every story maps back to a requirement.

---

## 1. Business requirements

| ID    | Requirement                                                                                                                                        | Stories                                           |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| BR-01 | Eliminate repetitive manual data entry from physical documents into business systems.                                                              | M1 stories                                        |
| BR-02 | Let a user photograph a document and get accurate structured data without retyping.                                                                | MOB-002, AI-003                                   |
| BR-03 | Support the document types businesses actually hold: forms, receipts, invoices, IDs, contracts, tables and handwritten documents.                  | AI-002                                            |
| BR-04 | Push clean records into the tools businesses already use: Excel, Google Sheets, CSV, SQL databases, CRM, ERP, accounting software and custom APIs. | EXPORT-001, EXPORT-002, CON-002, CON-003, CRM-001 |
| BR-05 | Preserve human control: uncertain data must be reviewed by a person before it reaches a system of record.                                          | REV-001                                           |
| BR-06 | Provide an auditable record of who captured, reviewed and exported what.                                                                           | AUDIT-001                                         |
| BR-07 | Grow from a single-user MVP into a team and enterprise product without a rewrite.                                                                  | TEAM-001, DEVAPI-001                              |
| BR-08 | Operate as a commercial product with clear ownership of the code and data.                                                                         | Q-002, LICENSE                                    |

## 2. User requirements

### 2.1 Mobile user (capture)

- UR-01: Pair a phone with a computer or backend by scanning a QR code, with no manual typing of URLs or keys.
- UR-02: Capture document pages with automatic edge detection, crop and straightening.
- UR-03: Capture while offline; uploads complete automatically when connectivity returns.
- UR-04: See the status of each captured page (queued, uploading, processed, needs review).
- UR-05: Cancel or retake a capture before it is processed.

### 2.2 Reviewer / back-office user

- UR-06: See the document image side by side with extracted fields.
- UR-07: Have low-confidence fields highlighted and prioritised.
- UR-08: Correct any field quickly and approve the record.
- UR-09: Approve records in bulk, but never bypass unresolved low-confidence fields.
- UR-10: Search and filter documents by status, type, device and date.

### 2.3 Administrator

- UR-11: Invite and remove team members and assign roles.
- UR-12: List, rename and revoke paired devices and API keys.
- UR-13: Configure connectors, field mappings and duplicate-handling policy.
- UR-14: Set data retention periods and delete data on request.
- UR-15: Review an audit trail of privileged actions.

### 2.4 Developer / integrator

- UR-16: Use a documented, versioned API to submit documents and read extracted data.
- UR-17: Build a connector against a stable, typed contract.

## 3. Functional requirements

### 3.1 Device pairing

- FR-01: The desktop/backend generates a temporary QR code.
- FR-02: The mobile app scans the QR code and the devices authenticate.
- FR-03: A secure, encrypted connection is established.
- FR-04: Pairing tokens are single-use and expire (≤ 2 minutes).
- FR-05: Devices can be managed and revoked.

### 3.2 AI processing

- FR-06: Extract text (OCR) from document images and PDFs.
- FR-07: Understand document structure (sections, key-value pairs, line items).
- FR-08: Detect and preserve tables.
- FR-09: Classify the document type.
- FR-10: Recognise fields relevant to the document type.
- FR-11: Produce per-field confidence scores.
- FR-12: Convert every result into the Universal Data Model before any external write.
- FR-13: Support a local AI/OCR mode that works without internet access.

### 3.3 Review

- FR-14: Human-in-the-loop review of uncertain or flagged fields.
- FR-15: Every edit recorded with before/after values, actor and timestamp.
- FR-16: Corrections retained in a structured form usable for learning.

### 3.4 Destinations and connectors

- FR-17: Plugin-based connector system.
- FR-18: Initial connectors: Excel (export), CSV (export), Google Sheets, MySQL, PostgreSQL, SQLite.
- FR-19: Connectors support create, read, update and search.
- FR-20: Map extracted fields to existing destination fields.
- FR-21: Learn from corrections to improve mapping suggestions.
- FR-22: Append, update, merge records and avoid duplicates in existing data.
- FR-23: Future connectors: CRM, ERP, accounting systems, custom APIs.

### 3.5 Enterprise and platform

- FR-24: Document template builder.
- FR-25: Batch processing.
- FR-26: Team collaboration and project management.
- FR-27: Audit trails.
- FR-28: AI automation agents and workflow automation.
- FR-29: Developer API and connector marketplace.
- FR-30: Analytics dashboard.
- FR-31: Multi-language support.
- FR-32: Voice commands and smart camera assistance.

## 4. Non-functional requirements

| ID     | Area            | Requirement                                                                                              |
| ------ | --------------- | -------------------------------------------------------------------------------------------------------- |
| NFR-01 | Performance     | A single invoice-sized page completes OCR + extraction in under 10 s (p95) in the reference environment. |
| NFR-02 | Performance     | Review UI renders the next document in under 1 s from local cache.                                       |
| NFR-03 | Scalability     | Backend designed to process documents asynchronously; workers scale horizontally.                        |
| NFR-04 | Reliability     | Uploads and jobs are retryable and idempotent; no silent data loss.                                      |
| NFR-05 | Availability    | Target 99.5% monthly availability for the API in Phase 1; documented maintenance windows.                |
| NFR-06 | Security        | TLS 1.2+ everywhere; encryption at rest for documents and connector credentials.                         |
| NFR-07 | Security        | Passwords hashed with Argon2id; no plaintext secrets in code or logs.                                    |
| NFR-08 | Security        | Every query scoped to the caller's organisation (multi-tenant isolation).                                |
| NFR-09 | Privacy         | Minimum retention, configurable purge, no training on customer data without opt-in.                      |
| NFR-10 | Accessibility   | WCAG 2.1 AA for desktop review screens; scalable font sizes and screen-reader labels on mobile.          |
| NFR-11 | Usability       | A new user can pair a device and capture the first document in under 3 minutes without training.         |
| NFR-12 | Compatibility   | Desktop: Windows 10+, macOS 13+, Ubuntu 22.04+. Mobile: Android 9+ (API 28+), iOS 16+.                   |
| NFR-13 | Observability   | Structured logs, request IDs, error tracking and metrics for queue depth and job failures.               |
| NFR-14 | Maintainability | TypeScript everywhere, shared types, linted and formatted, ≥ 80% coverage on business logic.             |
| NFR-15 | Portability     | AI providers, storage and database are swappable behind interfaces.                                      |
| NFR-16 | Localisation    | All user-facing strings externalised; UTF-8 and RTL safe layouts.                                        |

## 5. Constraints

- C-01: Existing dependencies (React Native 0.86, React 19, React Navigation 7, Socket.IO 4.8) define the mobile baseline.
- C-02: The application source code exists (backend, desktop, mobile, connector SDK) and all 45 planned stories are implemented; the release-side gaps are listed in `AGENT_STATE.md`.
- C-03: Third-party AI/OCR usage must fit an approved cost model per document (see `PRD.json` Q-001).
- C-04: Mobile distribution goes through Google Play and the Apple App Store; both impose review and privacy-disclosure obligations.
- C-05: Any handling of ID documents and invoices implies personal data obligations (e.g. GDPR/Data Protection Act) — see `SECURITY.md`.

## 6. Hardware and software requirements

**Development machine (what the shipped code needs)**

- Node.js 22 LTS, npm 10+
- Git 2.39+
- Android Studio with JDK 17 and an Android emulator (mobile development)
- Xcode 16+ on macOS (iOS development)
- 4-core CPU, 8 GB RAM minimum; 16 GB recommended for the Android emulator
- No database, cache or object store: the backend runs on SQLite with filesystem storage (DEC-029)

**Runtimes and services**

- SQLite (bundled with Node 22 via `node:sqlite`) for local development and tests
- The filesystem under `STORAGE_PATH` for document images
- An in-process worker polling the `jobs` table
- Optional: an OCR engine (local Tesseract) and one approved cloud AI provider

**Scale-out target (not required to run, required to scale)**

- PostgreSQL 16 as the system of record (`DB_DRIVER=postgres`, DEC-003/DEC-013)
- A shared job queue and more than one worker process
- S3-compatible object storage (MinIO locally) for document images (DEC-010)
- Redis 7 if the queue adapter needs it

See `ENVIRONMENT.md` for setup and `DECISIONS.md` DEC-029 for the order these upgrades go in.

## 7. Security requirements (summary)

- SR-01: No secret, key, token or credential committed to Git. Use `.env` + secret storage.
- SR-02: Authentication required on all non-public endpoints; authorisation checked server-side.
- SR-03: Device credentials stored in OS/secure enclave storage, never plain storage.
- SR-04: Uploaded file content sniffed and validated; size and type limits enforced.
- SR-05: Rate limiting on authentication, pairing, upload and export endpoints.
- SR-06: Input validated against schemas on every endpoint.
- SR-07: Audit log append-only and complete for privileged actions.
- SR-08: Dependencies scanned for known vulnerabilities in CI.

Full detail: `SECURITY.md`.

## 8. Payment requirements

Billing is **not** in Phase 1. When introduced (Phase 2/3) it must:

- Use a PCI-DSS compliant provider (e.g. Stripe/Paystack/Flutterwave) so card data never touches our systems.
- Support subscription plans per organisation with seat and document-volume limits.
- Handle failed payments with grace periods and downgrade paths.
- Keep invoices and tax records for the legally required period.
- Be recorded as a decision in `DECISIONS.md` before implementation.

## 9. Hosting, domain and third-party requirements

- HR-01: Cloud hosting for the API, workers and database with a managed PostgreSQL, backups and point-in-time recovery.
- HR-02: Object storage with server-side encryption and lifecycle rules.
- HR-03: A registered domain (e.g. `idcp.app` — to be confirmed) with DNS managed by the hosting provider or a registrar.
- HR-04: Valid TLS certificates with automatic renewal for all public endpoints.
- HR-05: Separate development, staging and production environments with distinct credentials.
- HR-06: Log retention and error tracking (e.g. Sentry) configured per environment.
- HR-07: Third-party services requiring accounts/keys: AI/OCR provider(s), Google Cloud (Sheets OAuth), app-store developer accounts, email/SMS provider, push notification service.

Pending decisions: hosting provider, domain, region. Tracked as Q-003 in `PRD.json`.

## 10. Acceptance criteria for the whole project

The project is complete (Phase 1 MVP) when a user can:

1. Pair a phone with the desktop app via QR code.
2. Capture a document on the phone, online or offline.
3. Have AI extract text, structure, tables and fields with confidence scores.
4. Review and correct uncertain fields in the desktop app.
5. Export the approved records to Excel and CSV — and, in Phase 2+, into Google Sheets and SQL databases.
6. Do all of the above securely, with an audit trail, without exposing personal data.
