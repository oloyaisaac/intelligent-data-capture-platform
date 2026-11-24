# R01 architecture-document verification (ARC-AC-27 … ARC-AC-30)

**Purpose:** check whether `ARCHITECTURE.md` describes the code that exists at baseline
`9ec567c`. This is the R01 deliverable P9 depends on; it is not a documentation sign-off, and R20 owns
the wider documentation review. Method: read each section, then confirm or refute the claim against
the tree with the commands recorded in `command-notes.md`. Nothing in `ARCHITECTURE.md` was edited —
the note at the end says what a correction would look like and who should make it.

## Verdict by checklist item

| Item      | Verdict                                      | Basis                                                                                                                                                                       |
| --------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ARC-AC-27 | Substantially accurate, two stale statements | §1–§5 match the tree; the "12 pages" style inventories are absent, and two §2 statements are stale (below).                                                                 |
| ARC-AC-28 | Met for the layout block                     | Every path in §6 exists in `git ls-files`; no `prisma/`. The block omits `adapters/`, `auth/`, `domain/` and `index.ts`, so it is a summary rather than a full layout.      |
| ARC-AC-29 | Substantially met                            | §8 now says application code exists and lists real gaps; it no longer makes the "nothing is implemented" claim. It is not exhaustive — see the omissions listed below.      |
| ARC-AC-30 | Met                                          | §2.4 and §5 state that connector subprocesses are not a sandbox, that children share OS privilege and can signal the host, and that injected registries can run in-process. |

The reviewer brief's own description of these items is out of date: it still expects §6 to cite a
`prisma/` directory and §8 to say no application code exists. Both were corrected before this
review. That mismatch is recorded for the brief's owner, not "fixed" here, because R01 must not
rewrite its own brief.

## Claims verified as described

- §1: single process holding API, worker and maintenance; PostgreSQL and a Compose path exist but no
  shared queue/broker/limiter; S3 absent. Matches `index.ts`, `services/container.ts`,
  `storage/index.ts`, `config.ts` (S3 refused).
- §2.1: queue metadata in the keychain-backed store, file URIs rather than bytes
  (`apps/mobile/src/state/queueStorage.ts:1-16`); HTTPS required except loopback
  (`apps/mobile/src/api/client.ts:77-84`).
- §2.2: `app://idcp` protocol with traversal rejection (`apps/desktop/src/main/app-protocol.ts`);
  `contextIsolation: true`, `nodeIntegration: false`, CSP from the configured API origin
  (`electron-main.ts:289-305`); `safeStorage` with an explicit "encryption unavailable → no tokens"
  path (`:197-212`); the IPC surface is four handlers (`preload.ts`).
- §2.3: `config.ts` is the only reader of `process.env` in backend `src`; SQLite transactions use one
  queue and `BEGIN IMMEDIATE` with no nested savepoint (`db/sqlite.ts:75-97`); job claim and success
  are conditional on `status = 'running' AND attempts = ?` (`repositories/system-repo.ts:153-178`);
  re-processing is refused while an extraction is queued or running; the upload path writes the file
  before the document/job transaction (`services/document-service.ts:154-159`), matching the
  documented orphan-file limitation.
- §2.4: child env is `{}`, `maxConcurrent: 8`, 60 s timeout, 2 MiB input/output and
  `--max-old-space-size=128` (`services/container.ts:158-170`, `adapters/connector-process.ts:38-45`).
- §5: public routes named are in fact public (`auth-routes.ts:48,61,79,116,219`,
  `pairing-routes.ts:28`, `legal-routes.ts:29,37`, `http/app.ts:105`); the SSE route checks the
  optional `subscribe` capability and returns 501 without it (`realtime-routes.ts:43-51`); streams are
  authorised on connect only.
- §7: limiter is capped at 10,000 entries with on-demand sweeping and fail-closed behaviour at
  capacity (`auth/tokens.ts:99-160`); the in-memory hub has no global subscriber bound
  (`realtime/hub.ts:55-60`); maintenance starts 10 s after boot then runs on the configured interval
  (`maintenance-service.ts:189-210`).

## Stale or incomplete statements (for R20 and the document owner)

| #   | Claim                                                                                                                                           | Reality                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | §2.2 "The update-check handler is a stub, not a functional update service."                                                                     | It is a stub, but it answers `{ status: 'up_to_date', version }` whenever `IDCP_AUTO_UPDATE` is on (`electron-main.ts:221-224`). A stub that reports "up to date" is a false assurance; "not a functional update service" is true, "stub" understates the specific return value. |
| 2   | §2.4 "Some connector-run errors are caught and recorded; validation, health, schema, duplicate-preview and send failures return safe messages". | Accurate for the defaults, but the in-process path for an explicitly injected registry has no child boundary at all, which the same paragraph says. The two statements are consistent but easy to misread as one blanket guarantee.                                              |
| 3   | §6 layout block                                                                                                                                 | Omits `adapters/` (subprocess transport, SMTP mailer), `auth/` (password, tokens, TOTP) and `domain/` (error taxonomies), all of which carry architectural weight; `index.ts` is absent from the block.                                                                          |
| 4   | §8 "Known gaps"                                                                                                                                 | Does not mention the known HIGH findings this review has recorded (worker recovery, connector containment, upload rate limiting, provider selection, API-key scope history). Those live in `findings.md`; §8 reads more complete than it is.                                     |
| 5   | §3 flow 2                                                                                                                                       | Does not say that the refresh path is outside a transaction and not an atomic single-use claim (ARC-054); it is a session concern rather than a data flow, so this is an omission rather than a contradiction.                                                                   |
| 6   | §4 table                                                                                                                                        | "Realtime: in-process hub and authenticated SSE" is accurate; it does not mention that the documented client fallback advice points at an unshipped socket (ARC-052).                                                                                                            |

## What a correction would look like — not applied

1. §2.2: replace the "stub" sentence with the actual contract — the handler returns
   `up_to_date` and performs no network check, so the caller must not treat it as an assurance.
2. §6: extend the layout block to `adapters/`, `auth/`, `domain/` and `index.ts`.
3. §8: add one line pointing at `docs/reviewers/evidence/R01/findings.md` for open architectural
   findings, so the document stops implying its gap list is exhaustive.

These are documentation edits in R01's own scope, but they change a document other reviewers cite as
authoritative. R01 records them and leaves the edit to the document owner with R20, consistent with
the "evidence-only changes" rule this review has followed so far. No claim is made that the
documentation is correct after this review.

## Scope and limits

Static reading of one document against the current tree on one commit. It does not verify runtime
behaviour, packaging, deployment topology or any statement in `AGENT_STATE.md`, `DEPLOYMENT.md`,
`ENVIRONMENT.md` or `ARCHITECTURE.md`'s linked runbooks. "Verified as described" means "the cited
code exists and does the stated thing", not "the behaviour was executed end to end".
