# API key HTTP scope policy

The current HTTP policy is an explicit allowlist in `apps/backend/src/http/api-key-policy.ts`.
An API key is denied for any route/method not listed below, even a key with `admin`. The API
checks the key before parsing the body on `/api/v1` registered routes, including routes that are
otherwise public; omit the API-key header when calling a public route. The root health endpoint is
public and outside this hook. HEAD is treated like GET where the server registers HEAD. Query strings
and concrete path values do not select permissions: the matched route template does.

A key must include the listed scope or `admin`; multiple scopes are a union, not a substitution
between unrelated operations. `admin` authorizes only routes in this table, subject to the creator's
live membership and the endpoint's other role and state checks. The effective role comes from the
scope applicable to that route, capped by the creator's live membership; unrelated scopes do not
raise it. A `documents:read` key does not gain write access by including `connectors:write`.
Existing credential precedence applies: a valid device credential is chosen before an API key;
a supplied API key is chosen before a bearer token. Do not send multiple credential types.

| Required scope     | Methods and routes (all prefixed `/api/v1`)                                                                                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `documents:read`   | GET `/documents`, `/documents/:id`, `/documents/:id/file`, `/documents/:id/result`, `/batches`, `/batches/:id`, `/batches/:id/items`, `/batches/:id/results.csv`                                                                                                       |
| `documents:write`  | POST `/documents`, `/documents/:id/reprocess`, `/batches`; DELETE `/documents/:id`                                                                                                                                                                                     |
| `review:write`     | GET `/review/queue`; POST `/documents/:id/review`, `/review/:id/approve`, `/review/:id/reject`, `/review/bulk-approve`; PATCH `/review/:id/fields`                                                                                                                     |
| `exports:read`     | GET `/exports`, `/exports/:id`, `/exports/:id/download`                                                                                                                                                                                                                |
| `connectors:write` | GET `/connectors/types`, `/connectors`, `/connectors/:id/schema`, `/connectors/:id/runs`, `/mapping-profiles`, `/documents/:id/duplicates`; POST `/connectors`, `/connectors/:id/test`, `/mapping-profiles`, `/documents/:id/send`; PATCH and DELETE `/connectors/:id` |
| `admin`            | GET `/workflows`, `/workflows/runs`, `/workflows/runs/:id`; POST `/workflows`, `/workflows/evaluate`, `/workflows/runs/:id/approve`; PATCH and DELETE `/workflows/:id`                                                                                                 |

These permissions are powerful: document write includes soft-deletion and reprocessing; review
write can approve records; connector write can configure destinations and send records; workflow
execution can delete documents. Scopes do not protect data from the operations they explicitly
allow. No scope implies another except `admin` on the listed routes. Export creation, templates,
account/session/privacy actions, realtime, organisation administration, key management and all
other unlisted operations are unavailable to API keys. Key management also requires a signed-in
owner/admin at the service boundary. Use an appropriately authorized interactive session for
unlisted operations rather than expanding a key's privileges without review.

This policy is a breaking change from earlier releases that converted scopes to broad roles and
allowed unrelated routes. Existing integrations may receive 403 even for previously working calls;
review their intended operations and assign the narrowest appropriate scopes, test workflows, and
plan credential rotation. Fence old API binaries during rollout: they do not enforce the allowlist.
The policy is an HTTP boundary, not a general service authorization framework: direct service calls,
injected actors, devices, old binaries and external writers require separate controls. In-flight
requests can continue after a role, scope, expiry or revocation change; historical effects are not
repaired. Product/security review of this matrix and complete authorization review remain open.
