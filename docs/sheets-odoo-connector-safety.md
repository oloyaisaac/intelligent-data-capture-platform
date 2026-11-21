# Google Sheets and Odoo connector boundaries

Google Sheets header discovery failures are no longer interpreted as an empty sheet. Invalid or
duplicate headers and malformed data responses fail closed, and all record columns are checked
before initializing a blank header. Empty batches are no-ops. Appended values now use the Sheets API
`RAW` input option instead of `USER_ENTERED`: text such as a formula-looking value is sent as text,
not intentionally interpreted as a spreadsheet formula. This is a compatibility change for mappings
that expected Sheets to parse dates, numbers supplied as strings, or formulas. Typed numbers remain
numeric in the JSON request. These are synthetic HTTP tests; actual Google Sheets behavior and
customer mappings must be verified with an authorized test account. Re-exporting data or editing it
in other tools can introduce separate formula risks.

Header inspection, header initialization and append are separate API calls. An apparently blank
header can change before initialization; concurrent writers, a mistaken or stale response, partial
success or a lost acknowledgement can cause a wrong header or duplicate append. A failure or timeout
is not evidence of rollback. Review the destination before retrying and coordinate writers. This
does not provide a conditional write, idempotency or exactly-once delivery. No real sheet or
historical data was inspected or repaired.

Odoo now rejects malformed lookup results instead of treating null as an empty match set; update
requires a positive safe-integer record ID and an explicit `true` response. Models and query limits
are checked at each operation. A failed batch may still have changed earlier records or an update
may have committed before a response was lost. Direct SDK users must still choose the correct
record ID; the first duplicate key is used by the update method. Test real Odoo versions and
custom modules, and review historical runs with authorized owners before rollout.

Both connectors now use the same response-body cap and per-request timeout as HubSpot/QuickBooks;
see `crm-http-response-limits.md`. Multiple requests in one operation can take longer than one
request deadline. The standard subprocess may impose a shorter overall timeout; neither is an OS
security or network sandbox. The new bounds and validation can reject previously accepted large,
slow or malformed responses.
