# Connector subprocess execution

The default backend registry invokes each first-party connector operation, including configuration
validation, in a fresh child process. The packaged backend must include `dist/connector-runner.js`
alongside `dist/server.js` (the backend build and container build provide it). Development runs the
TypeScript entry through `tsx`. The API keeps at most eight child invocations active per service
container; a busy limit fails the request instead of queueing it. Each operation has a 60-second
limit, a 2 MiB serialized request limit, a 2 MiB response limit and a 128 MiB V8 heap limit. These
are fixed code limits, not a resource quota on a host or deployment. Failed, killed, timed-out or
invalid child responses are translated to generic connector errors. A timeout or crash may occur
**after** a destination has changed: inspect the destination before retrying a write.

The child receives no inherited environment variables, including proxy, locale, custom CA and Node
configuration variables. Deployments relying on these variables for connector connectivity may
need changes; do not disable TLS verification to work around a failure. Credentials and mapped
records are sent to the selected child over its standard input, not command-line arguments, but
remain visible to code with appropriate access to that process or its memory. Child standard error
is discarded, and connector-provided diagnostics are not forwarded. This reduces diagnostic detail.
Each operation starts a fresh process, so expect additional latency and load. Configurations or
schema responses over the limits now fail. Code that explicitly injects a registry through
`buildServices` can still execute connector functions in the backend process.

**This is not a security sandbox or a guarantee that connectors cannot crash the host.** The child
uses the same operating-system identity and privileges as the API, can access its filesystem and
network, and can signal its parent. The heap limit does not bound native memory, CPU, child-created
processes or host-wide resources. SIGKILL on timeout does not prove that descendants or external
operations stopped. A malicious or compromised connector can bypass the supplied logger or exploit
other privileges. `connector-process-security.test.ts` demonstrates a same-privilege child killing
a disposable API host. Do not run untrusted connector code under this boundary; use separately
enforced isolation and egress controls after they are designed and validated. SQL and filesystem
connectors have additional risks described in `connector-network-security.md`.

Focused tests cover real subprocess crashes, malformed and oversized output, timeouts, concurrency,
environment filtering, an API health request with a synthetic fatal child, and a CSV connector using
synthetic local data. They do not demonstrate vendor connectivity, complete resource isolation,
exactly-once effects, or all operating systems. The existing test that injects a connector directly
into the host still demonstrates that an explicitly in-process registry can terminate it.
