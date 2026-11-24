# R01 architectural assessment: §7 risks and §8 questions

The brief asks R01 to answer §8's six questions and to **confirm or refute each §7 risk itself,
"do not copy the conclusion"** (`R01-software-architect.md:233`). This file is the report section. It
supersedes `assessment-notes.md`, which was a working draft written before this session's probes and is
now labelled as such.

Baseline `9ec567c`. Nothing here is a gate result, an owner exception or reviewer sign-off.

## §7 — six inherited risks, each re-checked

| Risk | Parent claim                                               | My verdict                                 | Basis                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | ---------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-04 | PostgreSQL never executed; migrations SQLite-flavoured     | **Refuted**                                | Migrations carry per-dialect branches (`entry.postgres` / `entry.sqlite`), a PostgreSQL advisory lock (`pg_advisory_xact_lock`), and **zero** SQLite-only keywords such as `AUTOINCREMENT` or `PRAGMA` (`pg-dialect-9ec567c.txt`). CI runs the whole backend suite against `postgres:16` (`.github/workflows/ci.yml:91-131`). This sandbox has no server — `ECONNREFUSED` — so I did **not** re-execute it; the refutation is by source and CI configuration, and R03 owns runtime verification.                                                                                                                                                                       |
| R-16 | `ARCHITECTURE.md` claims a connector sandbox               | **Confirmed**                              | No sandbox exists. `ARCHITECTURE.md` has since been corrected to say so, so what remains is the missing boundary, not a false document. Measured this session: a child signals its host (dies in 182 ms) and writes outside its directory (`connector-isolation-evidence.md`). ARC-014; P8 unmet.                                                                                                                                                                                                                                                                                                                                                                      |
| R-24 | `node:sqlite` is experimental                              | **Confirmed**                              | Node prints `ExperimentalWarning: SQLite is an experimental feature` on every run — visible in every transcript in this directory. The default storage engine is not API-stable across Node upgrades; an owner decision, not a defect.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| R-25 | `JWT_SECRET` signs tokens _and_ derives the encryption key | **Partially refuted, with a real residue** | New writes use a separate `ENCRYPTION_KEY`, and production config rejects the two being equal or short (`config.ts:195-200`). **But** `container.ts:146` still passes `JWT_SECRET` to `createSecretBox` as a decryption fallback, and `crypto.ts:71-78` silently tries it when the primary key fails. This cannot open new ciphertext (that needs `JWT_SECRET` = `ENCRYPTION_KEY`) and its stated purpose is rotation safety — so it is not the parent's "same key does both". It is nonetheless a live coupling: rotating `JWT_SECRET` is not a pure session-invalidating operation while legacy rows exist, and this is a fact ARC-023's migration must account for. |
| R-18 | `AttemptLimiter.hits` never evicts                         | **Refuted**                                | `tokens.ts:99-157` sweeps expired entries at intervals of min(window, 60 s), hashes keys, and caps capacity at 10 000. At capacity it **fails closed** for new keys — an availability trade-off rather than the unbounded-growth risk described. What stands is that it is process-local, now measured: six attempts accepted against a configured three across two replicas (`two-replica-evidence.md`).                                                                                                                                                                                                                                                              |
| R-21 | Three documents contradict the code                        | **Partly confirmed**                       | `ARCHITECTURE.md` drift was corrected and verified claim-by-claim (`architecture-doc-verification.md`); two stale statements and one §8 omission remain for R20. `AGENT_STATE.md` is historical and now carries a dated warning; `DEPLOYMENT.md` has not had a full sweep. Confirmed as drift, refuted as "three documents currently contradict the code".                                                                                                                                                                                                                                                                                                             |

Two refutations of inherited claims (R-04, R-18) and one partial (R-25) are worth stating plainly: the
parent assessment's risk list is **not** a reliable input in those three rows. That is exactly why the
brief says not to copy it.

## §8 — six questions

**1. Can a new engineer place a feature without asking?** Mostly, for _location_: `ARCHITECTURE.md` §6
gives the route → service → repository → database direction and `layer-map.md` inventories every
module. Not completely: transaction composition, event durability, the broad `Services` object and
release compatibility still need judgement, and no document states where a _new port_ belongs. There is
no single file that answers "where does this go" end-to-end; §6 plus `layer-map.md` together do, which
is two files and one of them is mine.

**2. Is the composition root the only place that knows concrete adapters?** No. `services/container.ts`
builds every runtime adapter, but `index.ts` calls the database and HTTP factories, `db/index.ts`
selects the driver, and ten offline CLIs compose their own repositories — a second entry-point class
with a real, unshared read-only guarantee derived six times in two mechanisms
(`composition-root-verification.md`). OCR provider construction has moved into the container, so that
particular leak is closed. P5 is met on both testable halves and unmet as a literal one-file rule.

**3. Ten API replicas tomorrow — what breaks first, in order?** Now answerable from measurement rather
than inference:

1. **Rate limiting** — silently multiplied, `limit × replicas`, reset by every deploy. Measured.
2. **SSE** — events reach only clients attached to the publishing process, so reviewers are not told
   work is ready. Measured.
3. **Storage** — an upload written to one replica's local disk is invisible to the others (ARC-018).
4. **Maintenance sweeps** — each replica runs its own timer set; seven backend timers are inventoried
   in `state-inventory.md` with no coordination.
5. **Database and memory** — pool counts and baseline memory multiply; the SQLite path serialises
   writers through `busy_timeout`.

The realistic answer to "run ten" is that the system is single-writer by design (DEC-029) and replicas
degrade it in ways that are individually small and collectively disqualifying.

**4. Which decision carries the most risk, and what would reversing it cost?** DEC-029's
single-process runtime with unfenced external effects. Reversal is not a refactor: it needs owned
leases, fencing tokens, idempotent effects at every boundary (OCR, mail, connectors, files), a shared
bus, a shared limiter, coordinated maintenance, and failure-injection evidence. ARC-013 is the register
entry. Note the honest consequence: the _current_ design is defensible for one process, so the risk is
a scaling ceiling rather than a present defect.

**5. Is the connector model safe for third-party code?** No. First-party operations now run in one-shot
children with bounded IPC, an empty environment, a timeout and output caps — real hardening, and
measured: a hang is cancelled at 3.1 s and a 1 MiB flood is cut at a 4 KiB cap without harming the
host. But children share the API's OS identity, can signal it and can write its filesystem
(`connector-isolation-evidence.md`). Injected registries may run in-process entirely. P8 unmet; a
Marketplace needs an enforced boundary before third-party code is acceptable.

**6. Does `packages/shared` make independent release impossible?** It creates build-time coupling, not
a proven impossibility. All three apps declare `@idcp/shared: "*"` and the package points `main`/`types`
at source, so a monorepo build always shares the checked-out contract. Independent deployment is
possible only if deployed builds retain compatible API and UDM contracts — and no published immutable
version, compatibility policy or release proof exists. ARC-059 sharpens this: extractions are validated
on write but re-parsed with the _current_ schema on read, with `udmVersion` ignored, so a contract skew
between an old client and a new backend fails at read time rather than at the boundary.

## What this file does not do

It does not score the gate. Three of §8's answers reduce to "needs a deployment decision" (3, 5, 6),
which is R19's and R02's authority, not R01's. §7's two refutations are about the parent assessment's
accuracy, not a claim that the PostgreSQL path is production-proven — I could not execute it here.
