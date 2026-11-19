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

| Reviewer                 | Status                                         | Progress and remaining work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 — Software Architect | **IN PROGRESS; G1 not approved**               | Corrected architecture drift and misleading source comments, bounded process-local limiter state, and added regression coverage. P1's SQL relocation is implemented: literal SQL scans and a regression test find no statements outside `db/` and `repositories/`; the test does not prove the absence of dynamically assembled SQL. P2 is addressed by centralized configuration for the API and offline CLIs. P5 is partially addressed: backend service repositories and transaction-scoped repositories are injected at the composition root; the offline migration CLI separately composes its repository. A static regression guards direct repository construction outside the service container, but the wider adapter boundary still needs review. P6 is unmet: startup recovery can reclaim another worker's active job; a lease/heartbeat, safe multi-worker behavior and the required two-process test are still needed. Privacy erasure checks ownership before its transaction, leaving a concurrent membership-change race to address. The full checklist, dependency-cycle and runtime exercises, evidence artefacts, and other passing conditions have not been completed or independently verified. |
| R02–R22                  | **NOT STARTED under this completion protocol** | The original briefs contain extensive checklist, source, evidence and runtime work. Do not infer completion from older reports or prior merged fixes. R22 additionally requires real operators, documents, deployment and pilot evidence; legal, signing, native-tooling and vendor access require their respective external owners.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

No reviewer completion file has been created. The protocol requires every assigned item and test to
be completed before one can be written. Existing programme gates remain unapproved until their
required evidence and sign-offs are complete. The R01 Madge scan using `tsconfig.base.json`
reported no cycles in 217 processed files and no skipped-file warnings; it supersedes the earlier
scan that skipped `@idcp/shared/ids`. The declared internal dependency edges are acyclic; interim
evidence is recorded in `docs/reviewers/evidence/R01/dependency-graph.md`. These results do not prove
that dynamic imports, external packages or undeclared cross-workspace dependencies have been fully
assessed.
The job claim update now rechecks queued/runnable state after acquiring the target row's write lock,
so a waiting claimant cannot claim the same already-updated row. Recovery now counts rows actually
requeued, but it still models a stale active job being reclaimed. A two-subprocess SQLite test
claims 20 synthetic jobs, not 20 documents processed by two backend instances; it does not exercise
worker side effects, recovery or audits. The PostgreSQL lock-contention regression passed in
[PR #26 CI](https://github.com/oloyaisaac/intelligent-data-capture-platform/actions/runs/44514864382/job/135528120126);
PostgreSQL and Docker are unavailable locally. This branch's commit `38cd0a3` passed the complete backend suite against PostgreSQL and the
Compose smoke test in [PR #28 CI](https://github.com/oloyaisaac/intelligent-data-capture-platform/actions/runs/44537667203),
but its Verify job failed during Jest tests. Full job logs were unavailable from this sandbox, and
local reproduction passed and the subsequent [commit `02b1383` CI](https://github.com/oloyaisaac/intelligent-data-capture-platform/actions/runs/44539157606) passed all checks. The earlier failure remains undiagnosed; the CI test step now reports
failed Jest cases as GitHub annotations without changing its exit code.
This does not establish multi-worker safety; P6 remains unmet.

Pairing completion now locks the session before checking status and expiry, and creates the device,
claims the token and records the audit in one transaction; the event is published after commit.
An audit-failure test reproduced partial committed state before the fix. SQLite tests cover rollback,
concurrent requests and event ordering, but single-connection concurrency does not prove
cross-process behavior. The PostgreSQL integration job on commit `5d68307` passed the complete
backend suite, including the enabled blocked-row expiry regression; the suite also passed on commit
`780b5ff`. The first job step status was verified through the GitHub API; individual test log retrieval
was unavailable in this sandbox. Pairing's
in-process event is not durable and a response lost after commit still requires a fresh session.

A focused two-subprocess API exercise (`replica-process.test.ts`) with workers and maintenance
explicitly disabled observed a shared login/token and cross-replica document read, but separate SSE
streams and login-limit counters. See the interim process-state inventory in
`docs/reviewers/evidence/R01/process-state.md`. This is not the two-worker exercise or proof of a
safe multi-replica deployment; several memory bounds and other state remain unassessed.

A registered test connector's rejected create, read and update operations produce a recorded failed
run and actionable HTTP response while the API remains responsive (`apps/backend/test/connector-throw.test.ts`).
The send path replaces connector-thrown details with a safe message in new run records, logs and
responses, while retaining its own duplicate-policy conflict. Validation, health-check, schema and
duplicate-preview failures now use safe messages; connector-supplied text and context passed through
the provided logger are discarded. Secret-bearing regressions failed before these corrections and
pass afterward. This sacrifices detailed connector diagnostics and does not sanitize old records,
successful connector outputs or logs written outside the provided logger. It covers ordinary T-05
errors, not P8: in-process code can still terminate or compromise the host. An incomplete R01 findings
register, with no assigned named owners or exceptions, is in `docs/reviewers/evidence/R01/findings.md`.

### Additional open security and runtime gaps

- Existing-account invitations now require the current password and, when enabled, a TOTP or
  recovery code. Recovery-code consumption and invitation acceptance commit together; concurrent
  reuse is regression-tested. Admins receive invitation tokens, so enumeration resistance still
  requires redesign and verification. Ordinary MFA login's recovery-code update is not atomic with
  subsequent audit/session issuance; failures after consumption may require another recovery code.
- Credential checks use the credential's organisation and live membership. SSE authorization is
  checked only at connection time: already-open streams are not closed on removal or token expiry.
  Ordinary login and MFA completion still select the earliest accepted membership; there is no
  explicit organisation-selection flow.
- SQLite's adapter now queues ordinary operations alongside transactions on the same connection;
  regression tests cover blocked readers/writers, rollback isolation, nested scoped calls and stale
  handles. This is not proof of cross-process safety or every concurrency behavior. Nested scoped
  transactions share the outer transaction and do not create savepoints.
- Privacy erasure checks ownership outside the write transaction, so concurrent membership changes
  can invalidate its eligibility decision. PostgreSQL concurrency for current changes remains
  untested locally because Docker and PostgreSQL are unavailable in the sandbox.

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

On the current R01 worktree, `npm run format:check`, the backend build and `npm run verify` passed:
48 Jest suites and 582 tests passed, with one suite and three PostgreSQL tests skipped, plus four backup-tool
tests, typecheck, lint and contract checks. Focused coverage includes pairing rollback and concurrent
requests, marketplace and composition boundaries, membership-scoped credentials,
MFA invitation acceptance, recovery-code concurrency and rollback, SQLite transaction isolation,
synthetic SQLite job claims from two processes, composition test doubles, dashboard isolation and
privacy erasure rollback. Local transaction-scoping and lock-ordering checks use PostgreSQL test
doubles; they are not PostgreSQL integration tests. PostgreSQL claim and pairing contention tests
were skipped locally but the complete backend suite passed on commit `38cd0a3` in PR #28 CI,
including the auth, document, privacy, maintenance and migration composition changes. The separate
Verify job failed during Jest tests on that commit; all checks subsequently passed on `02b1383`,
without identifying the earlier failure. A new PostgreSQL JSON-question-mark regression is awaiting
CI. On the earlier
worktree, the built offline encryption-migration CLI passed check, apply and a second check against an
empty, newly migrated synthetic SQLite database; encrypted-record migration and rollback are covered
by Jest integration tests. `npm ci` skipped the Electron binary download. The test run emitted
existing React `act` and jsdom navigation warnings. This is not evidence of a packaged desktop launch,
a deployed PostgreSQL installation, an APK, an iOS build, or completion of reviewer-specific runtime
tests. PostgreSQL, Compose and browser CI passed for commit `38cd0a3`, but Verify failed in its
Jest step in [PR #28](https://github.com/oloyaisaac/intelligent-data-capture-platform/actions/runs/44537667203).
Subsequent commit `02b1383` passed all checks; the new PostgreSQL JSON regression has not yet run in CI.
