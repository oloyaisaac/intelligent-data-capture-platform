# Current Work Queue — Systematic Remediation

- **Last updated:** 2026-11-17
- **Detailed register:** [`REMEDIATION/REMEDIATION-PLAN.md`](REMEDIATION/REMEDIATION-PLAN.md)
- **Verification evidence:** [`REMEDIATION/VERIFICATION-LOG.md`](REMEDIATION/VERIFICATION-LOG.md)

`REQUIREMENTS.md` and `PRD.json` remain the product requirements and story-status sources of truth.
This remediation queue does not delete or weaken existing product functionality. The PRD's 45 stories
remain `done`; its 11 existing, unverified verification blocks remain explicitly unverified.

## Reviewer completion protocol — current progress

The original briefs in `docs/reviewers/` and historical reports in `REVIEWS/` are preserved.
The historical review reports are not reviewer-completion declarations for the current codebase.

| Reviewer                 | Status                                         | Progress and remaining work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 — Software Architect | **IN PROGRESS; G1 not approved**               | Corrected architecture drift and misleading source comments, bounded process-local limiter state, and added regression coverage. P1 is unmet: SQL remains in services and a route. P2 is unmet: `http/app.ts` reads the environment. P5 is unmet: services construct repositories. P6 is unmet: startup recovery can reclaim another worker's active job; a lease/heartbeat, safe multi-worker behavior and the required two-process test are still needed. The full checklist, dependency-cycle and runtime exercises, evidence artefacts, and other passing conditions have not been completed or independently verified. |
| R02–R22                  | **NOT STARTED under this completion protocol** | The original briefs contain extensive checklist, source, evidence and runtime work. Do not infer completion from older reports or prior merged fixes. R22 additionally requires real operators, documents, deployment and pilot evidence; legal, signing, native-tooling and vendor access require their respective external owners.                                                                                                                                                                                                                                                                                        |

No reviewer completion file has been created. The protocol requires every assigned item and test to
be completed before one can be written. Existing programme gates remain unapproved until their
required evidence and sign-offs are complete. The R01 cycle scan reported no cycles in 202 processed
files but skipped `@idcp/shared/ids`; this is not proof that the complete import graph is cycle-free.
The worker regression models a stale active job being reclaimed; it is not the required two-process
20-document runtime exercise.

## Active — CRITICAL first

| ID            | Task                                                                                                                      | Status          | Evidence / blocker                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MC-01 + MC-02 | Make packaged Electron use a real `app://idcp` origin, the baked `API_BASE_URL`, and an API-specific CSP response header. | **IN PROGRESS** | Unit, build, static-contract and full-suite checks pass. A real Electron package launch is not verified: the sandbox's Electron binary fetch fails (`TypeError: fetch failed`). See verification log.                                        |
| MC-04         | Execute migrations and the full backend integration suite against PostgreSQL in CI.                                       | **DONE (CI)**   | PostgreSQL integration passed in [PR #24 CI](https://github.com/oloyaisaac/intelligent-data-capture-platform/actions/runs/44099153357/job/134094158416). This does not establish a production deployment or every database review condition. |
| MC-06         | Enforce batch count and total bytes while streaming multipart parts; spool files privately and process one at a time.     | **DONE**        | 9 batch tests pass; revert check fails on old handler (Expected 413, got 201). See verification log.                                                                                                                                         |
| MC-03         | Produce a deployable backend artefact and exercise its build in CI.                                                       | **DONE (CI)**   | Backend container build and Compose smoke test passed in [PR #24 CI](https://github.com/oloyaisaac/intelligent-data-capture-platform/actions/runs/44099153357/job/134094158411); publishing, deployment and operations remain open.          |
| MC-05         | Add buildable Android and iOS project scaffolds and verify an APK in CI.                                                  | TODO            | No local Java/Android SDK; CI/device build required.                                                                                                                                                                                         |
| MC-07         | Add a packaged desktop sign-in end-to-end test.                                                                           | TODO            | Depends on the real Electron packaged-runtime harness (P-3).                                                                                                                                                                                 |
| MC-08         | Measure the value proposition on real operator workflows and documents.                                                   | BLOCKED         | Requires pilot operators and a labelled corpus; not something code changes can honestly simulate.                                                                                                                                            |

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

On the R01 worktree, `npm run format:check`, the backend build and `npm run verify` passed: 38 Jest
suites and 518 tests passed, with one suite and one test skipped, plus four backup-tool tests,
typecheck, lint and contract checks. `npm ci` skipped the Electron binary download. This is not
evidence of a packaged desktop launch, a deployed PostgreSQL installation, an APK, an iOS build,
or completion of the reviewer-specific runtime tests. PostgreSQL and Compose CI passed on PR #24,
not on this unpushed worktree.
