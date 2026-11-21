# CRM HTTP response limits

HubSpot, QuickBooks, Odoo and Google Sheets use the bounded HTTP response transport. Each request has a deadline
covering both response headers and body. `timeoutMs` defaults to 15,000 and, if configured, must be
an integer from 1 to 120,000; the first-party subprocess may impose a shorter overall invocation
limit. Responses are read as a stream and rejected above 2 MiB of delivered body bytes, including
error responses; the request is aborted and body cancellation is attempted. This is an availability
and compatibility change: valid large responses or slow providers can now fail, and operators
should assess configuration and provider payload sizes before deployment. A failed or timed-out
write may nevertheless have committed remotely; inspect before retrying.

Tests cover streamed oversize, cancellation and a real local HTTP server that sends headers and then
stalls. These tests do not exercise an external vendor. The limit bounds accumulated body bytes, not
all memory: a transport may allocate a large chunk before it is checked, decompression/JSON parsing
can consume additional CPU and memory, and repeated calls accumulate work. Abort/cancellation cannot
force an uncooperative injected transport or remote server to stop, undo a remote side effect, or
replace OS-level resource isolation. SQL and file connectors do not use this HTTP transport and are
not covered. Connector subprocesses remain same-privilege and are not a security sandbox; see
`connector-process.md` and `connector-network-security.md`.
