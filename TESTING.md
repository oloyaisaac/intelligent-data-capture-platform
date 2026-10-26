# Testing

How we prove the platform works. A story is not `done` until the relevant checks here pass.

> **Status:** the suite exists and is what CI runs (`npm run verify`): 346 tests in 22 suites across
> five Jest projects. This document states how it is organised, what each layer is for, and which
> gaps are deliberate (no browser or device automation yet).

---

## 1. Test pyramid

| Layer       | Scope                                                                                                                    | Tooling                         | Runs                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | --------------------- |
| Unit        | Pure functions: UDM validation, confidence thresholds, mapping transforms, CSV escaping, duplicate scoring, date parsing | Jest + ts-jest                  | Every commit          |
| Integration | API routes against a real Fastify listener over SQLite (`node:sqlite`) and filesystem storage in a temp directory        | Jest + `fetch` harness          | Every PR              |
| Contract    | Connector contract tests; UDM schema round-trip; OpenAPI validation                                                      | Jest + custom harness           | Every PR              |
| Component   | Desktop screens rendered in jsdom; mobile logic and screens as pure functions                                            | Testing Library (jsdom)         | Every PR              |
| End-to-end  | Pair → capture → extract → review → export (not automated yet; covered by the manual cases below)                        | Detox / Playwright, to be added | Manual before release |
| Manual      | Physical device camera/QR, real spreadsheet, real database                                                               | Checklist below                 | Before release        |

Target: ≥ 80% coverage on business logic (`packages/shared`, backend domain services). Coverage is a floor, not a goal — cover behaviour, not lines.

## 2. Test data rules

- **Never** commit real customer documents, IDs, invoices or personal data.
- Use synthetic fixtures in `fixtures/` (generated invoices, forms, receipts).
- PII in fixtures is fake, obviously so (`Amina Testperson`, `+256 700 000000`).
- Reset the database between integration tests; each test owns its organisation.

## 3. Commands

```bash
npm test                  # every workspace: shared, connectors, backend, desktop, mobile
npm run test:unit         # the three Node workspaces (no jsdom)
npm run test:prd          # PRD.json integrity (ids, refs, statuses, artifacts)
npm run test:api          # OpenAPI 3.1 validity + route cross-check, UDM schema freshness
npm run test:coverage
npm run typecheck         # tsc --noEmit in every workspace
npm run lint              # eslint, zero warnings allowed
npm run format:check
npm run verify            # typecheck + lint + PRD + API + tests
```

There is no Docker dependency: the backend suite runs SQLite in memory, storage in memory, and a
fake OCR provider. `test:integration` and `test:e2e` do not exist yet — they arrive with a database
and browser harness.

### Current coverage

| Workspace             | Suite                                                                                                                                                                       | Tests   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `packages/shared`     | `test/shared.test.ts`                                                                                                                                                       | 49      |
| `packages/connectors` | `test/connectors.test.ts`                                                                                                                                                   | 29      |
| `apps/backend`        | `test/*.test.ts` (auth, pairing, documents, batches, teams, dashboard, review, exports, connectors, AI, templates, developer API, marketplace, workflows, security, config, worker recovery) | 170     |
| `apps/desktop`        | `test/desktop.test.tsx` + `test/shell.test.ts` (jsdom + Testing Library)                                                                                                    | 55      |
| `apps/mobile`         | `test/mobile.test.ts` (pure logic)                                                                                                                                          | 43      |
| **Total**             | 22 suites                                                                                                                                                                   | **346** |

Notes for anyone extending the suite:

- The backend harness starts a **real listener** on an ephemeral port and drives it with `fetch`.
  Jest cannot load Fastify's `inject()` here (its `cookie` dependency is ESM-only).
- Mobile tests import pure modules only; anything that reaches `react-native` or the keychain
  belongs behind an injected port (`UploadTransport`, `TokenStore`), as the queue and client do.
- Contract tests are the cheapest guard against drift: add a case to `test:api` rather than a
  prose note when a route or schema changes.
- Batch and invitation tests assert the _failure_ path first: a rejected file inside a batch, a
  reused invitation token, an expired link. Those are the cases that silently regress.
- The MySQL connector is validated (config, identifiers) but not executed: there is no MySQL server
  in this environment. Do not describe it as tested end to end until one exists.

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
2. Open an approved record, choose the mapping, and press **Check for duplicates**.
3. **Expect:** the score, the matched keys and the existing row appear, and the destination is unchanged.
4. Press **Send**.
5. **Expect:** the second run reports `skipped_duplicate` for `skip`, updates in place for `update`,
   or fills only empty columns for `merge`; a reviewed field and a duplicate key are never overwritten.
6. Set the policy to `update` on a connector without update support.
7. **Expect:** `409`, not a silent append.

### TC-13c — CRM destination · `CRM-001`

1. Create a `hubspot` connector with a private-app token and object `invoices`, and a mapping profile
   with `invoice.number → invoice_number` as the duplicate key.
2. Send an approved record, then send it again.
3. **Expect:** one HubSpot record; the second run reports `skipped_duplicate` (or updates in place).
4. Replace the token with an expired one and test the connector.
5. **Expect:** an actionable message naming the write scope, not `401`.

### TC-13d — Marketplace install and rollback · `MARKET-001`

1. Create a HubSpot connector, then open Marketplace.
2. **Expect:** every package lists its permissions as sentences and its signature state.
3. Install HubSpot CRM on that connector.
4. **Expect:** `201`, an audit entry, and the package shows the installed version.
5. Try installing Zoho CRM (withdrawn). **Expect:** the button is disabled with the vendor's reason.
6. Roll back the install. **Expect:** the previous version becomes active and the connector keeps
   working — rollback never deletes a connector.

### TC-13e — A workflow that cannot act alone · `AGENT-001`

1. Create a workflow: on `document.approved`, for invoices, notify — plus send to a connector.
2. Approve an invoice that matches. **Expect:** the change is held; the run says `awaiting_approval`
   and the action is marked as destructive.
3. Approve the run. **Expect:** `completed`, the output names the connector, `approvedBy` is recorded,
   and approving again returns `409`.
4. Approve an invoice that does not match (different type or a failed condition). **Expect:** a
   `skipped` run whose explanation names the condition that failed.
5. Create a rule with `approvalPolicy: auto_approve` as a reviewer. **Expect:** `403` — only an owner
   may let a rule act unattended.
6. Delete the rule. **Expect:** `204`, and its runs remain in the log.

### TC-13f — Hands-free capture and a spoken approval · `VOICE-001`

1. Open Capture. **Expect:** a guidance line that changes with the framing ("move closer", "too
   dark", "hold still"), and no microphone activity while voice is off.
2. Turn flight mode on and reframe. **Expect:** guidance keeps working — it never needed the network.
3. Switch voice on and refuse the microphone permission. **Expect:** the reason shown is "permission
   needed", and no command fires.
4. Grant it, then say "capture". **Expect:** the photo is taken once; a mumble fires nothing.
5. In Review, say "approve" once. **Expect:** a confirmation prompt, not a filed record. Say it again
   (or tap Approve) to file it; saying anything else in between disarms the confirmation.
6. Turn voice off. **Expect:** the microphone is closed and any remembered command text is gone.

### TC-13g — Switching language and reading an RTL layout · `I18N-001`

1. Open Settings and switch the interface language to Kiswahili.
2. **Expect:** the navigation, the page bodies, the table headers and the empty states all change
   without a reload; dates show in the locale's format.
3. Switch to Français. **Expect:** the same, and a percentage renders as `85 %`.
4. Check a status badge and a document type. **Expect:** translated labels; a value the catalogue
   does not know shows as words, never as `needs_review`.
5. Set the document direction to `rtl` (the helper used by the root element) and reload.
   **Expect:** the sidebar moves to the right, its divider moves with it, table headers align to the
   right and no control is clipped — the stylesheet contains no `left`/`right` properties.
6. On the phone, set the device language to Swahili and launch the app. **Expect:** the tabs and the
   capture guidance are in Swahili; the voice cues and confirmation prompts use the same catalogue.

### TC-13b — Corrections and the training switch · `REV-002`

1. Correct two fields on two documents of the same type.
2. Open Settings.
3. **Expect:** the correction count and the fields with the lowest average confidence are listed, and
   the values themselves are not.
4. Press **Export corrections** as an admin with the switch off.
5. **Expect:** "not opted in" — the server refuses with `409`.
6. Turn the switch on, export again.
7. **Expect:** rows with document type, field path and confidence; a reviewer account cannot export.

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
