# R01 remaining work — engineering handoff, not approval

R01 is **not complete or passed**. This note identifies work still requiring implementation,
operational evidence and independent review. It is not a substitute for the checklist in
`docs/reviewers/R01-software-architect.md`; unlisted checklist items must also be answered. No owner,
exception, production execution, reviewer or approval is implied by this note. For an item-by-item
inventory of all twelve passing conditions, currently recorded findings and required runtime evidence,
see `completion-status.md`. R01 assesses and reports architecture; specialist review and remediation
are routed in `specialist-handoffs.md`. Those recipients are proposed, not assigned or approved.

## P6 — recovery and duplicate work

Age-only automatic startup recovery has been removed. The deliberately offline, per-attempt command
in `docs/worker-recovery.md` supports audited requeue or reviewed abandonment without retry. The
unaudited repository requeue helper was removed. These remain availability and operational trade-offs,
not an ownership lease or a guarantee against duplicated OCR, billing, file deletion or other side
effects. Older versions can still reclaim live jobs, and abandonment cannot stop an active worker.
Current-version retention workers lock and recheck the claim during each destructive transaction,
but already-started deletion, storage/database ambiguity and old workers remain unresolved. The technical owner must decide an ownership, fencing, retry and deployment
protocol, including what guarantees are possible for external providers. Test both supported
databases with real separate processes at claim, failure, recovery, concurrent work, stale resume,
publication and external-effect boundaries. Cover conflicting distinct jobs, purge and review as
well as the same-claim publication guard. Establish operational detection and bounded shutdown.
See `worker-recovery-design.md` and findings ARC-013/ARC-021. A happy-path 20-document test and the
new narrow SQLite live-claim regression do not by themselves satisfy P6. ARC-024 additionally
records incomplete retention deletion: primary file failures are now retried instead of silently
reported as purged. A successful conditional retention metadata soft-delete and its per-document
purge audit now commit together; storage deletion remains outside that transaction and retries depend
on idempotent delete. Prior soft-deleted files, separate pages and retained/derived rows require a
designed and authorized reconciliation and deletion strategy. Known cross-table storage references
now block retention, erasure-file and expired-export deletion, and stale export metadata updates are
conditional. Erasure processors now lock and recheck the same queue row during deletion, limiting
stale-selection duplicate attempts by current-version processors. They also fail closed on observed
exact or syntactically aliased competing queue rows, leaving conflicts for authorized investigation.
Retention purge, export expiry and failed-upload cleanup also defer when they observe pending
requests for the same key or an alias; this can require manual conflict resolution, not automatic
completion. These checks are bounded point-in-time observations. Erasure processing holds a database
transaction over storage I/O and is not a storage fence or a solution for
concurrent queue insertion, mixed versions, key reuse, new references or connection loss. See
`docs/erasure-operations.md`. Filesystem deletion now rejects an unavailable or symlinked root, observed symlinks,
non-regular files and multiply linked final files; see `docs/storage-deletion-safety.md` for the
operational impact and important limitations. Writes and reads now also refuse observed unsafe
root/parent links, and reads reject observed unsafe final entries; POSIX-focused tests include the
document API. These are still non-atomic checks, root creation can mask a missing mount, root
ancestors are not checked, and platform and filesystem semantics need deployment validation. The
checks are not atomic with unlink, do not verify mount identity or root ancestors, and do not fence
concurrent references or key reuse. An absent
component below the root is treated as already deleted. Test and design for concurrent references,
changed exports and mixed versions. Measure cross-table scan costs and plan
indexing with a safe deployment strategy. ARC-026 adds an export key reservation before file writes;
ambiguous reservation, collision and failed writes are now left for investigation rather than
scheduled for deletion, while failures after confirmed writes may be marked failed for expiry.
Interrupted and queued exports still need detection and authorized offline reconciliation. Historical orphans, publication and
external-effect races are not repaired; age alone cannot establish that a writer is dead. The
read-only `docs/export-inventory.md` tool assists offline investigation only; it does not reconcile,
delete or prove that a candidate belongs to an export, and cannot find files with no export row.
The complementary read-only `docs/storage-inventory.md` command can enumerate regular and other
entries in a selected current-layout filesystem directory, including files without known references,
and separately observe recorded document/page/export/template keys for missing or unverifiable files.
It is bounded and requires sensitive output confirmation; it is not ownership proof, complete
filesystem discovery, authorization to delete or production reconciliation evidence.

## P8 — connector isolation

The default first-party registry runs validation, health, schema, duplicate preview and writes in
one-shot child processes. `connector-process-api.test.ts` covers a fatal child without killing the
API, but `connector-process-security.test.ts` demonstrates that the same-privilege child can signal
and terminate its host. Explicitly injected registries can still run in-process;
`connector-fatal-process.test.ts` demonstrates that path. These controls are not a sandbox. An implementer and security owner
need to choose and verify a separately enforced runtime boundary. At minimum, the design must address:

- fault containment for every connector entry point, including synchronous validation; bounded
  request/response sizes, timeouts, child cleanup and caller-visible safe errors;
- CPU, memory, process and concurrency limits; `process.exit`, hangs, malformed replies and abrupt
  termination; preventing connector code from killing or exhausting the API host;
- no inherited backend/database/signing secrets or broad filesystem access; authenticated,
  tenant-scoped request context and only the destination credentials required for the operation;
- enforced network egress controls for HTTP **and** database connectors, DNS rebinding/redirect
  handling, and an explicit capability/mount strategy for CSV and SQLite destinations;
- logging, diagnostics and response validation without leaking credentials or documents, plus
  duplicate/partial remote-write semantics when an invocation times out or dies;
- deployment, upgrade, compatibility and rollback behavior across supported platforms.

A same-privilege subprocess or worker thread alone is not a security sandbox. Prove controls using
adversarial integration tests in the actual supported deployment environment, not only mocks.
The subprocess implementation is only a partial mitigation; there is no approved security sandbox in this handoff.

## P5, P7 and the rest of the architecture review

The layer map, dependency scan, ADR register and drift notes are working evidence, not complete
independent validation. `services/container.ts` composes most services; `index.ts`, `db/index.ts`,
HTTP assembly and offline CLI entry points also construct or select adapters. The new worker recovery
CLI is another offline composition entry. The reviewer must decide whether the literal P5 requirement
can be met or needs an authorized exception; no such exception is recorded. Review remaining modules,
dynamic imports, all process-local state and all runtime exercises against the actual checklist,
complete the canonical evidence and assign named owners to findings. High findings require closure
or written, dated owner exceptions under P12. ARC-025 requires assessment of previously persisted
worker errors, logs and events, plus broader verification of sensitive-data logging; the new generic
worker failure messages do not clean historical copies or constrain arbitrary provider logging.

## Production migration evidence

No production database, credentials, backup or deployment has been accessed or migrated as part of
this review. The authorized deployment operator must follow `docs/connector-config-migration.md`
and `docs/encryption-key-migration.md` as applicable, including stopping writers, verifying backup and
restore, target keys, migration and target-only verification, deployment compatibility and rollback.
Record the actual environment, reviewed commit/artifact, operator, timing, non-secret command
results, verification counts and incident/credential-rotation decisions in an appropriately protected
operational record. Do not paste secrets, connection strings or customer data into review evidence.
Synthetic SQLite tests and PostgreSQL CI do not establish a production rollout or sanitize old
backups, WAL, logs or historical data.

## API-key expiry and delegation (ARC-045)

An authorized security owner must identify each deployment and its actual pre-upgrade key issuance
history, including external provisioning logs where available. Old key rows cannot establish whether
an expiry was requested; migration 017 deliberately leaves old expiries null and keys active. Assess
unexpected key creation/delegation, historical access and any untrusted copies; decide and document
revocation/rotation and incident response without publishing secrets. Coordinate affected clients and
human owner/admin management, since API keys and devices can no longer administer keys in new code.
Review the breaking default-deny API-key HTTP scope matrix in `docs/api-key-scopes.md` with product and
security owners and affected clients; direct services and device credentials are not covered. Audit
historical cross-scope access, inspect credential exposure and plan client rollout and rotation.
The release operator must review backup/rollback and clock synchronization, stop or fence all older
writers, apply migrations 016 and 017, deploy and verify both expiry enforcement and key-management
authorization with safe test credentials. Existing workflow plans can fail after migration 016; avoid
blind reevaluation because evaluation can execute actions. Record real environment, artifact, operator,
timestamps, non-secret checks and outcomes in protected evidence. These are outstanding actions, not
claims of production execution or an authorized security exception.

## Independent reviewer

Once engineering and operational evidence is ready, an independent qualified software architect
must inspect the actual reviewed commit, execute or verify the required R01 checks, assess every
passing condition and finding/exception, and record their own named, dated decision in the specified
review artefact. That person's decision cannot be delegated to the author of these changes or
pre-filled here. G1/G8 remain unsigned until the required people actually review and decide.

### Batch and runtime error disclosure (ARC-028 / ARC-025)

New batch failures use fixed messages and API/CSV reads mask arbitrary historical batch error text.
Historical rows and copies still contain their original values and require an authorized exposure
assessment and remediation. `docs/batch-error-remediation.md` describes a scoped, audited offline
per-batch remediation tool with an organisation-level inventory; it has not been run on production
and does not discover all organisations or clean historical copies. Other provider, runtime and
registry error boundaries were narrowed;
they do not establish that every application or third-party log and output is safe. See `findings.md`.

### Cloud cost controls (ARC-022)

Per-document and lifetime per-organisation current-version remote OCR reservations and configurable
count limits now bound calls on the guarded worker path; zero blocks new reservations. The default
organisation cap is 10,000 since migration and has no automatic reset. This does not bound the price
of one call, organisation-wide spend, provider-internal retries, new organisations, old/direct writers,
prior calls or rollback to a backup. A crash or ambiguous commit consumes a slot in each counter.
Operators need provider-side budgets, verified billing, consistent deployments, capacity monitoring
and a reviewed response to exhausted limits; see `DEPLOYMENT.md`. ARC-022 and independent review
remain open.

### Client boundaries and refresh reuse (ARC-053, ARC-054)

Desktop and mobile each own an `ApiClient` with no shared runtime module and no cross-import; the
shared package supplies types only. R09 and R11 must decide their own client behaviour, and neither
an extraction nor a merge has been authorised by R01. Both clients refresh independently on a 401 and
can submit one refresh token twice; the backend read-then-revoke path has no atomic single-use claim
and a synchronised local replay produced two usable successors. Only sequential rotation is covered by
existing tests. R05/R07 own the token decision with R03 for cross-driver atomicity; neither a packaged
client defect nor a production token replay is established. Client tests here ran against stubs and a
local backend, not a device, packaged app or real network.

Worth noting for whoever picks up the next slice of R01: the desktop client tracks `sessionId` and the
mobile client does not, only desktop implements the SSE event stream, and desktop `ApiError` carries
`details` where mobile's does not. Those are observations for R04/R09/R11, not findings.

### Architecture documentation (P9) and the environment contract

`architecture-doc-verification.md` verifies `ARCHITECTURE.md` claim by claim against the baseline: the
layered backend, single-process runtime, connector subprocess limits, desktop shell and SSE
statements are accurate; §6 paths all exist; §8 no longer claims the code is unimplemented; the
"connector sandbox" claim is already corrected. Three documentation corrections are described but not
applied, because they touch documents other reviewers cite: the update-check sentence should say the
handler answers `up_to_date` without checking (ARC-055), §6 should include `adapters/`, `auth/`,
`domain/` and `index.ts`, and §8 should link the open findings. R20 owns the edit; the reviewer brief
itself still describes pre-correction text and must not be edited from R01 evidence work.

`ENVIRONMENT.md` drift is recorded separately: its "nothing is emailed" text predates SMTP support,
and its §4 key table omits twelve keys that `config.ts` reads while its drift-test claim only covers
`.env.example`. Both are R20 items with R19 for delivery behaviour.

Integration gaps, so the next slice does not re-derive them: `.env.example`, `config.ts` and
`ENVIRONMENT.md §4` now need one reconciliation pass; `ARCHITECTURE.md` §2.2/§6/§8 need the three
corrections above; `PRD.json` marks all 45 stories `done` with two placeholder artifact strings
(`*.md`, `apps/mobile/src/assist/*`) and several `verification.notVerified` entries, so "done" is a
status label, not acceptance evidence (R20/R16 territory).

### Repository layer (ARC-AC-01, ARC-AC-04) and ownership (ARC-056)

The SQL placement half is now clean at this baseline: no literal or interpolated SQL outside `db/`
and `repositories/`, and request data is always bound. The persistence-boundary half is not clean and
is enumerated rather than summarised — retry/backoff/`dead` policy and the `retention_days <= 0` gate
in `system-repo.ts`, `role = 'owner'` literals in two repositories, and the redaction eligibility
predicate plus its forced binary collation in SQL. All of them work today; the cost is paid at the
next change, and the guarded conditional updates inside them must survive any move. R02 owns the
seam, R03 the cross-driver behaviour, R06 the ownership predicate, R08 retention and erasure.

The ownership predicate is also the newest finding: both "keep at least one owner" rules read a count
outside the transaction that acts on it, with two separate literal queries. ARC-056 is static only —
no interleaving test was written, because a synthesised schedule would not be better evidence than
the call sites.

### Composition root and P5 (ARC-AC-11/12/14, ARC-057)

P5 has now been measured instead of carried. ARC-AC-12 and ARC-AC-14 are met and test-guarded, every
_runtime_ adapter is constructed exactly once in `services/container.ts`, and there is no global
container or service locator. The multiplicity the earlier pass described is entirely the database
factory plus 10 offline operator CLIs, and a single root there would be the wrong fix: those tools need
a pool of one, no migrations and a read-only connection. The genuine gap is narrower and is ARC-057 —
the read-only guarantee is re-derived six times in two mechanisms, with no shared contract and no test
that inspection modes cannot write. `composition-root-verification.md` sets out the recommended
restatement of P5; only the gate chair can accept it.

### Process-local state and shutdown (P7, ARC-058)

P7's inventory is now complete for everything source can reveal: backend application state, all seven
backend timers (with bound and replica consequence), client state on both platforms, and the process
lifecycle. Library/native/OS state is named and explicitly out of scope rather than omitted. Finishing
the inventory immediately paid for itself — the lifecycle row exposed ARC-058.

ARC-058 is the most operationally significant finding recorded so far. Graceful shutdown is blocked by
any open SSE stream: idle `SIGTERM` exits in 10 ms, one open stream was still running after 8 s, and the
process exited only when the client disconnected. Maintenance is not the cause. Every desktop window
holds such a stream, so a supervisor's grace period expires into `SIGKILL` in ordinary use, which
contradicts the deployment guidance that suggests configuring the grace period to cover it. Fix shape:
track live streams and end them during shutdown, plus a bounded shutdown deadline; R09/R11 must confirm
the clients reconnect cleanly after a server-initiated stream end.

### Ports and seams completion (ARC-AC-02/03/05/06/09/13/15/21/23/24/25/34)

Twelve checklist rows moved off "partial" in one pass, and four passing conditions (P1–P4) are now
recorded with evidence instead of impressions. Two of those rows turned out to be **search artefacts,
not defects**: the "HTTP concerns in services" hits were an export DTO parameter named `request` and a
comment, and the `process.env` row was already clean and guarded by a test.

Two rows stay unmet because the code chose a different, defensible design, and that distinction matters
more than a refactor: there is no clock port (27 direct `Date.now()`/`new Date()` reads across nine
services, with optional `now` parameters used as an unenforced convention), and the `Database` port
exposes a `driver` discriminator that repositories branch on at 25 sites. In both cases the honest
documentation statement is the gap, not the implementation.

Worth carrying forward: `newId()` exists in `@idcp/shared/ids` but `document-service.ts:146` and
`privacy-service.ts:176` call the crypto API directly, so "identifiers are generated in one place" is
false; and the storage inventory tool walks the filesystem with `lstat`/`opendir` rather than through
the `Storage` port, so an S3 adapter (DEC-010) would silently leave it blind.

### ADR register complete (ARC-AC-41)

All 34 decisions now carry a bounded code assessment with file references; nothing is left "not
assessed". Three moved to honoured outright (DEC-018 derived batch counts, DEC-019 hashed single-use
invitations, DEC-022 static packaging contract), three are recorded as not honoured with the reason
stated (DEC-007 per-organisation provider selection, DEC-026 workflow dispatch, DEC-028 localisation),
one is superseded (DEC-006) and the rest are partially honoured, meaning the operational half needs a
specialist's evidence rather than R01's reading.

The pass produced one new finding, ARC-059: extractions are validated on write but re-parsed with the
_current_ schema on every read — the worker plus six sites in `review-service.ts`, including patch and
approval — so a row written under an older UDM version is not guaranteed readable after a schema
change. No incompatible change exists at this baseline, so this is an upgrade hazard for R03/R04, not a
present defect.

Two smaller notes are recorded in the register rather than raised: the reset URL is returned in the
body outside production, making the "never confirms an account exists" property depend on `NODE_ENV`
(R19), and DEC-012 is acknowledged only as a documentation-practice decision whose status file
(`PRD.json`, 45/45 `done` with several `notVerified`) is not acceptance evidence.

### Worker claim fencing (P6, ARC-060)

I went at P6 from the direction no existing test covers: what happens to _other_ work for a document
whose claim was orphaned by a crash. Two real subprocesses over one synthetic SQLite file showed the
orphan `running` row does fence later jobs for that document — and then showed that the product's own
reprocess path refuses with a clear 409 before a user can reach that state, so the earlier reading of
"silently stuck" was wrong.

The finding is recorded as ARC-060 (LOW) with the correction left visible: recovery is job-id-oriented
and the document view exposes no claim, so discovering which row blocks a document needs the offline
CLI. That is a discoverability/UX gap, not a correctness defect, and it does not change P6 — which
remains unmet for the ownership, fencing and exactly-once reasons in ARC-013.

Worth knowing for whoever continues: P6 and P8 are the two conditions that cannot be closed by more
reading. P8 needs an enforced isolation boundary (ARC-014); P6 needs a designed lease/fencing protocol
and failure-injection evidence (ARC-013). Neither should be marked met on the strength of probes like
this one, which show one interleaving rather than a protocol.

### P8 containment matrix

P8 was previously supported by a single negative test. It now has a five-behaviour matrix against the
real transport (`connector-isolation-evidence.md`): the host survives a hang (cancelled at 3.1 s
against a 3 s budget) and a 1 MiB stdout flood against a 4 KiB cap, and a spawned descendant did not
outlive the group kill in the case tested; it does not survive a child that signals it (182 ms) and it
cannot stop a child writing outside its directory. Two of my probe versions were broken in ways that
looked like product hangs — both are documented in the evidence file, because a review that hides its
own instrumentation errors is not worth much.

P8 cannot be closed from this codebase. It needs an enforced boundary (separate container/namespace,
seccomp profile, filesystem and network policy, and a broker for legitimate effects), which is R15/R07
design and R19 enforcement.

### P12 is false, and section 13 is empty

The register audited out at 48 findings: 0 CRITICAL, 35 HIGH, 12 MEDIUM, 1 LOW, and no written, dated
owner exception anywhere in `docs/`. I reconciled the count across the three places severity is
recorded and they agree, so this is a real population rather than drift in my own notes.

Two consequences worth carrying forward. First, the brief's rule at line 344 is that a false condition
means G1 fails, so the honest current state is "G1 fails on P6, P8 and P12", not "not yet determined".
Second, section 13 of the brief, where failed conditions must be recorded, is still an empty table.
Filling it in is the gate chair's act; I have left it alone deliberately rather than writing into the
brief's own gate record.

The 35 divide into partially-remediated work that needs production access or an owner's verification,
and two genuinely design-level items (ARC-013 and ARC-014) that are wave-2 agenda. Neither group can be
cleared by me: closure needs an owner's recorded verification, an owner's dated exception, or the
independent architect re-scoring a finding with stated reasons.

### T-04 and T-08 closed against live evidence

Two of the brief's required tests moved from "inferred" to "observed".

T-04 now has two real API processes over one database: the auth budget is per process (six attempts
accepted against a configured three across a replica pair, replica B unaware of A's 429s), and an event
published by replica B reached no stream on replica A. Sign-in, registration and pairing were exercised
for real; upload was not, and that gap is stated rather than glossed. Neither result is a new defect —
per-process limiter state is ordinary and SSE locality follows from DEC-006 — but both are now inputs
to decisions R07/R15 and R02/R03/R19 must make rather than assumptions.

T-08 passes at the baseline: the brief's comm check is empty in both directions, 34 cited and 34
defined. Citation integrity is not implementation, so ARC-AC-41 keeps the two claims separate.

What T-04 can never settle from inside a sandbox is the deployment topology: whether production runs
one replica or many decides whether either observation matters at all. That is R19's question and it
gates how strongly ARC-021 and ARC-058 should be worded.

### The report sections, and three inherited claims that did not survive

The brief asks for six questions answered and six inherited risks confirmed or refuted, with an explicit
instruction not to copy the conclusions. Doing that properly changed three rows:

- R-04 (PostgreSQL never executed, migrations SQLite-flavoured) is refuted at source level: per-dialect
  DDL, a PostgreSQL advisory lock, no SQLite-only keywords, and a real postgres:16 CI job. I could not
  re-execute it here — no server in this sandbox — and the write-up says so rather than implying I did.
- R-18 (limiter never evicts) is refuted outright by `auth/tokens.ts:99-157`: it sweeps, hashes keys and
  caps at 10 000 entries, failing closed at capacity. What survives is that it is process-local, which
  the two-replica probe now measures.
- R-25 (one secret signs tokens and derives the encryption key) is partially refuted and leaves a real
  residue: `JWT_SECRET` is still passed as a decryption fallback. It cannot open new ciphertext, and it
  exists for rotation safety, but while legacy rows remain, rotating `JWT_SECRET` is not purely a
  session operation. ARC-023's migration has to account for that.

This matters beyond bookkeeping: an inherited risk list is an input to be tested, and three of six rows
here were wrong or stale. A reviewer who had copied them would have filed two non-defects and
understated one real coupling.

The §8 answers that remain genuinely open all reduce to deployment questions — how many replicas, what
boundary third-party connectors run behind, whether independent release is required. Those are R19's and
R02's calls; I can supply the measured consequences but not the decision.
