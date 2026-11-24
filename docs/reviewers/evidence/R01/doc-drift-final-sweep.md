# R01: final documentation sweep — `AGENT_STATE.md` and `DEPLOYMENT.md`

ARC-AC-42 and R-21 remained partial because two documents had never been read in full. Both have now
been swept. This closes the _sweep_; it does not close documentation ownership, which is R20's.

Baseline: code tree identical to `9ec567c`; sweeps rerun at `1cf29cf` (content merged as `main`
`d1ef256`). Raw output: `final-sweep-1cf29cf.txt`.

## `AGENT_STATE.md` — refuted as current drift, retained as history

The parent risk said three documents contradict the code. `AGENT_STATE.md` no longer does, because it
now opens with a dated blockquote (`AGENT_STATE.md:3-9`):

> **Historical snapshot, 2026-10-27:** the handover below predates subsequent remediation and is
> retained for context, not as current release status.

That is the correct treatment of a stale handover, and it means the document's own claims ("Phase: M1
and M2 complete; Phase 3 in progress", a May-era branch name) can no longer mislead a reader the way
they did when the parent assessment was written. What remains is a maintenance question for R20: a
historical file that keeps being appended to is a file whose warning will eventually be wrong. No
action for R01.

## `DEPLOYMENT.md` — two accurate sections, one inherited defect it reproduces

**Accurate, and worth crediting.** §2 states the infrastructure diagram "is aspirational, not the
supported deployment: Redis, distributed worker ownership, shared rate limiting and object storage are
not implemented" (`DEPLOYMENT.md:23-25`). That is exactly the admission `ARCHITECTURE.md` was missing
before it was corrected, and it is the same conclusion this review reached by measurement in
`two-replica-evidence.md`. The document does not oversell scale-out.

**The inherited defect it reproduces.** `.env.example:82` documents:

```
RATE_LIMIT_UPLOAD_PER_MIN=60          # uploads per organisation       (60)
```

and `ENVIRONMENT.md:113` lists the same key under "Limits". The code builds a limiter from it
(`container.ts:449`) and applies it to **pairing session creation**
(`pairing-routes.ts:14`), keyed by user — not to uploads. Confirmed directly: `document-routes.ts`
applies only `MAX_UPLOAD_MB` and a role check, `batch-upload.ts` applies only `MAX_REQUEST_MB`, and
there is no per-organisation upload throttle anywhere in the service layer.

So the variable's name, its documentation and its units ("per organisation") are all wrong, and an
operator who tunes it to 60 expecting to cap uploads is capping device pairings instead. This is
ARC-051, already in the register; the new information is that **the defect originates in the
documentation**, not just in the wiring — the variable was named after an intent nobody implemented.

No fix was applied here. Renaming the key or implementing the intended limit are both decisions with
deployment consequences (an existing `RATE_LIMIT_UPLOAD_PER_MIN` in a real environment file would
silently stop being read by a rename), and R04/R15/R19 own them. R20 owns the environment reference.

## Sweep results at the post-merge tip

| Check                                 | Result                                 |
| ------------------------------------- | -------------------------------------- |
| SQL outside `db/` and `repositories/` | 0                                      |
| `process.env` outside `config.ts`     | 0                                      |
| `fastify` imports in `services/`      | 0                                      |
| `apps/` references inside `packages/` | 0                                      |
| deep `../../../../apps` imports       | 0                                      |
| madge circular                        | none, 355 files                        |
| ADR citations                         | 34 cited / 34 defined, empty both ways |

The 11 `request.`/`reply.`/`FastifyRequest` hits in `services/` are the known search artefact: a
`CreateExportRequest` DTO parameter named `request` in `export-service.ts` plus one comment in
`pairing-service.ts`. `fastify` imports in `services/` — the actual boundary claim — are zero. Recorded
so nobody re-opens ARC-AC-03 on a grep count.

## What this changes

ARC-AC-42 moves from "records known drift" to "both previously unswept documents read; drift recorded
with file:line". R-21's "three documents contradict the code" is now refuted for `AGENT_STATE.md` and
reduced to one live defect in the environment reference. R20 still owns documentation traceability.
