# R01 ARC-AC-17: two workers against one database, measured literally

**Checklist item as written** (`R01-software-architect.md:182`):

> **ARC-AC-17 · Two workers are safe** — Start two backend processes against one SQLite file with
> `WORKER_ENABLED=true`; upload documents. _Pass criterion:_ no double-processing; no crash; no
> duplicate audit rows. **RUNTIME**

Earlier evidence covered this with the test suite's 20-document happy path. That is not a literal test
of the criterion (it never inspected audit rows for duplicates), and it never killed a worker while it
held a claim. This probe does both, with real backend processes and a fake OCR binary.

Baseline `9ec567c`. Transcript: `two-worker-audit-9ec567c.txt`.

```sh
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/two-worker-audit-probe.ts
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/two-worker-audit-probe.ts crash
```

## Clean mode: the criterion passes on the happy path

Two processes, `WORKER_ENABLED=true`, one SQLite file, 12 uploads alternating between the two HTTP
ports:

| Measure                   | Result                    |
| ------------------------- | ------------------------- |
| Uploads created           | 12/12 (HTTP 201)          |
| Documents post-extraction | 12/12, all `needs_review` |
| Duplicate audit rows      | **none**                  |
| Documents with >1 job     | **none**                  |
| Jobs left `running`       | 0                         |
| Processes alive           | 2/2                       |

So on the path the checklist describes, the claim protocol holds: no double-processing, no crash, no
duplicate audit rows. That is a genuine pass and worth stating plainly, because the honest answer to
"are two workers safe?" is _yes, for concurrent claims on healthy processes_.

## Crash mode: the work is neither duplicated nor completed

The interesting half. A single worker was killed with `SIGKILL` **while it held a claim** (the probe
waits until the database shows `status = 'running'` before killing, rather than guessing at a delay),
then a fresh process was started on the same database:

| Measure                   | Result                                |
| ------------------------- | ------------------------------------- |
| Claim held at kill        | 1 job `running` of 12                 |
| After SIGKILL             | 1 job still `running`, **0 requeued** |
| Documents post-extraction | **11/12** (one stuck in `processing`) |
| Duplicate audit rows      | none                                  |
| Duplicate job rows        | none                                  |

**No double-processing and no duplicate audit rows — but one document is permanently stranded.** The
restarted process cannot claim it, because the orphan `running` row fences that document
(`system-repo.ts:103-113`), and startup no longer requeues by age. It stays in `processing` with no
error surfaced and no retry, exactly as ARC-060 describes from the other direction.

This sharpens ARC-013 and P6 rather than adding a new finding. The failure mode of an unfenced claim is
not duplication — the claim guard prevents that — it is **silent abandonment of one document per
crash**, recovered only by an operator using the offline tooling. The checklist's literal criteria
(no double-processing, no crash, no duplicate audit rows) are all satisfied _while a document is still
lost_, which is worth saying out loud: passing ARC-AC-17 does not mean worker recovery is safe.

## Instrument corrections

Two defects in my own probe, both fixed before the saved transcript:

1. The liveness check used `child.exitCode === null` alone, which stays `null` for a signal-killed
   process — it reported "2/2 alive" after I had just killed one. Now checks `signalCode` too.
2. The first crash version killed the victim 400 ms after upload with no verification that it held a
   claim, and let the _other_ worker keep running. It therefore proved nothing about interruption. The
   current version reads `jobs` until `running > 0`, kills exactly then, and runs a single worker so
   the result is unambiguous.

Both are recorded because a crash probe that never crashed the claim would have produced a confident,
meaningless pass.
