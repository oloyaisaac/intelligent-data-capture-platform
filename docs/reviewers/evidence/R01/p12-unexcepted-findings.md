# R01 P12 assessment: no unexcepted CRITICAL/HIGH finding

**Condition as written** (`docs/reviewers/R01-software-architect.md:342`):

> **P12** No finding of severity CRITICAL or HIGH remains open without a written, dated owner
> exception.

**Result: the condition is false.** Not "not yet assessed" — assessed, and false. The brief's own rule
applies (`:344`): _"If any condition is false, G1 FAILS. Record it in §13."_ §13 of the brief is still
empty, so the failure has never been recorded where the brief requires it.

Baseline `9ec567c`; this is a register audit, not new code review.

## What the register contains

| Measure                         | Count  |
| ------------------------------- | ------ |
| Findings recorded               | 48     |
| CRITICAL                        | **0**  |
| HIGH                            | **35** |
| MEDIUM                          | 12     |
| LOW                             | 1      |
| Written, dated owner exceptions | **0**  |

Severity is reconciled across both places it is recorded — the findings register's header table plus
each `### ARC-nnn — SEVERITY:` heading in `findings.md`, and the per-finding rows in
`completion-status.md`. The two agree on every ID they share; the eight HIGH findings that carry only
an `update` section (ARC-013, 014, 016, 017, 018, 019, 021, 022) have their full rows in the register's
header table. 35 + 12 + 1 = 48, matching the status table exactly. **The register is internally
consistent** — this is not a bookkeeping artefact, it is 35 open HIGH findings.

## Why no exception exists

Searched all of `docs/` for owner exception, accepted exception, exception granted, risk acceptance.
The only hits are the _requirements themselves_ (the R01 brief, the P12 row, R07's own P1) and one
handoff sentence. No finding carries an owner, a date and an accepted rationale. Every finding row
still reads "Unassigned".

That is the expected state rather than an oversight: exceptions are the accountable owner's act, and
an architecture reviewer cannot write one. Recording that the count is 35 and that the count is
unexcepted is exactly what R01 can and must do.

## The two populations behind the 35

They need different owners and different verbs, which is why a single "get to zero" instruction would
misfire:

1. **Partially remediated, awaiting authorized work (the large majority).** The defect is fixed for
   current code paths but cannot be closed without production access, historical-data review or a
   designed mechanism: existing connector secrets (ARC-023), old soft-deletes and page files (ARC-024),
   historical connector-run and batch error text (ARC-016, ARC-017, ARC-028), false-success workflow
   history and real dispatch (ARC-019), billed-usage verification (ARC-022), owned leases and fencing
   (ARC-013), an enforced connector boundary (ARC-014), bounded shutdown (ARC-021), file/database
   atomicity and orphan reconciliation (ARC-018). Also the correctness fixes now landed in code
   (ARC-025–045, 049, 051, 055, 058) whose closure needs an owner to confirm the fix on the final
   commit.
2. **Genuinely design-level, with no fix that could land quickly.** P6 ownership and exactly-once
   effects (ARC-013) and P8 containment (ARC-014) are protocol and infrastructure work; ARC-058 needs
   a shutdown contract for SSE; ARC-042's caller-supplied triggers need an authentication decision.
   These are not queue-jumping candidates — they are the wave-2 design agenda.

## What would legitimately change this result

Only three things, and none of them is available to me:

1. **Close with evidence** — an owner fixes the defect, the fix is verified on the final reviewed
   commit, and the register records the closure with the verifying evidence.
2. **A written, dated owner exception** — the accountable owner accepts the residual risk explicitly,
   naming the risk rather than the ticket, with a date and a scope.
3. **Independent re-scoring** — the gate chair or independent architect decides a finding is
   mis-scored, which must be recorded with reasons rather than silently edited. (One such correction
   already happened honestly: ARC-060 was drafted HIGH and re-scored LOW with the reasoning left
   visible. That is the acceptable shape of this route, and it was a downgrade of a _new_ finding, not
   of an inherited one.)

Fixing code to shrink the count would not change P12 either, unless the closure is recorded by an
owner. A reviewer who quietly deletes findings as they get fixed would produce a passing P12 and a
worse review.

## What I am asserting, and what I am not

I am asserting a count, a search that found no exceptions, and the arithmetic that makes the condition
false on this baseline. I am **not** asserting that any particular finding is wrongly scored, that a
fix does not work, or that production data is safe. I have no access to production and no authority to
accept risk. The gate decision, and any exception, belong to the named independent architect and the
accountable owners.
