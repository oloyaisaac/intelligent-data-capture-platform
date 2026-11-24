# R01 module-size and client-coupling notes — interim

Tracked TS/TSX/JS/JSX files below workspace `src/`, measured on source baseline `9ec567c`.
The following command lists every module above 400 lines, rather than using a truncating `head`:

```sh
git ls-files 'apps/*/src/*' 'packages/*/src/*' | grep -E '\.(ts|tsx|js|jsx)$' | xargs wc -l | sort -rn
```

The table contains all **19** scoped files over 400 lines (line counts include blank lines and
comments). Size alone is neither a defect nor a mandate to refactor. Assessments identify possible
seams and trade-offs for the responsible reviewers; no decomposition or approval is implied. The
older 7dc278c top-30 transcript remains historical in `commands.log`.

| Source file                                      | Lines | Architectural assessment / possible seam                                                                                                                                                            |
| ------------------------------------------------ | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/i18n.ts`                    |  2121 | Large catalogue data, not one control-flow routine. Separate locale catalogues and validate key parity if changed; coverage does not prove all UI text is translated.                               |
| `apps/backend/src/services/auth-service.ts`      |   994 | Authentication, sessions, invitations and MFA share a service; evaluate use-case seams with R05/R07 while preserving transaction and credential checks.                                             |
| `packages/shared/src/contracts.ts`               |   973 | Shared schemas and types across domains; domain modules could sit behind a stable public barrel with version-compatibility review.                                                                  |
| `apps/desktop/src/api/client.ts`                 |   973 | Endpoint wrappers and session refresh/token handling; R09 can evaluate separating transport/auth from endpoint groups without changing behavior.                                                    |
| `apps/backend/src/services/connector-service.ts` |   802 | Configuration, mapping and execution coordination plus failure boundaries; R15/R07 should preserve tenant and secret handling and address the separate isolation risk.                              |
| `apps/desktop/src/pages/SettingsPage.tsx`        |   695 | Multiple settings concerns; R09/R12 can evaluate sections and form primitives while retaining authorization feedback.                                                                               |
| `apps/backend/src/services/workflow-service.ts`  |   653 | Definition, evaluation, approval and transactional execution; R02/R04 can consider seams but must preserve revision fencing and fail-closed action behavior.                                        |
| `apps/backend/src/db/migrations.ts`              |   628 | Historical forward-only SQL naturally accumulates; R03 should assess any split while preserving immutable order, migration IDs and upgrades.                                                        |
| `apps/backend/src/repositories/auth-repo.ts`     |   555 | Multiple auth entities share a persistence file; evaluate entity-oriented seams without breaking transaction-scoped behavior.                                                                       |
| `apps/desktop/src/workflows/WorkflowsPage.tsx`   |   519 | Workflow editor, evaluation and runs; candidate form/run-list separation, while unsupported backend dispatch and historical outputs remain open.                                                    |
| `apps/desktop/src/pages/ReviewPage.tsx`          |   512 | Review, corrections and approvals; possible section separation must preserve blocking and permission feedback.                                                                                      |
| `apps/desktop/src/pages/AccountPage.tsx`         |   508 | Account, sessions and MFA; candidate sections must retain secret handling and confirmation paths.                                                                                                   |
| `apps/backend/src/repositories/document-repo.ts` |   471 | Documents, page and extraction persistence share a file; distinct classes offer possible seams but cross-row transaction/locking contracts must remain intact.                                      |
| `apps/backend/src/services/review-service.ts`    |   470 | Review lifecycle and correction coordination; separate reporting and command paths only with audit/approval transaction semantics preserved.                                                        |
| `apps/backend/src/services/document-service.ts`  |   468 | Upload, read, reprocess and deletion/purge; possible use-case seams require coordination with storage/database and recovery boundaries (ARC-018/024).                                               |
| `apps/backend/src/services/container.ts`         |   457 | Central composition naturally enumerates adapters and service dependencies; splitting by factory may help readability but must not add hidden locators or weaken transaction composition (ARC-015). |
| `apps/backend/src/services/worker.ts`            |   429 | Worker lifecycle, extraction and purge; evaluate separation with R02/R18 without weakening claim and guarded-publication semantics or implying exactly-once effects.                                |
| `apps/mobile/src/capture/edgeDetection.ts`       |   417 | A platform-neutral detection pipeline and geometry helpers; splitting must preserve deterministic image tests and frame-loop cost.                                                                  |
| `apps/desktop/src/App.tsx`                       |   403 | Top-level routing and application state; navigation/session extraction must retain renderer/privileged-process separation.                                                                          |

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
`client-boundary-comparison.md` extends this into a bounded behavior comparison. Desktop tracks a
`sessionId` for the session list and mobile does not; desktop error objects carry `details` and mobile
ones do not; only desktop implements the realtime event stream. Neither client coordinates concurrent
refreshes, which is recorded as ARC-053 with fake-fetch evidence, not as a proven packaged-app defect.
