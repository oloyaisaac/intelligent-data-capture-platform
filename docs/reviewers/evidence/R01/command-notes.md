# R01 command transcript notes — incomplete

`commands.log` contains captured command output and exit statuses from the clean-install, static
sweep, Madge, focused integration tests and full local verification on worktree `7dc278c`, plus an
isolated SQLite migration smoke test. The sandbox clock printed in that raw output differs from the
session's stated date; it is recorded as the runner's clock, not used as a reviewer sign-off date.

- In the SQL and cross-workspace greps, exit 1 means no matching line, not a command crash. These
  literal text searches are narrower than a complete TypeScript import or dynamically generated SQL
  analysis.
- The service HTTP grep's `request.format` etc. are fields of `CreateExportRequest`, a shared
  application contract (`export-service.ts`), not Fastify request/reply objects. The pairing hit is
  a comment. A grep alone does not prove there are no other HTTP dependencies.
- The module-size command printed its requested first 30 rows but exited 141: under `pipefail`,
  `head` can close its pipe early and interrupt `sort`. `module-census.md` records a separate
  source-only census and decomposition notes.
- The citation check uses tracked Markdown rather than recursively searching installed dependencies;
  no cited `DEC-###` was missing from `DECISIONS.md` in that scope.
- A focused Odoo stub regression first failed on the prior instance-lifetime UID cache when a remote
  user ID changed. After removing the cross-operation cache, the focused connector suite verifies
  fresh authentication, credential changes, batch reuse and empty batches. This does not exercise a
  real Odoo server or establish atomic remote writes.
- The two-subprocess SQLite live-claim regression failed on the prior age-based startup recovery:
  the second process entered OCR while the first was paused. After removing automatic requeue it
  passes with one attempt. The SIGKILL regression now needs explicit requeue; the offline CLI
  regression checks confirmation flags, attempt matching and limited output on synthetic SQLite data.
  Local `npm run verify` passed 61 suites and 636 tests, with four PostgreSQL tests skipped. This
  does not prove offline controls, idempotent external effects or production recovery.
- Local PostgreSQL and Docker were unavailable. PostgreSQL, Compose and browser jobs passed at
  `7dc278c` in [CI](https://github.com/oloyaisaac/intelligent-data-capture-platform/actions/runs/44548570287).
  That is not production validation.
- The original manual two-server/sqlite3 sequence is not in this transcript. Automated real
  subprocess tests supply narrower synthetic two-worker and two-API observations; they do not
  establish safe worker recovery. Real mobile, packaged desktop, real OCR, external destinations,
  complete documentation replay and independent sign-offs remain unverified.
