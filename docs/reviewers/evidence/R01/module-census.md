# R01 module-size and client-coupling notes — interim

Tracked TypeScript/TSX files below workspace `src/`, measured on `7dc278c`, excluding tests and
build output. Counts are a triage aid, not a defect threshold or a claim that decomposition was
completed. `commands.log` contains the broader top-30 listing including tests; its `head` pipeline
returns 141 under `pipefail` because `sort` is interrupted after the requested lines.

| Source file                                      | Lines | Assessment / possible seam                                                                                                                                                       |
| ------------------------------------------------ | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/i18n.ts`                    |  2121 | Large catalogue data, not one control-flow routine. Separate locale catalogues and validate key parity if changed; coverage does not prove all UI text is translated.            |
| `apps/backend/src/services/auth-service.ts`      |   994 | Security-sensitive authentication, sessions, invitations and MFA share a service. Candidate seams by use case, preserving transaction and credential-organisation checks.        |
| `apps/desktop/src/api/client.ts`                 |   973 | Many endpoint wrappers plus session refresh/token handling. Split transport/auth from domain endpoint groups; keep error and refresh behavior covered.                           |
| `packages/shared/src/contracts.ts`               |   971 | Shared schemas and types across domains. Candidate domain-specific modules behind a stable public barrel; version compatibility matters.                                         |
| `apps/desktop/src/pages/SettingsPage.tsx`        |   695 | Multiple settings concerns in one UI module. Extract sections and shared form primitives without changing role guards.                                                           |
| `apps/backend/src/services/connector-service.ts` |   624 | Configuration, mapping and execution coordination plus failure boundaries. Separate use-case seams while preserving tenant scoping and secret masking; isolation remains absent. |
| `apps/backend/src/db/migrations.ts`              |   576 | Historical forward-only SQL naturally accumulates. Split into ordered migration modules only with unchanged IDs/order and verified upgrade tests.                                |
| `apps/backend/src/repositories/auth-repo.ts`     |   549 | Persistence for multiple authentication entities. Split repositories by entity or use case while preserving transaction-scoped composition.                                      |
| `apps/desktop/src/workflows/WorkflowsPage.tsx`   |   519 | Workflow editor, evaluation and run presentation. Candidate form/run-list components; current backend placeholder outputs require a separate correctness fix.                    |
| `apps/desktop/src/pages/ReviewPage.tsx`          |   512 | Review display and correction/approval interactions. Split sections without weakening blocking-field or permission feedback.                                                     |
| `apps/desktop/src/pages/AccountPage.tsx`         |   508 | Account, sessions and MFA concerns. Separate sections while retaining secret handling and confirmation paths.                                                                    |
| `apps/mobile/src/capture/edgeDetection.ts`       |   417 | One platform-neutral detection pipeline and geometry helpers. Size alone does not prove a defect; decomposition should preserve deterministic image tests and frame-loop cost.   |
| `apps/backend/src/services/review-service.ts`    |   408 | Review lifecycle and correction coordination. Separate reporting from command paths only with existing audit/approval transaction semantics preserved.                           |
| `apps/desktop/src/App.tsx`                       |   403 | Top-level routing and application state. Candidate extraction of navigation and session state; keep renderer/privileged-process boundary intact.                                 |

## Desktop and mobile API clients (ARC-AC-37)

Both clients import shared contract types, serialize JSON/form bodies, interpret API error envelopes,
attach credentials, and support session refresh. This repeated protocol behavior is a potential
shared client-neutral module, but neither client currently imports the other's implementation.
Desktop uses relative same-origin URLs and an Electron preload/keychain bridge with in-memory
fallback (`apps/desktop/src/api/client.ts`); mobile accepts a paired server endpoint, has a device
credential and platform token store, and supports device uploads (`apps/mobile/src/api/client.ts`).
Transport, persistence and endpoint coverage should stay behind platform adapters. Any extraction
must preserve their different authentication, endpoint validation, refresh and offline-queue
semantics; shared TypeScript types alone do not prove compatibility or justify a mechanical merge.
