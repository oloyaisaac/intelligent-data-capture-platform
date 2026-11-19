# R01 documentation drift — interim register

**Incomplete:** this is a working list, not the full cross-document review or G1 approval. Historical
review evidence is preserved; line numbers refer to the current worktree and may move.

| Document / historical claim                                                                                                    | Code reality and evidence                                                                                                                                              | Current correction / residual issue                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Earlier `ARCHITECTURE.md` said no application code was implemented (historical ARC-001).                                       | Source exists in all five workspaces; `apps/backend/src/index.ts` starts the API and worker.                                                                           | `ARCHITECTURE.md` now describes the implemented components and remaining runtime gaps, particularly §2 and §8. Full replay remains outstanding. |
| Earlier `ARCHITECTURE.md` included `prisma/` (historical ARC-002).                                                             | No Prisma schema or directory; handwritten migrations in `apps/backend/src/db/migrations.ts`, drivers in `db/sqlite.ts` and `db/postgres.ts`.                          | Current `ARCHITECTURE.md` §2 and §6 list the real layout.                                                                                       |
| Earlier `ARCHITECTURE.md` described a connector sandbox (historical ARC-003).                                                  | Connectors are registered and executed in the backend process (`services/connector-service.ts`, `packages/connectors/src/contract.ts`).                                | Current `ARCHITECTURE.md` §2 explicitly says no sandbox; actual process isolation remains unimplemented (ARC-014).                              |
| `DECISIONS.md` DEC-003 historical consequences cite Prisma and future SQLite; the rationale cites JSONB.                       | The two drivers share handwritten migrations, SQLite is the local default, UDM JSON is text, and PostgreSQL is exercised in CI.                                        | Implementation note added under DEC-003; no production deployment or JSONB performance is claimed.                                              |
| `DECISIONS.md` DEC-008 historical consequences specify a Redis-backed queue.                                                   | Jobs are stored in the database (`repositories/system-repo.ts`), with a worker in the API process (`services/worker.ts`). Recovery can reclaim active work.            | Implementation note added under DEC-008; P6 remains unmet.                                                                                      |
| `DECISIONS.md` DEC-010 proposes S3 lifecycle and encryption.                                                                   | `storage/index.ts` implements filesystem and in-memory storage; `config.ts` rejects S3. File erasure and backup have operational limitations.                          | Implementation note added under DEC-010; no S3 implementation, lifecycle guarantee or complete erasure is asserted.                             |
| `DECISIONS.md` DEC-013 says no `RETURNING`, only repositories know the driver, and PostgreSQL is exercised only in production. | `device-repo.ts` and `system-repo.ts` use `RETURNING`; `db/database.ts` exposes `driver`; PostgreSQL CI runs the backend suite.                                        | Implementation note added under DEC-013; actual driver-specific locking and CI limits are stated.                                               |
| `DECISIONS.md` DEC-019 and DEC-030 say there is no email transport.                                                            | `services/mailer.ts` includes SMTP, configurable via `config.ts`; delivery is optional and production mail requires operator configuration.                            | Notes added under both decisions; actual production delivery has not been verified.                                                             |
| `DECISIONS.md` DEC-031 claims all steps are bounded and repeatable across replicas.                                            | `services/maintenance-service.ts` checks for pending purge before enqueue without cross-process coordination; `repositories/maintenance-repo.ts` has unbounded sweeps. | Implementation note added; multiple schedulers are not supported or proven safe.                                                                |

| `DECISIONS.md` DEC-026 describes connector-send and export workflow effects, and says no mail transport exists. | `apps/backend/src/services/workflow-service.ts:295-302` records placeholder text for all three rather than dispatching; SMTP exists separately in `services/mailer.ts`. | DEC-026 and `ARCHITECTURE.md` now identify the placeholder actions; misleading completed runs remain open as ARC-019 for R02. |
| `DECISIONS.md` DEC-028 and historical `AGENT_STATE.md` claim all UI text uses the catalogue / localization is complete. | English UI literals appear at `apps/mobile/src/screens/PairingScreen.tsx:75,97` and `apps/desktop/src/pages/ExportsPage.tsx:75`. | DEC-028 now qualifies the claim; localization and native/RTL validation remain open. |
| Historical `AGENT_STATE.md` says batch upload buffers all files, SMTP and a Dockerfile do not exist, and there is no backup tool. | Streaming batch upload is in `apps/backend/src/http/routes/batch-upload.ts`; `services/mailer.ts`, `Dockerfile` and `scripts/sqlite-backup.mjs` exist. | Historical handover has a dated warning linking to current evidence; it is not a current operating guide. Backup, deployment and SMTP still have documented limitations. |

Other documentation, including the remainder of `AGENT_STATE.md` and `DEPLOYMENT.md`, still needs a complete
claim-by-claim sweep. The historical text in each decision remains for traceability; the added notes
explain the current implementation without silently changing the original decision status.

## Deployment claim sweep (partial, 2026-11-17)

- The Compose smoke passed in CI on `fcc6206`; earlier text still said it was pending. The target
  diagram is aspirational and the hosted deployment remains unverified.
- The earlier SIGTERM/restart guidance claimed interrupted jobs were safely requeued. Startup
  recovery is age-based and only runs at boot, without ownership fencing; shutdown now waits for
  active work but has no deadline. See ARC-013 and ARC-021.
- Cost guidance and `cloud.ts` called `AI_MAX_COST_MICROS_PER_DOC` a hard cap; the implementation
  only warns after a rough estimate. Corrected guidance and added regression evidence; actual
  spending enforcement remains open (ARC-022).
- The previous guide implied comprehensive log redaction, a down-migration, no MFA or browser
  tests, and fully implemented signed auto-update. Corrected these claims and noted their limits.
- Compose examples require three distinct secrets and do not automatically forward every env key;
  the table previously mentioned Google keys absent from the backend config. The table is now
  explicitly selective. Desktop embeds `API_BASE_URL`; this has not been established for mobile.

This sweep is not a complete documentation sign-off, validation of production operations, or a
substitute for R19/R20 review.
