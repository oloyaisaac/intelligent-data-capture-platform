# R01 assessment notes — superseded working draft

> **Superseded by `architecture-assessment.md`.** Kept for the audit trail: these answers were written
> before this session's probes, and two of the §7 rows below are now refuted by direct reading (R-18's
> eviction claim) or sharpened with measured evidence (R-25's residue, R-04's CI configuration). Read
> the newer file; use this one only to see what changed and why.

These answers are interim technical analysis, not independent reviewer sign-off, an owner exception,
or a G1/G8 gate result. They refer to the current branch; the other R01 evidence and runtime replay
remain incomplete.

## Questions in §8

1. **Where does a feature go?** `ARCHITECTURE.md` §6 gives the intended route → service →
   repository → database direction and client/shared boundaries. The module inventory in
   `layer-map.md` makes the current locations explicit. That helps a new engineer choose locations,
   but it is not a complete end-to-end tutorial: transaction composition, event durability,
   release compatibility and the broad `Services` object still require engineering judgement.
2. **Only one composition root?** No. `services/container.ts` assembles most service dependencies,
   but `index.ts` calls the database and HTTP factories, `db/index.ts` selects and constructs
   database adapters, and the offline migration CLIs compose their own transaction repositories.
   OCR provider construction has moved from `ai/pipeline.ts` to `services/container.ts`; the pipeline
   now receives only the provider port. The realtime route uses an optional port capability rather
   than casting to the in-memory hub. These improvements do not by themselves establish P5.
3. **Ten API replicas?** There is no validated order of failure under load; likely first-visible
   divergences depend on traffic routing. With process-local storage, a replica may not find a file
   uploaded elsewhere. Even on shared filesystem storage, SSE reaches only the emitting process's
   subscribers and login/pairing attempt limits are per process. Enabling multiple workers adds
   unfenced side effects and unsupported concurrent execution; independent maintenance loops add duplicate
   scheduling risk. Database pool counts and aggregate memory also multiply. The specific two-API
   demonstration and its limits are in `state-inventory.md`. A shared database and storage alone
   do not make ten replicas supported.
4. **Largest architectural risk?** For scaling the capture loop, DEC-029's single-process runtime
   and its recovery/effects model is the most immediate architectural risk in this review: normal
   claims are atomic and extraction publication is attempt-guarded. Age-only startup recovery has
   been removed, but manual recovery depends on operator controls and external effects remain
   unfenced. Reversal
   requires coordinated ownership/leases, fencing and idempotent effects, shared realtime and rate
   limiting, shared storage, coordinated maintenance and failure-injection/operational tests. This
   is a qualitative assessment, not an estimate of effort or an owner-approved migration plan.
5. **Third-party connectors?** No: the standard registry now invokes first-party operations in a
   subprocess with bounded IPC, a timeout and an empty inherited environment. Explicitly injected
   registries can execute in-process; even the standard child has the API's OS identity and can
   signal the host, as `connector-process-security.test.ts` demonstrates. This is not a sandbox or
   complete resource isolation; P8 remains unmet. See `docs/connector-process.md`.
6. **Shared package and independent release?** The three apps and connectors declare
   `@idcp/shared: "*"`, and `packages/shared/package.json` points `main` and `types` at source.
   Monorepo installs and builds therefore share the checked-out contract. Independent deployment is
   possible only if the deployed builds retain compatible API/UDM contracts; no published immutable
   package version, compatibility policy or independent-release proof is established here. Shared
   source creates build-time coupling but does not by itself prove simultaneous deployment is always
   required.

## Known risks in §7: confirmation and qualification

| Risk | Assessment                                                                                                                                                                                                                                                                                                                                 | Evidence and outstanding work                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-04 | Original claim that PostgreSQL is never executed is no longer true. PostgreSQL migrations and the complete backend suite run in CI, but a green test is not proof of production operation or complete migration portability.                                                                                                               | `.github/workflows/ci.yml` PostgreSQL job; R03 owns schema and migration review. CI on `2fbdd00` failed that job without detailed annotations; the following `e332676` run passed, but the earlier failure remains unexplained. |
| R-16 | Confirmed: no connector sandbox; see answer 5 and ARC-014.                                                                                                                                                                                                                                                                                 | `services/connector-service.ts`, `packages/connectors/src/contract.ts`.                                                                                                                                                         |
| R-24 | Confirmed dependency on experimental Node SQLite API; Node emits the experimental warning during local tests.                                                                                                                                                                                                                              | `apps/backend/src/db/sqlite.ts:1`; operational support across Node upgrades remains an owner decision.                                                                                                                          |
| R-25 | Partially remediated, not categorically absent: new encryption uses a separate `ENCRYPTION_KEY`, which production configuration requires to differ from `JWT_SECRET`; the container still passes the JWT secret as a legacy decryption fallback. Removing/changing that fallback before migrating legacy records can make them unreadable. | `services/crypto.ts:33`, `services/container.ts:124`, `config.ts:195`, `db/encryption-migration-cli.ts`; see the offline migration runbook and security review.                                                                 |
| R-18 | The no-eviction claim is outdated: expired entries are swept on requests and the map has a default cap. The limiter remains process-local; at capacity it fails closed for new keys, an availability trade-off, and restarts reset counts.                                                                                                 | `auth/tokens.ts:99-157`; `replica-process.test.ts`.                                                                                                                                                                             |
| R-21 | Historical architecture drift was corrected in several places; the full cross-document sweep is not complete.                                                                                                                                                                                                                              | `doc-drift.md`; `AGENT_STATE.md` and `DEPLOYMENT.md` still require full inspection.                                                                                                                                             |
