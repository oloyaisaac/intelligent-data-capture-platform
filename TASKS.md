# Current Work Queue — Systematic Remediation

- **Last updated:** 2026-11-15
- **Detailed register:** [`REMEDIATION/REMEDIATION-PLAN.md`](REMEDIATION/REMEDIATION-PLAN.md)
- **Verification evidence:** [`REMEDIATION/VERIFICATION-LOG.md`](REMEDIATION/VERIFICATION-LOG.md)

`REQUIREMENTS.md` and `PRD.json` remain the product requirements and story-status sources of truth.
This remediation queue does not delete or weaken existing product functionality. The PRD's 45 stories
remain `done`; its 11 existing, unverified verification blocks remain explicitly unverified.

## Active — CRITICAL first

| ID            | Task                                                                                                                      | Status          | Evidence / blocker                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MC-01 + MC-02 | Make packaged Electron use a real `app://idcp` origin, the baked `API_BASE_URL`, and an API-specific CSP response header. | **IN PROGRESS** | Unit, build, static-contract and full-suite checks pass. A real Electron package launch is not verified: the sandbox's Electron binary fetch fails (`TypeError: fetch failed`). See verification log. |
| MC-04         | Execute migrations and the full backend integration suite against PostgreSQL in CI.                                       | **IN PROGRESS** | Added a `postgres:16` job, isolated schema-per-harness test adapter, smoke test, and `npm run test:postgres`; local execution is impossible without PostgreSQL/Docker, so CI results remain pending.  |
| MC-06         | Enforce batch count and total bytes while streaming multipart parts; spool files privately and process one at a time.     | **DONE**        | 9 batch tests pass; revert check fails on old handler (Expected 413, got 201). See verification log.                                                                                                  |
| MC-03         | Produce a deployable backend artefact and exercise its build in CI.                                                       | **IN PROGRESS** | Multi-stage Dockerfile, PostgreSQL Compose stack, migration service and CI build/health smoke job added. No local Docker; GitHub Actions execution is pending.                                        |
| MC-05         | Add buildable Android and iOS project scaffolds and verify an APK in CI.                                                  | TODO            | No local Java/Android SDK; CI/device build required.                                                                                                                                                  |
| MC-07         | Add a packaged desktop sign-in end-to-end test.                                                                           | TODO            | Depends on the real Electron packaged-runtime harness (P-3).                                                                                                                                          |
| MC-08         | Measure the value proposition on real operator workflows and documents.                                                   | BLOCKED         | Requires pilot operators and a labelled corpus; not something code changes can honestly simulate.                                                                                                     |

The CRITICAL queue must be fixed or explicitly blocked before starting independent HIGH remediation.
The narrow MH-04/MH-05 navigation guards were included with the MC-01/02 Electron-shell change because
the new privileged renderer origin must not retain an unrestricted navigation path.

## Verified alongside the current change

| ID    | Result                                                                                                                                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MC-06 | Batch count and total bytes are enforced while streaming; excess part is not read; private temp files are cleaned. Revert check fails on the old handler. |
| MH-04 | External opening accepts only HTTPS or safe `mailto:` URLs; other schemes are rejected. Unit callback tests pass.                                         |
| MH-05 | Navigation is restricted to the exact `app://idcp` (or configured development) origin. Unit callback tests pass.                                          |
| P-0   | Remediation register exists, records dependencies/status, and tracks all 97 actionable IDs plus 10 informational observations.                            |

## Next severity waves

- **HIGH:** See the complete `MH-01..39` task register. `MH-04/05` are verified above; begin other independent HIGH work after the CRITICAL queue is resolved or blocked. Owner-/vendor-/credential-dependent items remain explicitly blocked.
- **MEDIUM:** `MM-01..40`; the cross-tenant sweep prerequisite is P-1. Corpus-, device-, and vendor-dependent items remain explicitly blocked.
- **LOW:** `ML-01..10` after MEDIUM, except tasks already covered by a required security correction.
- **INFORMATIONAL:** `MI-01..10` are evidence-positive observations retained without corrective changes.

## Current verification baseline

`npm run format:check` — PASS. `npm run verify` — PASS: 31 suites passed, 1 conditional PostgreSQL suite skipped; 432 tests passed and 1 skipped (433 total), plus typecheck, lint, PRD, OpenAPI, packaging-contract, and legal-pack checks. This is code/test evidence only; it is not evidence of an installer launch, a PostgreSQL deployment, a Docker image, an APK, or an iOS build.
