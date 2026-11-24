# R01 P8 evidence: what the connector boundary actually contains

**Purpose:** P8 says "connectors cannot crash the host process". The existing test
(`connector-process-security.test.ts`) proves the negative case — a same-privilege child sends `SIGTERM`
to its parent and the host dies. This note records the rest of the matrix, so the gate has a complete
picture rather than one adversarial case. Baseline `9ec567c`; disposable hosts, synthetic scripts, no
external service.

`connector-isolation-probe.ts` drives the real `ConnectorProcess` transport (3000 ms timeout, 4 KiB
input and output caps) through five child behaviours. Output verbatim in
`connector-isolation-probe-9ec567c.txt`.

| #   | Child behaviour                         | Host outcome                                     | Containment verdict                                                |
| --- | --------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| 1   | Sends `SIGTERM` to its parent           | Host dies, `signal=SIGTERM`, 182 ms              | **Not contained** — P8's core claim fails                          |
| 2   | Exits, leaving an unref'd descendant    | Host exits 0, 161 ms; descendant did not survive | Contained in this case; group kill is best-effort, not a guarantee |
| 3   | Writes a file outside its own directory | Host exits 0, 152 ms; **file created**           | **Not contained** — same OS identity, full filesystem              |
| 4   | Never answers, leaves the pipe open     | Host exits 0 after 3124 ms                       | Contained by the timeout (+ rejection), 124 ms over budget         |
| 5   | Emits 1 MiB against a 4 KiB output cap  | Host exits 0, 194 ms                             | Contained: the cap rejects and the slot is released                |

## What this establishes

The transport does its declared job. A child that hangs is cancelled on schedule, a child that floods
stdout is cut off at the cap, and in both cases the host survives with a rejected promise rather than
a crash. Combined with the existing tests (an exiting child, a fatal child, an invalid response), the
_transport-level_ failure handling is genuinely good.

What it cannot do is contain a hostile child, and that is the actual P8 question. Cases 1 and 3 are the
two shapes that matter for a future Marketplace: a same-privilege process can end its host and can
write anywhere the host can. The empty environment, the 128 MiB heap cap and the process-group signal
raise the cost of an accident; they are not an isolation boundary against intent, which
`ARCHITECTURE.md` §2.4 already states and `docs/connector-process.md` repeats.

**P8 remains unmet**, and the phrasing matters: it cannot be met by improving this transport. Meeting
it requires an enforced boundary — a separate container/namespace, a seccomp/AppArmor profile, a
network and filesystem policy, and a broker for the effects a connector legitimately needs. R15 and
R07 own that design; R19 owns whether any deployment can enforce it. R01 records the matrix so the
gate is not deciding on a single test.

## Probe defects found and fixed (recorded because they change the first results)

The first two runs produced wrong conclusions, and neither was a finding about the product:

1. The probe initially pointed the existing host fixture at a replacement child script through an
   environment variable the fixture never reads, and did not send the IPC `start` message it waits
   for. Every case reported "host did not exit", which would have read as a hang.
2. A second version used a purpose-built host that kept an open handle after the invocation settled,
   so the host again never exited — while `ConnectorProcess` had already produced its verdict. Cases
   2–5 were misreported as timeouts until the host flushed its verdict and exited itself.

Both are test-harness bugs, not product behaviour. They are listed here because the difference between
"the transport hung" and "my fixture never terminated" is exactly the kind of error this review exists
to catch — including in itself. The saved transcript is from the corrected run only.
