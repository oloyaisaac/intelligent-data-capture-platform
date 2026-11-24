# R01 T-04: two-replica API behaviour, observed

**Test as written** (`docs/reviewers/R01-software-architect.md` §10):

> **T-04** Run two API processes; exercise sign-in, upload, SSE. Pass criterion: document every
> behaviour that differs from single-process (rate limits reset per process, SSE only delivers from the
> emitting process).

The criterion expects two specific differences. Both are now **confirmed against live processes**
rather than inferred from source. Baseline `9ec567c`; two backend processes, one SQLite file, no
workers, no external service. Transcript: `two-replica-9ec567c.txt`.

```sh
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/two-replica-probe.ts
```

## 1. Rate limiting is per process, so replicas multiply the budget

Configured `RATE_LIMIT_AUTH_PER_15_MIN=3`. The same account was attacked with four failed logins per
replica:

| Replica | Responses              |
| ------- | ---------------------- |
| A       | 401, 401, 401, **429** |
| B       | 401, 401, 401, **429** |

**Six** attempts were accepted across the pair against a configured budget of three, and the second
replica was not aware of the first replica's rejections. `AttemptLimiter` holds its counters in
process memory (`container.ts:441-447`, `Date.now` injected, no shared store), so the effective
authentication budget is `limit × replicas` and is reset by every deploy, restart and autoscale event.

This is the intended semantics of an in-memory limiter, and the brief anticipated it. What the
observation adds is the size of the gap: at three replicas an attacker gets three times the documented
attempts, and an operator reading `RATE_LIMIT_AUTH_PER_15_MIN=5` in `DEPLOYMENT.md` would reasonably
expect five _per account and address_, not five per pod. ARC-051 records that the upload limit is
applied to the wrong action; this is a second, independent reason the limiter cannot be described as
a security control in a multi-replica deployment.

## 2. SSE delivers only from the publishing process

A stream was opened on replica A with a real registered account and a real bearer token; a pairing
session was then created through replica B, which publishes `device:paired` through its hub. Replica
A's stream received its own connection frame and **no** cross-replica event.

`InMemoryRealtimeHub` keeps a `Set` of subscribers in process memory (`realtime/hub.ts:45-49`) and
there is no Redis/pub-sub adapter — the header comment says so explicitly and `DEC-006` records that
the Socket.IO adapter was never built. So the SSE stream is a single-process feature: a client
attached to replica A never learns about work performed by replica B.

For a load-balanced deployment this is worse than cosmetic. `document:extracted` and
`document:needs_review` published by the replica that ran the extraction reach only the clients
attached to it, so a reviewer may never be told a document is waiting, and the UI has no polling
fallback in the desktop shell. This is the concrete mechanism behind ARC-058's second half and the
state-inventory row for the hub; it belongs with ARC-021 (multi-replica behaviour) for the deployment
decision.

## What T-04 justifies, and what it does not

It justifies recording both differences as **observed**, not predicted, and it closes the "actual
replica observation" item that `completion-status.md` listed as outstanding. It does **not** make
either behaviour a new finding requiring its own fix: rate limiting per process is ordinary for an
in-memory limiter, and SSE locality is a known consequence of a deliberately unbuilt adapter. Both are
inputs to decisions already owned elsewhere — R07/R15 for limiter semantics, R02/R03/R19 for whether a
shared bus is required or the deployment is single-writer.

## Method notes

- Ports 4300/4301, `WORKER_ENABLED=false` so claim contention does not confound the result; T-03 covers
  the worker case.
- `HOST=127.0.0.1` is correct here: the probe runs _inside_ the sandbox, not in the user's browser.
- Sign-in was genuinely exercised (registration, login with a wrong password to consume budget, and a
  real pairing session), rather than simulated. **Upload was not exercised** — that needs a storage
  backend and a document fixture, and the upload path's replica-sensitive behaviour is already covered
  by the storage/atomicity evidence in ARC-018. That gap is stated rather than glossed.
- An earlier version of this probe read a non-existent health route and used a deliberately invalid
  token for the stream; the first produced connection failures, the second a 401 instead of a stream.
  Both were probe errors, corrected before any result was recorded.
