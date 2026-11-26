# R01 Software Architect — report

**Baseline:** `9ec567c` (code tree identical on `main` at `67be7cb`; 0 non-document paths differ, so all
evidence gathered at the baseline describes the merged tree — `baseline-equivalence.txt`).

**Status of this report:** an **engineering assessment**, not a gate result. G1 and G8 are unsigned. No
owner exception has been granted, no specialist has accepted a finding, and nothing here was observed in
production. The brief's §13 (blocked items) is deliberately left empty: recording a failed condition
there is the gate chair's act, not the reviewer's.

---

## 1. The answer to the mission

The brief asks whether the system has a coherent architecture the codebase actually implements. **Yes,
with qualifications that are specific and nameable.**

The seams are in the right places. Every SQL statement lives in `db/` or `repositories/`; every
environment read is in `config.ts`; no service imports an HTTP framework; no package imports an app; the
dependency graph is acyclic across 355 files. These are not claims from documentation — they are sweeps,
rerun at the post-merge tip (`final-sweep-1cf29cf.txt`).

What the architecture does _not_ yet have is **distributed correctness**. The system is coherent as a
single-process application and incoherent as a multi-process one: ownership of work, delivery of events,
rate limiting and file storage are all process-local by design and uncoordinated in fact. That is a
deliberate decision (DEC-029), not an accident, and it is defensible for the deployment the product
actually documents. It becomes indefensible the moment someone runs two replicas, which is why the three
failed conditions cluster there.

**The documentation no longer lies about this.** `ARCHITECTURE.md` states the S3 adapter is absent and
the realtime hub is process-local; `DEPLOYMENT.md` §2 calls its scale-out diagram "aspirational, not the
supported deployment". The review's primary deliverable — establishing which documents are aspirational
and which are descriptive — is complete, and the answer is: the aspirational content is now labelled.

One inherited premise is stale and should be corrected in the brief itself. Its §1 states that
`ARCHITECTURE.md` §8 says _"No application code, so none of the above is implemented"_ and that §6
describes a `prisma/` directory. Neither string exists in the current file. Both were corrected before
this review began; a reviewer working from the brief alone would search for text that is no longer there.

## 2. Condition status

Twelve conditions, chairs G1 and co-signs G8. Nine are recorded with evidence. **Three fail**, and under
the brief's own rule (`:344`) a false condition means G1 fails.

| Condition                     | Status    | Basis                                                                                                                |
| ----------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| P1 SQL boundaries             | Met       | 0 SQL outside `db/`+`repositories/`; every in-repo interpolation is a driver discriminator or fixed clause           |
| P2 environment boundaries     | Met       | 0 `process.env` outside `config.ts`, guarded by a scanning test                                                      |
| P3 workspace imports          | Met       | 0 package→app and cross-app edges in the bounded scan; two nonliteral mobile `require(name)` calls remain (R11)      |
| P4 acyclic graphs             | Met       | Madge: 0 cycles / 355 files                                                                                          |
| P5 single composition root    | Partial   | Met on both testable halves; unmet as a literal one-file rule — the database factory and 10 offline CLIs compose too |
| **P6 no duplicate work**      | **Unmet** | Claims are guarded; ownership, crash recovery and external effects are not fenced (**ARC-013, ARC-061**)             |
| P7 process-local state        | Met       | Complete source-visible inventory; consequence is concrete (ARC-058)                                                 |
| **P8 connector cannot crash** | **Unmet** | Measured: a child kills the host in 182 ms and writes outside its directory (**ARC-014**)                            |
| P9 architecture docs          | Met       | Claim-by-claim verification; two stale statements and a §8 omission routed to R20                                    |
| P10 ADR citations             | Met       | Brief's `comm` check empty both ways, 34/34                                                                          |
| P11 evidence and owners       | Partial   | Evidence complete; **accountable owners are unassigned**, which is the larger half                                   |
| **P12 no unexcepted HIGH**    | **FALSE** | 35 open HIGH findings, 0 written/dated exceptions (**§4**)                                                           |

**Checklist:** 42 items — 22 met or met-with-stated-limit, 10 partial, 7 unmet, 3 recorded assessments.
No item is unassessed.

## 3. Findings

49 findings: **0 CRITICAL, 35 HIGH, 13 MEDIUM, 1 LOW**. Severity is reconciled across the register's
headings, its header table and the status table; the three agree. All 49 are routed to a named specialist
in `specialist-handoffs.md`.

Routing concentrates: **R02 (23)**, R07 (13), R15 (11), R04 (10), R03 (9), R18 (8). That concentration is
the honest headline — this review's output lands mostly on the backend and security reviewers, and
referral is not acceptance: no specialist has agreed to any of them.

The 35 HIGH divide into two populations that need different verbs:

- **Partially remediated, awaiting authorized work** (the majority): current code paths are fixed, but
  closure needs production access, historical-data review or an owner's verification on the final commit
  — existing connector secrets (ARC-023), old soft-deletes and page files (ARC-024), historical error text
  (ARC-016/017/028), workflow dispatch (ARC-019), billed-usage verification (ARC-022).
- **Design-level, not fixable quickly**: owned leases and exactly-once effects (ARC-013), an enforced
  connector boundary (ARC-014), a shutdown contract for SSE (ARC-058), authentication for
  caller-supplied triggers (ARC-042). This is the wave-2 agenda.

## 4. P12 is false, and that is the report's most consequential line

No finding of CRITICAL or HIGH severity remains open without a written, dated owner exception. 35 HIGH
findings are open and **no exception exists anywhere in `docs/`** — a search for exception wording returns
only the requirements themselves (`p12-unexcepted-findings.md`).

Only three things can change this, and none is available to the reviewer: an owner closing a finding with
verification on the final commit; an owner granting a dated exception naming the residual risk; or the
independent architect re-scoring a finding with stated reasons. **Deleting findings as they get fixed
would produce a passing P12 and a worse review**, so the count stands at 35 while they are open.

## 5. The six questions (§8)

1. **Can a new engineer place a feature without asking?** Mostly — `ARCHITECTURE.md` §6 plus `layer-map.md`
   (all 195 scoped modules) answer _where_, which is two files and one of them is evidence. Nothing states
   where a new **port** belongs, and transaction composition and release compatibility still need judgement.
2. **Is the composition root the only place that knows concrete adapters?** No. `container.ts` builds every
   runtime adapter, but `index.ts` calls the factories, `db/index.ts` selects the driver, and ten offline
   CLIs compose their own repositories — with a read-only guarantee derived six times in two mechanisms
   and no shared test (`composition-root-verification.md`).
3. **Ten replicas tomorrow — what breaks first?** Now measured, in order: (1) rate limiting multiplies
   silently, `limit × replicas`, reset by every deploy — 6 attempts accepted against a configured 3 across
   a pair; (2) SSE reaches only the publishing process, so reviewers are never told work is ready;
   (3) replica-local file storage; (4) uncoordinated maintenance timers; (5) pool and memory multiplication.
4. **Which decision carries the most risk, and what would reversing it cost?** DEC-029's single-process
   runtime. Reversal needs leases, fencing tokens, idempotent effects at every boundary, a shared bus, a
   shared limiter, coordinated maintenance and failure-injection evidence. The honest caveat: the current
   design is _correct_ for one process, so this is a scaling ceiling, not a present defect.
5. **Is the connector model safe for third-party code?** No. First-party operations run in one-shot
   children with bounded IPC, empty environment, timeout and output caps — a hang is cancelled at 3.1 s and
   a 1 MiB flood cut at 4 KiB without harm. But a child signals its host successfully (182 ms) and writes
   anywhere the host can. Not a sandbox; Marketplace-safe only behind an enforced boundary.
6. **Does `packages/shared` prevent independent release?** It creates build-time coupling, not a proven
   impossibility. All apps declare `"*"` and the package points at source; what is missing is a published
   immutable version, a compatibility policy, and any release proof. ARC-059 sharpens this: extractions are
   validated on write but re-parsed with the _current_ schema on read, ignoring `udmVersion`, so contract
   skew fails at read time.

## 6. Where the inherited risk list was wrong

The brief says confirm each of the six risks, do not copy the conclusion. Three did not survive:

| Risk | Inherited claim                                          | Verdict                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-04 | PostgreSQL never executed; migrations SQLite-flavoured   | **Refuted** — per-dialect branches, `pg_advisory_xact_lock`, zero SQLite-only keywords, real `postgres:16` CI job (not re-executed here: no server in this sandbox)                                           |
| R-16 | Connector sandbox claimed but absent                     | **Confirmed** — and measured                                                                                                                                                                                  |
| R-24 | `node:sqlite` experimental                               | **Confirmed** — warning on every run; an owner decision                                                                                                                                                       |
| R-25 | One secret signs tokens _and_ derives the encryption key | **Partly refuted, real residue** — separate `ENCRYPTION_KEY` now, but `JWT_SECRET` remains a decryption fallback (`container.ts:146`), so rotating it is not a pure session operation while legacy rows exist |
| R-18 | Limiter never evicts                                     | **Refuted** — sweeps, hashes keys, caps at 10 000 entries, fails closed                                                                                                                                       |
| R-21 | Three documents contradict the code                      | **Partly confirmed** — now one live defect (ARC-051) plus historical files carrying dated warnings                                                                                                            |

## 7. What this review did not do

- **No production execution.** PostgreSQL path refuted at source and CI level only; connector and
  encryption migrations are unexecuted by design.
- **No specialist review.** Findings are referred, not accepted. Real mobile/desktop, real OCR and real
  destination connectors were not exercised.
- **No owner assignment.** Every finding still reads "Unassigned"; proposed ≠ assigned.
- **Upload not exercised** in the replica probe; storage replication consequences rest on ARC-018.
- **Library, native and OS state** is named and excluded from the state inventory rather than measured.

## 8. Recommendation to the gate chair

Record **G1 as failed** on P6, P8 and P12, with P5 and P11 partial. Do not treat the 35 HIGH findings as a
blocker to _merging code_ — most are already partially remediated — but they are a blocker to _claiming
the architecture is approved_. The three failed conditions are not documentation gaps: they are missing
mechanisms, and each needs an owner before it can close.

The most useful next step is not more review. It is assigning owners to ARC-013, ARC-014 and the eight
findings concentrated in R02, then deciding whether the product's deployment is genuinely single-process.
If it is, P6 and P8 can be argued as _out of scope for the supported deployment_ — by the owner, in
writing, with a date. That is what an exception is for, and it is not the reviewer's to grant.
