# Testing

How we prove the platform works. A story is not `done` until the relevant checks here pass.

> **Status:** no test suite exists yet. This document defines the harness to build in `FOUND-004` and the test cases to satisfy as features land.

---

## 1. Test pyramid

| Layer | Scope | Tooling | Runs |
| --- | --- | --- | --- |
| Unit | Pure functions: UDM validation, confidence thresholds, mapping transforms, CSV escaping, duplicate scoring, date parsing | Jest + ts-jest | Every commit |
| Integration | API routes against a real PostgreSQL + Redis in Docker; object storage via MinIO | Jest + supertest | Every PR |
| Contract | Connector contract tests; UDM schema round-trip; OpenAPI validation | Jest + custom harness | Every PR |
| Component | React screens (desktop), React Native screens | Testing Library (web + native) | Every PR |
| End-to-end | Pair → capture → extract → review → export | Detox (mobile), Playwright (desktop) | Nightly + before release |
| Manual | Physical device camera/QR, real spreadsheet, real database | Checklist below | Before release |

Target: ≥ 80% coverage on business logic (`packages/shared`, backend domain services). Coverage is a floor, not a goal — cover behaviour, not lines.

## 2. Test data rules

- **Never** commit real customer documents, IDs, invoices or personal data.
- Use synthetic fixtures in `fixtures/` (generated invoices, forms, receipts).
- PII in fixtures is fake, obviously so (`Amina Testperson`, `+256 700 000000`).
- Reset the database between integration tests; each test owns its organisation.

## 3. Commands (target surface, from `FOUND-004`)

```bash
npm test                  # all unit + integration tests
npm run test:unit
npm run test:integration  # requires docker compose up -d db redis minio
npm run test:e2e
npm run test:coverage
npm run lint
npm run typecheck
```

Plus a `PRD.json` validity check that runs in CI:

```bash
node -e "JSON.parse(require('fs').readFileSync('PRD.json','utf8')); console.log('PRD.json OK')"
```

## 4. Manual test cases

### TC-01 — Device pairing (happy path) · `PAIR-001`, `PAIR-002`

1. Sign in to the desktop app as an admin.
2. Choose **Pair a device**; a QR code appears with a visible countdown.
3. Open the mobile app and scan the code.
4. **Expect:** within 5 seconds the mobile shows "Paired" and the desktop lists the device name and platform.
5. Confirm no long-lived secret is visible in the QR content.

### TC-02 — Pairing rejects expired and reused codes · `PAIR-002`

1. Open the pairing dialog and wait for the token to expire (2 minutes) without scanning.
2. Scan with the mobile app. **Expect:** a clear "code expired" message and a retry path.
3. Pair successfully once, then scan the same code again with a second phone.
4. **Expect:** the second attempt is rejected as already used; the first device stays connected.

### TC-03 — Offline capture and automatic upload · `MOB-002`, `MOB-003`

1. Disable Wi-Fi and mobile data; capture three pages.
2. **Expect:** pages are stored locally with a queued status.
3. Force-quit and relaunch the app. **Expect:** the queue is intact.
4. Re-enable connectivity. **Expect:** all pages upload automatically, exactly once, with visible progress.

### TC-04 — AI extraction of an invoice · `AI-001`, `AI-002`, `AI-003`

1. Upload a synthetic invoice with a line-items table.
2. **Expect:** document classified as `invoice` with a confidence value.
3. **Expect:** supplier name, invoice number, date and total extracted with per-field confidence.
4. **Expect:** line items preserved as a table with rows and columns, not flattened text.
5. Verify the stored UDM record validates against the current schema.

### TC-05 — Human review and correction · `REV-001`, `REV-002`

1. Open a document whose total has low confidence.
2. **Expect:** the low-confidence field is highlighted and listed first.
3. Correct the total, save, approve.
4. **Expect:** approval succeeds once all required fields are present.
5. **Expect:** the correction is stored with original value, corrected value and the reviewer's identity.

### TC-06 — Bulk approve safety · `REV-001`

1. Select several documents, one of which has an unresolved low-confidence required field.
2. Run bulk approve.
3. **Expect:** all others are approved; the problematic one is skipped with a reason.

### TC-07 — Excel export · `EXPORT-001`

1. Approve three records, filter to that date range, export `.xlsx`.
2. Open in Excel, LibreOffice and Google Sheets.
3. **Expect:** columns match the selected mapping, table fields are structured, a provenance column exists.
4. Export zero records. **Expect:** a valid file containing headers only.

### TC-08 — CSV safety · `EXPORT-002`

1. Create a record whose value is `=1+1`, another containing `"quoted, comma"`, another with a newline.
2. Export CSV and open in a spreadsheet.
3. **Expect:** the formula is neutralised (no calculation), quoting round-trips correctly, the newline stays inside one cell.

### TC-09 — Device revocation · `PAIR-004`

1. Revoke a paired device from the desktop.
2. **Expect:** the device's next API call returns `401`, its socket is closed, and re-authentication fails.
3. **Expect:** an audit record exists for the revocation.

### TC-10 — Tenant isolation · `AUTH-002`

1. Sign in as a user in organisation A.
2. Attempt to fetch a document ID belonging to organisation B by direct URL.
3. **Expect:** `404` (not `403` with existence disclosure), and no data in the response body.

### TC-11 — Retention purge · `SEC-001`

1. Set retention to 1 day for a test organisation and age a document.
2. Run the purge job.
3. **Expect:** the storage object and rows are gone, the document is no longer downloadable and the purge is audited.

### TC-12 — Upload validation · `DOC-001`

1. Upload a 50 MB file. **Expect:** `413`.
2. Upload a `.exe` renamed to `.jpg`. **Expect:** `415` (content sniffing rejects it).
3. Upload the same file twice with the same idempotency key. **Expect:** one document, `201` then the same resource, not a duplicate.

### TC-13 — Connector write with duplicate detection · `CON-002`, `DUP-001`

1. Configure a mapping to a test Google Sheet with `invoice.number` as the duplicate key.
2. Send a record, then send the same record again.
3. **Expect:** the second run reports `skipped_duplicate` (or updates, per policy) and never creates a second row.

### TC-14 — AI provider failure handling · `AI-001`, `AI-004`

1. Configure an unreachable provider endpoint.
2. Upload a document.
3. **Expect:** the job retries with backoff, ends in `failed` with an actionable message, the document is not marked extracted, and the user sees a retry option. No stack trace is exposed.

## 5. Release checklist

- [ ] All automated suites green on the release commit.
- [ ] `TC-01` … `TC-14` executed and recorded.
- [ ] Manual camera/QR test on one physical Android device, one physical iPhone.
- [ ] Fresh install on a clean machine (no dev leftovers).
- [ ] No secrets in the diff, in logs or in built artefacts.
- [ ] `PRD.json` statuses and `CHANGELOG.md` updated.
- [ ] Rollback plan confirmed (`DEPLOYMENT.md`).

## 6. Bug reports

Include: environment (OS, app version, device), steps to reproduce, expected vs actual, screenshots, request ID from `X-Request-Id`, and a sample document type (never real customer data).
