# R01 §3 data-flow replay — partial evidence

`apps/backend/test/architecture-flow.test.ts` runs a real HTTP listener backed by an isolated test
database, in-memory storage, an in-process hub and a fake OCR provider. It registers an account,
creates and parses a pairing QR payload, exchanges it for a device credential, uploads with that
credential and an idempotency key, checks file bytes, drains the worker, corrects and approves an
extraction, downloads a CSV export and sends the approved record through a local CSV connector.
It also observes hub events and retries before and after approval. The local SQLite run passed.
The full backend suite in PostgreSQL CI must also pass for this revision.

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
