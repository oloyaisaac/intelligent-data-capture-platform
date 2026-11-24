# R01 layer and policy boundaries — bounded review

Source baseline: `9ec567c988888024a32d6e820b0c9f0ec262076b`. This review examines architecture,
not feature correctness, schema/migration portability or the complete authorization audit (R02,
R03, R06). The brief describes 13 repositories; `git ls-files 'apps/backend/src/repositories/*.ts'`
returns **27 files / 4,723 lines**, including row types, safety/inventory and operational repositories.
The list is larger than the historical brief, and the examples below are not a complete line-by-line
review of those 27 files.

## Selected repository policy and transaction boundaries (ARC-AC-04)

- `repositories/system-repo.ts:184-207` owns not just persistence/row mapping but the retry/dead
  decision, exponential backoff and 60-second cap for failed jobs. `:9-27` supplies the default
  attempt count. These are behavior policy embedded in a persistence adapter, so the literal
  “only persistence + row mapping” criterion is not met (ARC-048). A policy change could require
  editing the adapter; this is a coupling observation, not evidence that the retry is defective.
- The same file `:51-82,85-145` also coordinates atomic retention enqueue and claims with row locks,
  status predicates and job-type-specific selection. These transactional rules protect concurrent
  updates; they are not equivalent to generic CRUD. Moving them blindly into a service or removing
  the predicates could break atomicity. R02/R03/R18 should evaluate any proposed seam and preserve
  tested concurrency and failure semantics.
- `repositories/remote-ocr-budget-repo.ts:8-17` validates the maximum and reserves an invocation
  under a conditional update; the call-count limit is not a monetary budget (ARC-022). The atomic
  update is a persistence invariant; the choice and interpretation of the policy need coordinated
  review with R14 and R02/R03.
- `repositories/erasure-files-repo.ts:13-28` rejects invalid scope and imposes a 100-row batch bound,
  preventing an accidental global or unbounded selection. Safety validation at this boundary should
  not be removed simply to make a strict layering metric green. R08/R03 review erasure semantics.
- `repositories/auth-repo.ts:375-381,452-454` uses a role type and counts owner rows. Reading or
  counting a role is not itself an authorization decision. A literal search for role-comparison,
  role helper, `ROLE_REQUIRED`, `FORBIDDEN`, or Fastify symbols in repository files had no matches;
  this is not proof of absence of encoded policy or tenant/authorization defects.

`http/app.ts:109` invokes `checkDatabaseHealth(services.db)` for the health endpoint. A targeted
search found no direct repository imports or SQL-driver method calls in `http/`; the health edge is
an intentional observable cross-layer dependency, not a statement that all route concerns were
reviewed. `db/health.ts` and behavior of health endpoints still require appropriate R02/R04 review.

R01 should decide whether transactional repository policy is a documented architectural exception or
whether a safe decomposition is appropriate. Independent reviewers and owners decide changes; this
note does not assign an owner, authorize refactoring, or close ARC-013/022/024. Additional repository
files, indirect dependencies and runtime paths remain to be reviewed.
