# R01 §3 data-flow replay — partial evidence

`apps/backend/test/architecture-flow.test.ts` runs a real HTTP listener backed by an isolated test
database, in-memory storage, an in-process hub and a fake OCR provider. It registers an account,
creates and parses a pairing QR payload, exchanges it for a device credential, uploads with that
credential and an idempotency key, checks file bytes, drains the worker, corrects and approves an
extraction, downloads a CSV export and sends the approved record through a local CSV connector.
It also observes hub events and retries before and after approval. On the source baseline `9ec567c`,
`architecture-flow.test.ts`, `devapi.test.ts` and `membership-scope.test.ts` passed **3 suites /
18 tests** on the default local SQLite test configuration; raw output is in `flow-replay-9ec567c.txt`. The full backend suite passed against
PostgreSQL in [CI for `8b3e054`](https://github.com/oloyaisaac/intelligent-data-capture-platform/actions/runs/44547470620); this earlier CI includes the replay and the forced concurrent-upload regression.

## Replay coverage against `ARCHITECTURE.md` §3

| Documented flow      | Observed in the current synthetic replay                                                                                                                                                                    | Important limits / handoff                                                                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pairing              | HTTP creates a session, parses its QR payload and exchanges the token for a device credential; the in-memory hub observes `device:paired`.                                                                  | This is not a camera scan, native secure storage, physical network or packaged desktop. The separate pairing suite covers selected replay/revocation cases; R05/R10/R11 assess actual client/credential behavior.              |
| Capture and review   | A device credential uploads synthetic PNG data; a repeated idempotency key returns the same document, file bytes are read, fake OCR runs once, and a human-review API correction and approval are observed. | Storage is in memory and OCR is fake; native queue, crash recovery, file/DB atomicity and real OCR are not established (ARC-013/018, R11/R14/R18). The successful path does not validate every approval or authorization rule. |
| Export and connector | CSV export contains the corrected value; a mapped CSV connector send produces a local temporary CSV file.                                                                                                   | This exercises one CSV destination, not all formats, remote providers, partial side effects or isolation against hostile code (ARC-014/026/032/035/036; R07/R15/R18).                                                          |
| Realtime             | The test subscribes directly to the in-process hub and observes events. The separately rerun `devapi.test.ts` and `membership-scope.test.ts` exercise selected HTTP SSE and tenant-scoping paths.           | No cross-replica delivery guarantee, long-lived stream reauthorization, missed-event recovery or production traffic is established. The optional no-subscribe 501 path has a contract inconsistency (ARC-052); R04/R18.        |
| Workflow actions     | No workflow delivery is tested as part of this core replay.                                                                                                                                                 | Current unsupported send/export/notify actions fail closed, rather than dispatch effects; historical rows may claim success. R02/product and relevant specialists own ARC-019/027/039/040/042.                                 |

The test constructs temporary directories and synthetic accounts; no production traffic, data,
native devices, remote OCR endpoint or external vendor was used.

The initial replay failed before remediation: a retry returned the same document but created a
second extraction job, resulting in two OCR calls. Upload now atomically records document, page,
audit and job and does not enqueue a new job for a retry. `documents.test.ts` additionally exercises
forced concurrent requests, failed enqueue rollback, legacy records without jobs and an artificially
lost commit acknowledgement. Storage itself is not transactional; best-effort cleanup cannot cover
process crashes, failed deletes, partial writes or ambiguous database commits. No exactly-once
worker recovery is claimed.

This replay is not the complete T-07 evidence: no native mobile capture/queue, physical QR scan,
packaged desktop, real OCR engine or external vendor destination was executed. The hub subscription
was observed in process, not via a second replica; real SSE transport and replica locality have
separate tests. Real user/device workflows, failures and production operations remain unverified.
