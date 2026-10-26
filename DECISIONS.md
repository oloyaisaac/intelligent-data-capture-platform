# Architecture Decisions

Why the project works the way it does. Record the decision, the reason, the alternatives considered and the consequences.
**Do not reverse a decision silently** — add a new decision that supersedes the old one, and say why.

Convention: `DEC-###` · status `Proposed | Accepted | Superseded by DEC-###`.

---

## DEC-001 — Cross-platform mobile client

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** Build the Android and iOS apps with React Native (0.86) and React 19.

**Reason:** One codebase and one language (TypeScript) for both stores, with access to native camera, secure storage and barcode scanning through well-maintained modules. The dependency baseline was already chosen in the initial commit.

**Alternatives considered:** Native Kotlin + Swift (best performance and camera control, double the cost); Flutter (strong UI, but a second language/Dart and no reuse of the planned TypeScript domain model); a mobile-first PWA (no reliable background upload or high-quality camera pipeline on iOS).

**Consequences:** Some native modules are required (camera, QR scan, document edge detection). JS-side image preprocessing is limited; heavy work must happen native-side or on the backend.

---

## DEC-002 — Monorepo with TypeScript workspaces

**Date:** 2026-10-26 · **Status:** Accepted

**Reason:** The Universal Data Model, its Zod schemas and the connector contract must be identical in mobile, desktop and backend. A monorepo with `packages/shared` and `packages/connectors` makes that possible without publishing internal packages.

**Alternatives considered:** Separate repositories (contract drift, painful versioning for an early-stage product); single flat repository without packages (unclear boundaries).

**Consequences:** Requires workspace tooling and a shared `tsconfig.base.json` (`FOUND-003`). CI must build and lint per workspace.

---

## DEC-003 — PostgreSQL as the system of record

**Date:** 2026-10-26 · **Status:** Accepted

**Reason:** Relational integrity for organisations, devices, documents, extraction results and audit records; JSONB for the flexible parts of the Universal Data Model; strong transactional guarantees for review and export; widely available managed hosting with point-in-time recovery.

**Alternatives considered:** MongoDB (flexible documents, weaker multi-entity consistency and reporting); Firebase Firestore (fast start, but vendor lock-in, weak relational queries and costly audit/reporting patterns); SQLite only (fine for a local desktop mode, not for multi-tenant hosting).

**Consequences:** Requires migrations (Prisma) and a hosted database in production. SQLite may still be used for a future local-only desktop mode.

---

## DEC-004 — Universal Data Model as the mandatory interchange format

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** No connector or export ever reads AI provider output directly. Everything is converted to and validated against the versioned UDM first.

**Reason:** Providers change, models differ and vendors leak types. One canonical schema keeps connectors stable, makes review predictable and allows provider swaps without touching business logic.

**Consequences:** A conversion layer must be maintained per provider. Provider-specific detail is kept as provenance rather than dropped.

---

## DEC-005 — QR pairing with short-lived, single-use tokens

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** Desktop requests a pairing session; the QR payload contains a random single-use token (≤ 2 minutes) and the API endpoint — never a long-lived secret or personal data. The phone exchanges the token for a device credential stored in platform secure storage.

**Reason:** Typing URLs and keys on a phone is error-prone; embedding long-lived credentials in a QR code is unsafe because codes can be photographed.

**Alternatives considered:** Manual pairing code entry (slower, still needed as a fallback); unauthenticated local LAN discovery (unsafe on shared networks).

**Consequences:** Pairing must handle expiry and retry gracefully. Device credentials must be revocable (`PAIR-004`).

---

## DEC-006 — Socket.IO for the realtime device channel

**Date:** 2026-10-26 · **Status:** Accepted

**Reason:** `socket.io-client` is already a dependency; it provides reconnection, rooms and acknowledgements out of the box, which matters for job progress updates on flaky mobile networks.

**Alternatives considered:** Raw WebSockets (more work to get reconnection right); HTTP polling only (simpler but slower and chattier); server-sent events (one-way only).

**Consequences:** Socket authentication must use the same device credentials as HTTP. Events must be versioned and documented in `API.md`.

---

## DEC-007 — Provider-agnostic AI with a local-first default

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** OCR and extraction go behind a single internal interface (`AI-004`). A local engine is the default; cloud providers are opt-in per organisation.

**Reason:** Customer documents are sensitive. Local processing supports offline and privacy-sensitive deployments; a narrow interface avoids lock-in and lets cost/accuracy be traded per customer.

**Consequences:** Two code paths to test. Provider output must be normalised into the UDM. Cloud usage requires explicit approval and a recorded decision (`PRD.json` Q-001).

---

## DEC-008 — Asynchronous job processing with idempotency keys

**Date:** 2026-10-26 · **Status:** Accepted

**Reason:** OCR and extraction are slow and can fail; doing them in the request cycle would make uploads fragile. Async jobs with retries, exponential backoff and idempotency keys make uploads safe to repeat from mobile.

**Alternatives considered:** Synchronous processing (simpler, times out on large documents, poor mobile experience).

**Consequences:** Need a queue (Redis-backed), job status transitions, and per-item status visible in mobile and desktop. Every job status change is bounded by the states in `DATABASE.md`.

---

## DEC-009 — Electron for the desktop application

**Date:** 2026-10-26 · **Status:** Accepted

**Reason:** Windows, macOS and Linux from one TypeScript/React codebase, sharing types and UI patterns with mobile and reusing the web ecosystem for review screens.

**Alternatives considered:** Tauri (smaller binaries, Rust toolchain required); separate native apps (triple cost).

**Consequences:** Strict Electron hardening is mandatory (context isolation, no Node in the renderer, IPC allow-list, OS keychain for tokens) — see `SECURITY.md`.

---

## DEC-010 — Object storage for document images, database for metadata

**Date:** 2026-10-26 · **Status:** Accepted

**Reason:** Images are large and belong in S3-compatible storage with server-side encryption and lifecycle rules; the database keeps searchable metadata, hashes and processing state.

**Alternatives considered:** Storing blobs in PostgreSQL (simple but bloats backups and hurts performance); local disk (not durable or scalable).

**Consequences:** Deletion must purge both storage objects and rows (`SEC-001`). Access to objects is always brokered through the API, never public buckets.

---

## DEC-011 — Proprietary licence pending owner confirmation

**Date:** 2026-10-26 · **Status:** Proposed

**Decision:** Ship a proprietary "all rights reserved" `LICENSE` placeholder and keep the repository private until the owner confirms the commercial model.

**Reason:** This is intended to be commercial software, so defaulting to MIT would give away rights the owner may not intend to grant.

**Open:** `PRD.json` Q-002. Replace `LICENSE` with the chosen licence before any public release.

---

## DEC-012 — Documentation as the coordination layer for AI-assisted development

**Date:** 2026-10-26 · **Status:** Accepted

**Reason:** With multiple AI agent sessions working on the same repository, context is lost between sessions. A fixed set of documents — `PRD.json` (what), `AI.md` (how), `AGENT_STATE.md` (where), `DECISIONS.md` (why), `CHANGELOG.md` (history) — makes handovers cheap and prevents duplicated or contradictory work.

**Consequences:** Updating these files is part of the definition of done, not optional paperwork. `PRD.json` statuses must reflect reality; a stale status file is worse than none.

---

## DEC-014 — Node-only helpers live at `@idcp/shared/ids`

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** The shared package's main entry re-exports everything that is safe in a browser and
in React Native. Identifier, token and hashing helpers (`newId`, `newToken`, `hashToken`, `hashIp`,
`isUuid`, `safeCompare`, `newSortableId`) live in a separate entry point, `@idcp/shared/ids`, which
depends on `node:crypto` and is imported by the backend only.

**Reason:** React Native's bundler does not shim `node:crypto`. Re-exporting the ids module from
`index.ts` made the mobile bundle fail to resolve, and the error surfaces only at bundle time — long
after the backend tests pass. Splitting the entry points makes the constraint structural.

**Alternatives considered:** A polyfill dependency (adds a crypto implementation to the client for
no reason); runtime feature detection (fails at bundle time, not run time, so it cannot help).

**Consequences:** Any new Node-only helper goes in `ids.ts` and must be imported from
`@idcp/shared/ids`. Jest and `tsconfig.base.json` map both specifiers.

---

## DEC-015 — Templates drive extraction expectations

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** A document template (TPL-001) is a versioned list of expected field paths for one
document type. The extractor receives that list and records a field the OCR could not find as
`value: null`, `confidence: 0`, `needsReview: true` — instead of silently omitting it.

**Reason:** Silence is the dangerous outcome in data capture: a missing purchase order looks like a
complete record. Recording the absence pushes the record into the review queue and keeps the
template's promise honest. Changing a field list writes a snapshot to `template_versions`, so an
extraction performed under an older layout can always be explained.

**Alternatives considered:** Post-processing in the review service (hides the expectation from the
extraction record); hard-coded required fields per document type (not customer-specific).

**Consequences:** Extraction output depends on the organisation's active template; disabling a
template removes its expectations without deleting history.

---

## DEC-016 — Authenticated SSE as the first realtime transport

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** The desktop dashboard consumes `GET /api/v1/events`, a server-sent event stream
scoped to the caller's organisation. Publishing goes through the `RealtimeHub` interface, so a
Socket.IO adapter can be added without touching services.

**Reason:** SSE needs no extra dependency, works through the Vite dev proxy and corporate proxies,
and reconnects by itself; the client already implements capped exponential backoff. `EventSource`
cannot send headers, so this one route also accepts the access token as a query parameter, and only
identifiers — never document content — travel in payloads.

**Alternatives considered:** Socket.IO (better for bidirectional device channels, heavier);
long polling (worse latency, more requests).

**Consequences:** The desktop is push-driven today. When the mobile app needs server-initiated
messages (`PAIR-003` follow-up), add the Socket.IO adapter behind the same interface and document
both transports in API.md §9.

---

## DEC-017 — API key scopes map onto the role ladder

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** An API key carries scopes; the narrowest role that implies those scopes becomes the
key's effective role, and it is further capped by the live role of the person who created the key.
`X-API-Key` is authenticated by the same guard that handles bearer tokens and device credentials.

**Reason:** A second permission system would inevitably drift from the first. Re-using the role
ladder means every existing authorisation check applies unchanged, and revoking a person's
membership instantly narrows their keys.

**Alternatives considered:** Per-endpoint scope checks (more precise, but a parallel system to keep
in sync); treating keys as owners (too much authority for an integration).

**Consequences:** New scopes must state which role they imply. A key can never exceed its creator's
current role, even after a role change.

---

## Template for new decisions

```markdown
## DEC-013 — <short title>

**Date:** YYYY-MM-DD · **Status:** Proposed

**Decision:** <one or two sentences>

**Reason:** <why>

**Alternatives considered:** <what else, and why not>

**Consequences:** <what this commits us to>
```
