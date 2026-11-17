# UNRESOLVED ISSUES

**Repository:** `oloyaisaac/intelligent-data-capture-platform`
**Branch:** `arena/1ec2f10d-intelligent-data-capture-platf`
**Audit Date:** 2026-11-16

---

## 1. CRITICAL ISSUES (8)

**Status:** Production Approval BLOCKED.

| ID    | Finding                                                 | Status      | Evidence / Blocking Reason                                                                                                                                                                                                                                                                                                   |
| ----- | ------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MC-01 | Packaged desktop app cannot reach its backend           | IN PROGRESS | Code fixed in `VERIFICATION-LOG.md` (app-protocol, electron-main, preload, App.tsx, client.ts, realtime.ts, index.html, vite.config.ts, package.json, configure-desktop-api.mjs, validate-packaging.mjs, .env.example, DEPLOYMENT.md, tests). **Runtime verification blocked** (Electron binary download failed in sandbox). |
| MC-02 | CSP blocks any production API origin                    | IN PROGRESS | Coupled with MC-01. Code fixed. **Runtime verification blocked.**                                                                                                                                                                                                                                                            |
| MC-03 | No deployment artefact exists                           | IN PROGRESS | `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml`, `.dockerignore`, `.env.compose.example`, `.gitignore`, `DEPLOYMENT.md`, `TASKS.md`, `REMEDIATION/REMEDIATION-PLAN.md` updated. **Runtime verification blocked** (Docker/Compose not in sandbox; CI job pending).                                             |
| MC-04 | PostgreSQL never executed                               | IN PROGRESS | CI job added to `.github/workflows/ci.yml`. `apps/backend/test/helpers.ts`, `apps/backend/test/postgres.test.ts`, `scripts/test-postgres.mjs`, `package.json` updated. **Runtime verification blocked** (Sandbox lacks `docker`/`postgres`).                                                                                 |
| MC-05 | No mobile application can be built                      | TODO        | `apps/mobile/` lacks `android/` and `ios/`. `package.json` declares unbuildable commands.                                                                                                                                                                                                                                    |
| MC-06 | Batch upload buffers ~2 GB before enforcing its own cap | DONE        | Fixed in `apps/backend/src/http/routes/batch-upload.ts`, `apps/backend/src/services/batch-service.ts`, `apps/backend/test/batches.test.ts`. **Verified** in `VERIFICATION-LOG.md` (9 tests pass, revert check fails with 413 vs 201).                                                                                        |
| MC-07 | No end-to-end test exists                               | TODO        | Root cause of MC-01 and MC-05. No Playwright/Detox/Maestro in `package.json`.                                                                                                                                                                                                                                                |
| MC-08 | Value proposition never measured                        | BLOCKED     | Requires 5 operators × 20 real documents and a labelled corpus (External).                                                                                                                                                                                                                                                   |

---

## 2. HIGH ISSUES (39)

**Status:** Production Approval BLOCKED.

| ID    | Finding                                                | Status   | Evidence / Blocking Reason                                                                                                                                |
| ----- | ------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MH-01 | Only Windows targets configured                        | TODO     | `electron-builder.json` configuration.                                                                                                                    |
| MH-02 | Update feed points at `updates.example.invalid`        | TODO     | `electron-builder.json`.                                                                                                                                  |
| MH-03 | No code signing or notarisation                        | BLOCKED  | Needs signing certificates (CA).                                                                                                                          |
| MH-04 | `openExternal` passes unvalidated URL                  | DONE     | Fixed in `electron-main.ts` (policy level). **Runtime verification pending** (MC-01/MC-02).                                                               |
| MH-05 | No `will-navigate` guard                               | DONE     | Fixed in `electron-main.ts` (policy level). **Runtime verification pending** (MC-01/MC-02).                                                               |
| MH-06 | No rollback procedure                                  | TODO     | `DEPLOYMENT.md` / `REMEDIATION-PLAN.md`.                                                                                                                  |
| MH-07 | No operational runbooks                                | TODO     | `REMEDIATION-PLAN.md`.                                                                                                                                    |
| MH-08 | 8 production advisories (1 crit, 5 high)               | TODO     | `npm audit --omit=dev` (1 critical `shell-quote`, 5 high `zod` 3.24, `image-size`, `query-string`, `decode-uri-component`, 2 moderate `exceljs`, `uuid`). |
| MH-09 | One `JWT_SECRET` serves three purposes                 | TODO     | `container.ts:84`, `crypto.ts:19`.                                                                                                                        |
| MH-10 | Password reset undeliverable                           | BLOCKED  | No SMTP/provider in `package.json` or `apps/backend/src`.                                                                                                 |
| MH-11 | MFA cannot be required by organisation                 | TODO     | `AUTH-001` / `COMP-*`.                                                                                                                                    |
| MH-12 | `AttemptLimiter` per-process                           | TODO     | `tokens.ts:105`.                                                                                                                                          |
| MH-13 | Blob written before transaction; orphans               | TODO     | `document-service.ts:116-118`.                                                                                                                            |
| MH-14 | DSAR export omits document images and field values     | TODO     | `privacy-service.ts:121`.                                                                                                                                 |
| MH-15 | Erasure reports success while blobs may remain         | TODO     | `privacy-service.ts:220`.                                                                                                                                 |
| MH-16 | Synchronous `node:sqlite` blocks the event loop        | DEFERRED | `sqlite.ts`.                                                                                                                                              |
| MH-17 | 13 legal placeholders                                  | BLOCKED  | `legal/*` files (`[COMPANY NAME]`, etc.). Needs owner details.                                                                                            |
| MH-18 | Legal validator requires placeholders                  | TODO     | `validate-legal.mjs`.                                                                                                                                     |
| MH-19 | Licence undecided                                      | BLOCKED  | `LICENSE` (`Q-002` open). Needs owner decision.                                                                                                           |
| MH-20 | No penetration test                                    | BLOCKED  | Needs vendor.                                                                                                                                             |
| MH-21 | 6 of 8 connectors never contacted a real server        | BLOCKED  | Needs live vendor credentials.                                                                                                                            |
| MH-22 | Google Sheets token dies after ~1 h                    | TODO     | `google-sheets-connector.ts`.                                                                                                                             |
| MH-23 | Extraction accuracy never measured                     | BLOCKED  | Needs labelled corpus.                                                                                                                                    |
| MH-24 | Confidence values are uncalibrated                     | BLOCKED  | Needs labelled corpus.                                                                                                                                    |
| MH-25 | No `/metrics`                                          | TODO     | P-2 prerequisite.                                                                                                                                         |
| MH-26 | No alerting                                            | TODO     | P-2 prerequisite.                                                                                                                                         |
| MH-27 | Six failure paths log `warn` and continue              | TODO     | P-2 prerequisite.                                                                                                                                         |
| MH-28 | No backup/restore tooling                              | TODO     | MC-03 prerequisite.                                                                                                                                       |
| MH-29 | Branch coverage 58.75 %, no threshold                  | TODO     | `jest.config.cjs`.                                                                                                                                        |
| MH-30 | Mutation score unknown                                 | TODO     | No Stryker/mutation tool.                                                                                                                                 |
| MH-31 | 11 PRD verification blocks unverified                  | TODO     | `PRD.json`.                                                                                                                                               |
| MH-32 | Contract test cannot detect response-shape drift       | TODO     | `validate-openapi.mjs`.                                                                                                                                   |
| MH-33 | No live region; async updates silent to screen readers | TODO     | A11Y-001.                                                                                                                                                 |
| MH-34 | No automated accessibility testing                     | TODO     | A11Y-002.                                                                                                                                                 |
| MH-35 | Edge detection non-functional                          | BLOCKED  | No device/worklets.                                                                                                                                       |
| MH-36 | Onboarding presumes unbuildable mobile pairing         | TODO     | MC-05 prerequisite.                                                                                                                                       |
| MH-37 | No billing                                             | BLOCKED  | Needs decision.                                                                                                                                           |
| MH-38 | `AttemptLimiter` map unbounded                         | TODO     | BE-003.                                                                                                                                                   |
| MH-39 | Marketplace signing key has public default             | TODO     | CONX-003.                                                                                                                                                 |

---

## 3. MEDIUM ISSUES (40) & LOW ISSUES (10)

**Status:** Production Approval BLOCKED (Documentation drift, SSRF, Accessibility, etc.).

- **MM-01..MM-40**: Architecture drift (`ARCHITECTURE.md`), Connector sandbox, `TASKS.md`, Advisory counts, Validators, Deployment mechanism, SSRF protocol-only, Modal focus, `prefers-reduced-motion`, Image alt text, Linear role model, API-key scope, Structural tenancy, PII audit, DSAR intake, Retention purge, Index adequacy, Device rotation, MFA policy, Voice assist, Mobile permissions, Offline queue, Quality regression, OCR provider, Document readiness, Connector drift, Dashboard target, Load testing, Export buffering, Extraction baseline, Sweep failure, Health readiness, Process supervision, Environment separation, DPPA registration, Packaging test, Product instrumentation, Support undeliverable, Market segment, Error-path coverage, Performance tests. (All TODO or DEFERRED/BLOCKED).
- **ML-01..ML-10**: Architecture drift (`prisma/`), Single-process blockers, Rewriter test, Operation delta, Error envelope, Password change, Mutation isolation, Field hint, Secret scan, Settings page. (All TODO or DEFERRED).

---

## Conclusion

**A project must not receive production approval while unresolved critical issues remain.**
**Total Unresolved Critical:** 7 (MC-01, MC-02, MC-03, MC-04, MC-05, MC-07, MC-08) [MC-06 is DONE].
**Verdict:** **NOT APPROVED.**
