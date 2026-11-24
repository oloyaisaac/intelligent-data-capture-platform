# R01 error-model boundary — targeted review

Source baseline: `9ec567c988888024a32d6e820b0c9f0ec262076b`. This is an architectural spot-check
for ARC-AC-38, not R04's exhaustive API-contract or R07's disclosure review.

- `packages/shared/src/errors.ts:7-26,45-70` defines `AppError`, `ErrorEnvelope` and the envelope
  converter. Its code type comes from the `ERROR_CODES` keys in `packages/shared/src/constants.ts`.
- `apps/backend/src/http/app.ts:124-212` manually constructs the unmatched-route 404 envelope and
  uses the converter for thrown application/framework errors. The framework-error mapping retains
  the HTTP status while assigning an application code; unknown errors are masked. These are
  separate paths that must be considered when changing the shared contract.
- `apps/backend/src/http/routes/realtime-routes.ts:43-51` constructs a 501 envelope directly when
  an injected `RealtimeHub` lacks the optional `subscribe` capability. Its code `NOT_IMPLEMENTED`
  is not a key in the shared `ERROR_CODES`, and the message directs callers to a realtime socket
  although the source says no Socket.IO adapter is shipped. `apps/backend/test/devapi.test.ts:236-251`
  explicitly exercises 501 with an injected non-subscribing hub; it does not establish that the
  default in-memory hub takes that branch. `/events` in `docs/openapi.yaml:1894-1911` lists 200
  but not this 501 response. See ARC-052.
- `http/app.ts:105-121` deliberately returns the structured `HealthResponse` with status 503 for a
  degraded dependency rather than an `ErrorEnvelope`; `/health` lists 503 in OpenAPI. This is a
  health-probe contract and should be reviewed explicitly rather than automatically called a defect.
- Raw stream writes and transport failures after SSE headers are sent are not ordinary JSON error
  responses. Only the surface above was inspected; it does not prove all route-specific envelopes,
  external errors, client handling or production behavior are consistent.

R04 should decide the public error contract, 501 status/code and documented fallback; R09/R11 can
check client handling, and R18 the health/stream operational behavior. No code change or specialist
acceptance is recorded here.
