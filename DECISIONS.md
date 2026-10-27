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

**Date:** 2026-10-26 · **Status:** Superseded by DEC-016 for the first transport (the client choice still applies if a bidirectional channel is added)

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

## DEC-013 — One schema, two drivers: SQLite locally, PostgreSQL in production

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** Every table is written once as SQL in a forward-only migration runner
(`apps/backend/src/db/migrations.ts`), and the same statements run against `node:sqlite` in
development and tests and against `pg` in production. `DB_DRIVER` selects the adapter; repositories
are the only code that knows which one is live. Statements avoid Postgres-only syntax (no `RETURNING`
dependence, no partial indexes, no `jsonb` operators) so both drivers accept them, and timestamps are
stored as ISO-8601 text.

**Reason:** A single schema keeps the test suite honest — the tests exercise the same SQL that
production runs, which is the failure mode that usually hides in a hand-rolled shim. SQLite means a
new contributor can clone, migrate, seed and run the API in under a minute with no server to install,
and it makes the suite fast enough to run on every commit. Postgres remains the system of record for
hosting, where concurrency, JSONB and point-in-time recovery matter (DEC-003).

**Alternatives considered:** Postgres in Docker for tests (requires Docker everywhere, slows CI, and
still needs a fallback for the desktop's local mode); an ORM such as Prisma (DEC-003 assumed it, but
it adds a generator step and a second schema language for a fifteen-table system); two schemas, one
per driver (drift guaranteed).

**Consequences:** Dialect differences are the developer's responsibility: anything that only works on
one driver needs an adapter branch, and there is a test that boots both the migration runner and the
repositories on SQLite so the divergence is caught. There is no Prisma, so migrations are
hand-written and reviewed rather than generated. Postgres-specific behaviour (concurrent writes,
JSONB query performance, connection pooling) is exercised only in production until a Postgres service
exists in CI.

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

## DEC-018 — Batch progress is derived, never stored

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** A batch stores only its items (`batch_items`) and a nullable `document_id`; the
`processed`, `succeeded` and `failed` counters and each item's status are computed from the
documents when the batch is read.

**Reason:** Counters that are maintained separately from the documents drift the first time a job is
retried, a document is deleted by retention, or two workers touch the same item. Deriving progress
makes "what the batch claims" and "what the documents say" the same thing by construction, and
costs one query per batch read (batches are read by a person watching a screen, not in a hot loop).

**Alternatives considered:** A `status` column on `batch_items` updated by the worker (fast reads,
two sources of truth); a materialised counters row updated in the same transaction as the document
(also fast, still driftable on backfill).

**Consequences:** `GET /batches/:id` costs a lookup per item; a batch is capped at 100 files, so the
cost is bounded. A file rejected before a document exists is stored with `document_id = NULL` and an
`error`, which is why `batch_items.document_id` is nullable.

---

## DEC-019 — Invitation tokens are stored hashed, and shown once

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** `POST /users/invite` mints a random token, stores only its SHA-256 in `invitations`,
and returns the accept URL in that response. This deployment sends no email, so the admin passes the
link on. Acceptance marks `used_at` with a conditional update (the double-use guard) and expires
after `INVITATION_TTL_SECONDS` (default 7 days).

**Reason:** An invitation is a bearer credential for an account. Hashing it means a database leak
cannot be replayed as invitations, and comparing hashes keeps the lookup a single indexed query.
Returning the link instead of pretending to email it keeps the flow honest and testable.

**Alternatives considered:** Storing the token plaintext (simpler, leaks usable credentials);
building SMTP delivery now (out of scope, and untested without a mail server).

**Consequences:** There is no "resend" that produces the same link — a new invitation is a new row.
`GET /invitations` never returns tokens, so a lost link means revoke and invite again.

---

## DEC-020 — Duplicate preview is a read, and merges never overrule a human

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** `GET /documents/{id}/duplicates` scores the mapped record against the destination and
returns the top five candidates, but writes nothing. Sending decides from the mapping profile's
`duplicatePolicy`: `append` always creates, `skip` reports `skipped_duplicate`, `update` overwrites
the matched row with mapped values, and `merge` fills only the gaps. `mergeRecord()` refuses to
overwrite a field a reviewer confirmed (`confidence >= 1` in the UDM) or a duplicate key, and refuses
to blank a value with an empty incoming one; every ignored value is reported back.

**Reason:** Preview and send are different intents: one is a question, the other is a write. Keeping
the preview side-effect free makes it safe on a laptop in a meeting. For merges, the reviewer's
correction is the most expensive fact in the system — a later sync must not quietly undo it.

**Alternatives considered:** Upserting on the destination's own unique index (each connector would
answer differently, and reviewers would lose their corrections); a dry-run flag on `send` (mixable
semantics, one accidental flag away from a write).

**Consequences:** A connector without `read` cannot preview or skip duplicates and must be sent with
`append`; `update`/`merge` on a connector without `update()` fails with a conflict rather than
silently appending. `confidence = 1` now has a specific meaning: a human put this value there.

---

## DEC-021 — Corrections record the document type, and training use is opt-in

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** `review_changes` stores `document_type` alongside the before/after values. Aggregates
are available to any signed-in member (`GET /review/corrections`), but the training export is
admin-only and returns `409` unless the organisation has set `learningOptIn` to true. Opting in is a
switch in Settings, off by default.

**Reason:** Aggregates ("invoice totals keep being corrected") are operational feedback and belong
to the team doing the work. The rows themselves are customer content: using them to improve a model
is a different purpose from capturing them, so it needs an explicit, reversible choice.

**Alternatives considered:** Treating the terms of service as consent (indefensible for a document
platform); gating on a super-admin flag (moves the decision away from the customer).

**Consequences:** Nothing is exported by accident; an opted-in organisation gets the rows with
document type, field path and confidence, and every export is audited.

---

## DEC-022 — The desktop packaging contract is validated, not executed, in CI

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** The Electron shell ships with an `electron-builder.json` (NSIS/portable for Windows,
DMG/ZIP for macOS, AppImage/DEB for Linux, ASAR on, both builds in `files`) and
`scripts/validate-packaging.mjs` asserts the parts that matter for security and start-up: three
platform target sets, ASAR, the compiled main entry point, and `contextIsolation: true` /
`nodeIntegration: false` / `sandbox: true` in the window. `npm run package` builds installers with
`npx electron-builder`, outside CI.

**Reason:** Producing installers needs platform toolchains, signing keys and multi-hundred-megabyte
binaries — none of which belong in a test run that must stay fast. The failure modes that matter
(renderer with Node access, an app that starts the wrong file, ASAR disabled) are static and can be
caught in milliseconds.

**Alternatives considered:** Installing Electron in CI to launch the app headlessly (slow, needs a
display server or xvfb, and still cannot prove a signed installer works).

**Consequences:** The configuration cannot drift unnoticed, but a real installer still has to be
built and smoke-tested on each platform before a release; that remains a release-checklist item.

---

## DEC-023 — Edge detection is a closed-form detector, not a model

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** The phone finds the page with a small classical pipeline — average downscale to 200 px,
Sobel magnitude, Otsu threshold, then the four extreme points of the strong edges (min/max of x±y).
The result is smoothed across frames, rejected when it covers almost the whole frame or is a sliver,
and mapped from preview to photo coordinates before cropping.

**Reason:** It runs on every frame on a mid-range Android phone, it has no model to ship or train, and
it is deterministic enough to unit-test with synthetic frames — the tests draw a rotated bright page
on a dark desk and assert the outline follows it. A learned detector would be better on crumpled
paper, but it would also be a black box we cannot test here.

**Alternatives considered:** A TFLite document detector (better on hard captures, but a binary to
ship, and untestable in this environment); asking the user to drag four corners every time (slow, and
the acceptance criterion is automatic detection).

**Consequences:** Very low-contrast pages (white on white) and extreme perspective still produce no
outline; the capture screen then simply sends the full frame, and the review step is unchanged.

---

## DEC-024 — CRM destinations are thin vendor adapters over one HTTP contract

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** HubSpot, Odoo and QuickBooks each get their own adapter, but share one transport:
URL validation (https, loopback excepted), timeouts, JSON envelope handling and error translation in
`packages/connectors/src/crm/http.ts`. Each adapter implements `create`, `read`, `search` and
`update`, and the duplicate lookup prefers `search` when a connector exposes it.

**Reason:** The vendors differ in ways that matter (HubSpot wraps properties, QuickBooks has no REST
search, Odoo is JSON-RPC with a uid), but the surrounding concerns are identical. Writing them once
means a new vendor is ~150 lines, and a new error case is fixed in one place.

**Alternatives considered:** A generic "REST connector" configured entirely by the user (moves the
vendor quirks into a config file nobody tests); one class with `if (vendor === …)` branches (the
tests would have to cover every combination of branches).

**Consequences:** Vendor-specific features (HubSpot associations, QuickBooks batch requests, Odoo
one2many writes) are not exposed yet; the contract's `values` map is flat by design (UDM-001).

---

## DEC-025 — A marketplace package is a signed manifest, not code

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** Catalogue entries are manifests: `{id, type, version, permissions, …}` plus an
HMAC-SHA256 over those fields. `type` must already exist in the connector registry — installing a
package does not download or execute anything. Every install is an admin action that records the
permissions it grants, and a package that was never signed, or whose permissions were edited after
signing, is refused. Withdrawn packages stay in the catalogue with the vendor's reason. Rolling back
retires the current install row and reactivates the one before it (ordered by a per-organisation
install counter, not by clock), leaving the connector itself untouched.

**Reason:** Code distribution is a different risk class from configuration. By keeping packages to
manifests, an install can be reviewed, audited and undone by a person, and a compromised catalogue
cannot ship a payload. Showing permissions as sentences before install is the only way the person
clicking the button can meaningfully consent.

**Alternatives considered:** Shipping connector code as downloadable plugins (needs a sandbox and
signing infrastructure that does not exist yet); a single "marketplace" boolean per connector
(no versioning, no permission disclosure, no rollback).

**Consequences:** Third-party connectors cannot arrive without a release of `@idcp/connectors`; that
is deliberate until there is a process to review code. Version comparison is dotted-numeric, so
pre-release suffixes are not ordered semantically.

---

## DEC-026 — A workflow proposes; a person disposes

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** Workflow actions are evaluated in a pure engine (`planWorkflow`) that returns a plan,
not an effect. Any action that leaves the platform or destroys data (`send_to_connector`,
`create_export`, `delete_document`) is marked `requiresApproval` and the run is stored as
`awaiting_approval`; nothing runs until a reviewer approves **that run**. `notify` is not
destructive, so it completes immediately — as a recorded output, not a delivered message, because
this deployment has no mail transport. `approvalPolicy: 'auto_approve'` unlocks the gate for a rule,
and only an owner may create one. Every evaluation writes a run row, matched or skipped, with the
sentence explaining the outcome; a failed action is recorded as `failed` and the remaining rules are
still evaluated.

**Reason:** Automation is trusted in proportion to how easy it is to see what it did. Approval per
run (rather than per rule) keeps the blast radius to one document, and an explanation column means
"why didn't this fire?" is answered from the log instead of from code. Recording a failure rather
than throwing keeps one broken connector from silently disabling every other rule.

**Alternatives considered:** Executing destructive actions inline with an undo (the connector has
already written by then); per-rule approval that lasts forever (one mistaken click authorises every
future document); a visual rule graph (the rules that matter fit in a sentence, and a graph hides
the sentence).

**Consequences:** A workflow that sends to a destination always has a human in the loop unless an
owner opts out; unattended runs of destructive actions are possible only by explicit owner decision
and are audited (`workflow.run_approved`). Rules cannot branch — a condition list is one AND — and
`notify` does not deliver anything until a mail transport exists.

---

## DEC-027 — Voice is a consent gate and a transcript, never a recording

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** Voice is off by default on every device. `createVoiceAssistant` is the only object that
touches the microphone, and it refuses to call the recogniser while the operator has not enabled
voice _and_ granted the permission — so "voice commands can be disabled" is a property of the object
the screens hold rather than a convention they must remember. The recogniser is asked for text only;
`transcriptOnly()` strips anything audio-shaped from a result before the app can see it, and there is
no code path that writes an audio buffer. Keeping the command text is a separate switch, off by
default, and it is dropped when voice is switched off or the permission is revoked.
Capture guidance is computed from the detector's output (luma, glare, area, contrast, confidence) with
no network and no speech in the loop, and it is announced only after a cue holds for three frames and
not again within a cooldown.

**Reason:** The acceptance criterion is "no audio is stored or transmitted without consent", and the
only trustworthy way to satisfy it is to make audio-keeping impossible rather than conditional.
Guidance is the part that must work in a basement with no signal, so it depends on nothing but the
frame. Choppy speech recognition plus a destructive action ("approve") would file records nobody
reviewed, hence the second utterance.

**Alternatives considered:** Always-on listening with an on-screen indicator (a microphone that opens
without a deliberate act is exactly what operators distrust); cloud recognition (audio leaves the
device, and the criterion forbids it without consent); guiding from text the server returns (fails
exactly when the operator is offline).

**Consequences:** Speech recognition needs `@react-native-voice/voice` and output needs
`react-native-tts`; without them the shim reports "unavailable" and the screens stay button-only.
Command phrases are a fixed book per locale rather than free-form language, and the field-jump
commands use the field name only when the phrase book matched a command first.

---

## DEC-028 — One catalogue, logical CSS, and a direction the platform cannot get wrong

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** Every user-facing string in the desktop and mobile renderers comes from the shared
catalogue (`packages/shared/src/i18n.ts`), which is complete in English, Swahili and French — the
coverage test asserts 1.0 for all three, so a half-translated locale cannot ship. Components read the
translator from a React context (`apps/desktop/src/lib/locale.tsx`) whose default is English, so a
component rendered alone still works. Dates, numbers, percentages and relative times use `Intl` with
a locale → BCP-47 map (`en → en-GB` keeps the existing output). Text direction comes from
`directionFor(locale)` and is applied to the document root; the layout uses only logical CSS
properties (`border-inline-end`, `text-align: start`, `margin-inline-*`), and a test reads the
stylesheet to make sure no physical `left`/`right` property creeps back in.

**Reason:** A translated string inside a hardcoded layout is not localisation — it is English with
different words. Two rules make the work finishable and keep it finished: the catalogue is the only
place words live, and the layout never mentions a side. Values that arrive from the API (statuses,
document types, roles) are labelled through helpers that fall back to the raw value, so a new enum
member is readable before its translation lands.

**Alternatives considered:** i18next or a runtime loader (a second catalogue format and a network
dependency for strings that ship with the app); per-component translation tables (eleven places to
forget); mirroring with a separate RTL stylesheet (two layouts to keep in sync forever).

**Consequences:** Adding a language is a catalogue plus an entry in `LAYOUT`/`LOCALE_OPTIONS`. The
phone has no language picker: it follows the device language, which is the behaviour a capture
operator in the field expects, and the desktop's picker covers shared workstations. Right-to-left is
verified by the direction helper and the logical-property test rather than by a shipped RTL locale,
because none of the three supported languages is RTL yet.

---

## DEC-029 — The shipped runtime is one process: SQLite, a filesystem and an in-process worker

**Date:** 2026-10-26 · **Status:** Accepted

**Decision:** A single API process is the whole backend. It stores data in SQLite (`node:sqlite`),
writes original files under `STORAGE_PATH` on the filesystem, and runs the job worker on a timer
inside the same process (`WORKER_ENABLED`, `WORKER_POLL_INTERVAL_MS`) reading a `jobs` table.
PostgreSQL, an S3-compatible object store and an external queue are the scale-out path, not
dependencies of the shipped default: selecting `STORAGE_DRIVER=s3` fails fast with a message saying
so, and there is no Redis client in the tree.

**Reason:** Every requirement in this product — pairing, capture, extraction, review, export,
connectors, workflows — can be served by one process, and a deployment that needs three services
before it can start is a deployment that fails on a Tuesday night. Reading jobs from a table
(rather than a broker) also gives the audit trail for free: the queue is inspectable with the same
SQL as everything else, and a crashed worker's job is visible rather than gone. `DEC-008` chose
"asynchronous with idempotency keys", which this satisfies; the _transport_ of that asynchrony is an
implementation detail with a documented upgrade.

**Alternatives considered:** Redis plus BullMQ behind `REDIS_URL` (a second service, a second failure
mode, and a second set of credentials to protect, for a workload of tens of documents a minute);
S3/MinIO from day one (needs credentials and a bucket to run the test suite); a separate worker
process (correct at scale, pointless before the first customer).

**Consequences:** Horizontal scaling needs the three upgrades in this order — Postgres
(`DB_DRIVER=postgres`), a shared queue, then object storage — and until then the process must not be
run with more than one replica: two workers would be safe (jobs are claimed transactionally and
carry idempotency keys) but two SQLite writers are not. `ARCHITECTURE.md` §4, `DEPLOYMENT.md` §3 and
`REQUIREMENTS.md` §6 describe the target architecture and now point here; `ENVIRONMENT.md` describes
what actually runs today.

---

## DEC-030 — Password reset is a single-use hashed token, and the API never confirms an account exists

**Date:** 2026-10-27 · **Status:** Accepted

**Decision:** `POST /auth/password/forgot` always answers `202 {"accepted": true}`. When the address
belongs to a live account the server writes a random 32-byte token, stores only its SHA-256 hash in
`password_resets` with a one-hour expiry, and — because no mail transport exists — returns `resetUrl`
in the response **only outside production**. `POST /auth/password/reset` consumes the token (single
use), enforces the same password policy as registration, and revokes every session for the account.

**Reason:** Password recovery is the one flow that turns an enumeration hole into a customer-facing
incident: a distinguishable response ("no such account") is a free account-existence oracle. Storing
only a hash means a leaked database backup does not hand over reset links. Revoking sessions on reset
is the only honest interpretation of "I think someone else has my password".

**Alternatives considered:** Emailing a plaintext temporary password (a password in an inbox forever,
and it cannot be rate limited by expiry); a token stored in plaintext (a backup leak becomes account
takeover); a signed stateless token (cannot be revoked or marked single-use without the same table);
returning `resetUrl` in production too (that is account takeover by API call, so `NODE_ENV` gates it).

**Consequences:** The production operator has to deliver the link out of band until `EMAIL_PROVIDER`
exists — the limitation is stated in `legal/PRIVACY.md`, `ENVIRONMENT.md` and the API reference rather
than hidden. The generic 202 means a support agent cannot tell a customer whether the address is
registered from this endpoint, which is intended. `apps/backend/test/auth-recovery.test.ts` asserts the
indistinguishable response, the single use and the session revocation.

---

## DEC-031 — Retention and housekeeping run in-process, on an interval, and are safe to run twice

**Date:** 2026-10-27 · **Status:** Accepted

**Decision:** A `MaintenanceService` scheduled inside the API process sweeps expired sessions, expired
password resets, expired pairing codes, expired export files and documents past their organisation's
retention window; it runs every `MAINTENANCE_INTERVAL_MS` (default 24 hours, first run 10 s after boot), only when
`MAINTENANCE_ENABLED` is not `false`, and it is exposed as methods so the tests and an operator can
invoke each step directly. Every step is idempotent and bounded (a limit per run, oldest first).

**Reason:** The privacy policy now states retention periods, so something has to enforce them —
a policy with no scheduler is a promise waiting to be broken by the first audit. An in-process timer
avoids adding cron, a supervisor, or a second deployment artefact to a single-process product, and it
inherits the process's configuration and logging for free.

**Alternatives considered:** `setInterval` firing at import time (untestable, starts during a test run);
a cron entry in the deployment guide (one more thing that silently is not installed); a Postgres
`pg_cron` job (excludes the default SQLite deployment); doing it lazily on read (only cleans what
somebody happens to look at).

**Consequences:** With more than one replica every replica sweeps; the steps are idempotent so this is
wasteful rather than wrong, and it is another entry in the list of things that must change before
horizontal scaling (`DEC-029`). The defaults are mirrored in `legal/PRIVACY.md` and asserted by
`npm run test:legal`, so changing a retention default without changing the policy fails CI.

---

## DEC-032 — Acceptance of the legal pack is a server-side record, keyed by version

**Date:** 2026-10-27 · **Status:** Accepted

**Decision:** Registration requires `acceptTerms: true`, and the server — not the client — writes
`users.terms_accepted_at` and `users.terms_version` from the `LEGAL_VERSION` constant, auditing
`auth.register` with that version. `GET /auth/me` returns the record and whether it is current;
`POST /auth/terms/accept` writes it for accounts that predate the pack or whose pack was revised.
The acceptance is displayed to the account holder under **Account → Terms and privacy**.

**Reason:** A privacy policy nobody agreed to protects nobody, and "the customer clicked through the
sign-up form" is not evidence a year later. Storing the version that was accepted turns the terms
into a contract that can be proved per account, and makes a material revision a measurable event
rather than an edit buried in a repository. Sending the version from the client would let any client
claim any version, so the server stamps it.

**Alternatives considered:** A boolean `accepted_terms` column (proves nothing about _what_ was
accepted, so a revision cannot be detected); a separate `terms_acceptances` history table (correct
for a legal archive, but the per-account record plus the append-only audit trail already answers the
two questions a dispute asks: did they accept, and which version); a click-through modal on every
product update (hostile, and unenforceable at the API layer).

**Consequences:** `LEGAL_VERSION` must be bumped in the same commit as a material change to the
documents — `legal/README.md` states the rule and `npm run test:legal` keeps the pack internally
consistent. Accounts created before the feature report `current: false` until they accept, and the
desktop shows the prompt; the API does not lock anybody out, because a lockout triggered by a policy
edit is a worse outcome than a stale acceptance.

---

## DEC-033 — `trustProxy` is configuration, not a constant

**Date:** 2026-10-27 · **Status:** Accepted

**Decision:** `TRUST_PROXY` (default `true`) controls whether Fastify trusts `X-Forwarded-For` when
deriving `request.ip`. It is true by default because the documented deployment (§ `DEPLOYMENT.md`) is
behind nginx/Caddy, which overwrites the header. A deployment that exposes the API directly sets
`TRUST_PROXY=false`.

**Reason:** The header is attacker-controlled unless something in front of the API rewrites it. With
proxy trust always on, a direct client can rotate a fake `X-Forwarded-For` per request and walk past
the per-IP rate limits on login and password reset — the two endpoints where rate limiting matters
most. The per-account limits still apply, which is why this was medium rather than critical.

**Alternatives considered:** Leaving it hard-coded `true` (correct for the documented topology, wrong
for the topology a hurried operator actually builds); defaulting to `false` (breaks the documented
proxy setup: every request would appear to come from the proxy, collapsing per-IP limits into one
shared bucket); a numeric hop count (more precise, needs the operator to know their topology exactly).

**Consequences:** One more key in `ENVIRONMENT.md` and `.env.example`, guarded by
`test/config.test.ts`. `DEPLOYMENT.md` tells the operator which value belongs to which topology.

---

## Template for new decisions

Copy this block, replace `DEC-0NN` with the next free number, and keep the list in numeric order.

```markdown
## DEC-0NN — <short title>

**Date:** YYYY-MM-DD · **Status:** Proposed | Accepted | Superseded

**Decision:** <one or two sentences>

**Reason:** <why>

**Alternatives considered:** <what else, and why not>

**Consequences:** <what this commits us to>
```

---
