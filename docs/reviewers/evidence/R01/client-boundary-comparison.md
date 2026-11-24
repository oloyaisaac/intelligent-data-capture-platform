# R01 client boundary review — desktop and mobile (ARC-AC-37, ARC-AC-38)

**Scope:** `apps/desktop/src/api/client.ts` (973 lines), `apps/mobile/src/api/client.ts` (388),
their tests and shape, against the shared contract package. Baseline `9ec567c`. This is an
architecture boundary assessment of two clients R01 is asked to compare; it is not a UI, security,
accessibility or mobile-platform review, and it is not a compatibility guarantee. R09 (desktop),
R11 (mobile), R05 and R07 own their detailed reviews.

## What is genuinely shared and genuinely different

| Concern             | Desktop                                                             | Mobile                                                                                   | Assessment                                                                                               |
| ------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Contract types      | `@idcp/shared` types                                                | `@idcp/shared` types + `assertSecureEndpoint`                                            | Type-level sharing only; no shared runtime client or schema re-validation.                               |
| Base URL            | Relative `/api/v1` (renderer origin, Vite proxy) or explicit origin | Required paired endpoint, HTTPS enforced outside loopback                                | Different trust models. Desktop relies on the packaged origin; mobile validates a user-supplied host.    |
| Credential storage  | `TokenStorage`: preload/keychain bridge, memory fallback            | `TokenStore`: platform store plus a paired-device credential                             | Adapter boundary is correctly placed in both. Fallback semantics differ and are not equivalent security. |
| Upload              | `FormData`/`File` multipart path                                    | Device-credential upload path with optional idempotency key                              | Two distinct auth modes on one API contract; R11/R04 own device-credential scope.                        |
| Errors              | `ApiError` with `details`, envelope message preferred               | `ApiError` without `details`                                                             | Divergent error detail surface; an undeclared code reaches both (ARC-052).                               |
| 401 handling        | One retry after `refresh()`; clear session when refresh fails       | One retry after `refresh()`; clear store when refresh fails; not applied to device calls | Same algorithm, implemented twice, with no in-flight refresh coordination (ARC-053/ARC-054).             |
| Session identity    | Tracks `sessionId` to mark "this device" in the session list        | Does not track a session id                                                              | API documents `sessionId` as surviving rotation; only one client consumes it.                            |
| Realtime            | EventSource via `eventsUrl()` with query-string token               | Not present                                                                              | Feature asymmetry, not a defect by itself.                                                               |
| Test double quality | `MemoryTokenStorage`, injected `fetchImpl`                          | `MemoryTokenStore`, injected `fetchImpl`                                                 | Both are testable without a device or network; good seam.                                                |

A shared client-neutral core is _possible_ but not demonstrated safe: the differences above are
behavioural, not cosmetic. Any extraction must keep transport, storage, upload auth, endpoint
validation and offline semantics behind platform ports; mechanical merging of two 401 paths into one
would inherit the coordination defect below unless it is fixed at the same time.

## ARC-053 — MEDIUM: client refresh has no in-flight coordination

Neither client holds a shared refresh promise or serialises retries. `desktop/src/api/client.ts:236-247`
and `mobile/src/api/client.ts:160-175` each call `refresh()` from the 401 branch, and each
`refresh()` re-reads the stored token before exchanging it (`desktop:255-273`, `mobile:179-200`).
Two concurrent requests that both receive 401 therefore both submit the same refresh token.

A synthetic fake-fetch probe (no network) reproduces the client-side shape:

```sh
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/client-refresh-probe.ts
```

Result (`client-refresh-probe-9ec567c.txt`): desktop sent two `/auth/refresh` requests with the same
token and then made four document requests; the second rotation overwrote the first in storage.
Mobile sent the same token twice, and a stub that enforces single use rejected the repeat, which made
the mobile client clear its store and fire `onSessionExpired` once even though one request had
succeeded. Impact range is "extra request and odd retry" to "person is signed out mid-session",
depending on ordering and on what the server does with a reused token. That server behaviour is
ARC-054 territory; R05/R07/R09/R11 should decide whether to dedupe refreshes, retry the losing
request with the winner's token, or serialise on a mutex.

The probe is a client-shape demonstration with stubbed HTTP. It does not prove a user-visible sign-out
in the packaged desktop app or on a real device, does not prove a token leak, and does not measure
frequency. Existing tests cover only the sequential path (`desktop.test.tsx` "refreshes once on 401",
`mobile.test.ts` equivalent); no test exercises two simultaneous 401s.

## ARC-054 — MEDIUM: refresh rotation is not atomic under concurrent reuse

`AuthService.refresh` (`services/auth-service.ts:561-572`) reads the session by token hash, then
calls `sessions.revoke(session.id)` (`repositories/auth-repo.ts:504-509`, a conditional
`UPDATE ... WHERE revoked_at IS NULL`) and only afterwards issues a new pair with a **new** session
row. The read and the revoke are not one conditional claim: the affected-row count is discarded, and
the new session is not derived from the revoke, so two callers that both read an unrevoked row both
succeed. The service does not run refresh inside `transaction()` even though composition provides
one (`services/container.ts:182-190`, plus further per-service transactions).

A synthetic probe with a deliberate read barrier between the two lookups, on the real service,
routes, SQLite repository and HTTP stack, shows the interleaving:

```sh
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/refresh-race-probe.ts
```

Result (`refresh-race-probe-9ec567c.txt`): the same refresh token submitted twice returned `200` and
`200` with distinct refresh tokens and two session IDs, neither equal to the original. Afterwards the
original token was rejected (`401`) while **both** successor tokens still worked. So a reused token
does not invalidate the family; the documented "single-use, rotating" promise
(`SECURITY.md:64`, `API.md:135`) holds only for sequential use. Reuse detection is absent, so a
stolen refresh token replayed in parallel with the legitimate client yields a working parallel
session rather than a revoked family.

Limits: one process, in-memory SQLite, deliberately synchronised reads; PostgreSQL uses the same
read-then-update shape but was not exercised for this race, and network timing decides whether a real
pair of bindings overlaps. R05 owns the token-lifecycle decision (whether to add an atomic
conditional-consumption update, reuse detection and family revocation), R07 the security-impact
assessment, R03 the cross-driver atomicity review, and R09/R11 the client-side coordination.

## Handoff

| ARC                    | Primary               | Question                                                                     |
| ---------------------- | --------------------- | ---------------------------------------------------------------------------- |
| ARC-053 (client retry) | R09, R11 with R05/R07 | Dedupe or serialise refreshes; define behaviour for the losing request.      |
| ARC-054 (server race)  | R05, R07 with R03     | Atomic single-use consumption, reuse detection, family revocation, evidence. |

No client or server change is made by R01 here; no user-facing sign-out, incident, token theft or
production behaviour is claimed. The `sessionId` asymmetry and error-detail divergence are recorded
as observations for R09/R11/R04, not as separate findings.
