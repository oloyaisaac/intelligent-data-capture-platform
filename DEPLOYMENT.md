# Deployment

How the platform goes from a laptop to production.

> **Status:** no shared deployment is evidenced here. The PostgreSQL-backed Compose build and
> health smoke passed in [CI at `fcc6206`](https://github.com/oloyaisaac/intelligent-data-capture-platform/actions/runs/44549442653),
> but this does not prove a production deployment, restore, real OCR quality or released artefacts.
> Hosting provider, region and domain remain owner decisions (`PRD.json` Q-003).

---

## 1. Environments

| Environment | Purpose                                           | Data                    | Access                  |
| ----------- | ------------------------------------------------- | ----------------------- | ----------------------- |
| Local       | Development                                       | Synthetic fixtures only | Developer machine       |
| Staging     | Pre-release verification, app-store review builds | Synthetic or anonymised | Team, protected by auth |
| Production  | Live customers                                    | Real customer data      | Restricted, audited     |

Environments never share credentials, databases, storage buckets or API keys. Staging must never contain un-anonymised production documents.

## 2. Target infrastructure

This diagram is aspirational, not the supported deployment: Redis, distributed worker ownership,
shared rate limiting and object storage are not implemented. See `ARCHITECTURE.md` §7 before
planning scale-out; the following diagram is not a validated implementation plan.

```
                     DNS (api.<domain>, app.<domain>)
                                   │
                     ┌─────────────▼──────────────┐
                     │ CDN / TLS / WAF / rate     │
                     │ limiting at the edge       │
                     └─────────────┬──────────────┘
                                   │
                   ┌───────────────▼────────────────┐
                   │ API service (stateless, N×)    │
                   │ containerised, autoscaled      │
                   └───────┬──────────────┬─────────┘
                           │              │
              ┌────────────▼───┐   ┌──────▼─────────────┐
              │ PostgreSQL 16* │   │ Redis 7*           │
              │ managed, PITR  │   │ queue + rate limit │
              └────────────────┘   └──────┬─────────────┘
                                          │
                             ┌────────────▼─────────────┐
                             │ Worker pool (N×)          │
                             │ OCR · extract · connectors│
                             └────────────┬─────────────┘
                                          │
                     ┌────────────────────▼──────────────────┐
                     │ Object storage (private, SSE;         │
                     │ lifecycle rules: exports 7d,          │
                     │ originals per retention policy)       │
                     └───────────────────────────────────────┘
```

External services requiring accounts and keys: AI/OCR provider(s), Google Cloud (Sheets OAuth), email/SMS provider, push notifications, error tracking, app-store developer accounts (Apple, Google Play).

## 3. Build and release pipeline

```
push / PR → CI: install → typecheck → lint → test → build → Docker Compose/PostgreSQL smoke test
        → merge to main
        → build immutable image (tagged with commit SHA)
        → deploy to staging → smoke tests → manual verification
        → promote same image to production → health check → monitor
```

CI now validates `docker-compose.yml`, builds the backend image, starts PostgreSQL, runs the image's
migration service, and checks the API health endpoint. The job has passed in CI for the cited
commit; each new release must still pass its own checks. CI does **not** publish an image or deploy
it; those release stages depend on the hosting-provider decision. A release is
therefore still a manual operation on the target host (§4).

Rules:

- The **same built artefact** is promoted; never rebuild for production.
- Migrations run as a pre-deploy step and must be backwards compatible with the previous release (two-step release for destructive changes).
- Deployments are reversible: the previous image tag stays available.
- Production deploys require a passing CI run and a green staging smoke test.

## 4. Configuration and secrets

Backend configuration keys are documented in `.env.example`, with a parity test against the server
schema (`apps/backend/test/config.test.ts`). Production values should be injected from a secret manager, never
committed. There is no Redis or object-store key because the shipped runtime has neither — see
DEC-029 for the order in which they arrive.

**SQLite development/standalone mode (DEC-029).** One process on one host owns `SQLITE_PATH` (the
database) and `STORAGE_PATH` (documents and exports). Run it under a supervisor that restarts on
failure and forwards `SIGTERM` — `systemd`, Docker with `--restart`, or a platform process manager. Do
not run more than one replica against a SQLite file: the worker claims jobs transactionally, but two
SQLite writers are not a supported topology.

**Single-host PostgreSQL Compose path.** `docker-compose.yml` configures one API/worker container,
PostgreSQL 16, a one-shot migration service, and a persistent filesystem document volume. The
image includes Tesseract English data for the default local OCR provider. The cited CI built and
smoke-tested this path; it is not a production deployment or evidence of OCR quality. It is intended
for one instance, not horizontal scaling. Managed PostgreSQL, shared object storage/queue, backup
automation, image publishing, and provider-specific deployment remain future work.

To try it, copy `.env.compose.example` to `.env.compose`, replace the example origins and all three
sample secrets with distinct random values, then run from the repository root. The JWT and
`ENCRYPTION_KEY` examples are known development defaults and are rejected by production startup:

```sh
cp .env.compose.example .env.compose
chmod 600 .env.compose
# Edit .env.compose: use separate `openssl rand -hex 32` values for POSTGRES_PASSWORD,
# JWT_SECRET and ENCRYPTION_KEY.
# The database password is interpolated into DATABASE_URL, so keep it URL-safe (hex is safe).
docker compose --env-file .env.compose config --quiet
docker compose --env-file .env.compose up --build --detach
curl --fail http://127.0.0.1:4000/api/v1/health
docker compose --env-file .env.compose logs --follow api
```

The API port binds to `127.0.0.1` by default; put a TLS-terminating reverse proxy in front of it and
configure it to overwrite forwarded client-IP headers (`TRUST_PROXY=true`). `CORS_ORIGINS` must list
the actual web app origin and `app://idcp` for packaged Electron clients. Do not expose the API
without TLS. `docker compose down` preserves the named database and document volumes; **do not use
`docker compose down --volumes` on a deployment** unless you intend to delete that data. Keep
`.env.compose` outside version control and use a secret manager for a real production host.

Startup and migration/seed command failures print generic diagnostics rather than raw exception text,
which can contain database credentials or paths. If startup fails, inspect configuration, database
connectivity and migration state using approved operational tools; avoid copying secrets into logs or
incident reports. Historical logs are not changed by this behavior.

On `SIGTERM`/`SIGINT`, shutdown waits for active maintenance and claimed worker work before
closing the HTTP server and database. There is no application shutdown deadline; configure the
supervisor's grace period accordingly. A forced kill may interrupt work. Startup no longer requeues
running jobs automatically: interrupted claims remain running until an operator reviews and requeues
or abandons them with every worker stopped. Follow `docs/worker-recovery.md`. Old binaries retain the unsafe
age-only behavior, so do not allow them to restart. Offline retry can repeat external effects; do not
run overlapping replicas or assume automatic recovery or exactly-once execution. See
`ARCHITECTURE.md` and R01 findings ARC-013/ARC-021.

| Group         | Keys (see `.env.example`)                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime       | `NODE_ENV`, `PORT`, `API_BASE_URL`, `LOG_LEVEL`, `APP_ORIGIN`, `CORS_ORIGINS`                                                                                             |
| Database      | `DB_DRIVER`, `SQLITE_PATH`, `DATABASE_URL`, `DATABASE_POOL_SIZE`                                                                                                          |
| Auth          | `JWT_SECRET`, `ENCRYPTION_KEY`, `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_SECONDS`, `PAIRING_TOKEN_TTL_SECONDS`, `INVITATION_TTL_SECONDS`                            |
| Storage       | `STORAGE_DRIVER` (`filesystem` today), `STORAGE_PATH`                                                                                                                     |
| AI            | `AI_PROVIDER`, `AI_LOCAL_ENGINE`, `TESSERACT_BIN`, `AI_CLOUD_MODEL`, `AI_CLOUD_ENDPOINT`, `AI_CLOUD_API_KEY`, `AI_MAX_COST_MICROS_PER_DOC`, `AI_MAX_REMOTE_CALLS_PER_DOC` |
| Limits        | `MAX_UPLOAD_MB`, `MAX_REQUEST_MB`, `RATE_LIMIT_ENABLED`, `RATE_LIMIT_*`                                                                                                   |
| Exports, jobs | `EXPORTS_TTL_SECONDS`, `WORKER_ENABLED`, `WORKER_POLL_INTERVAL_MS`                                                                                                        |
| Desktop build | `API_BASE_URL` baked into the desktop release artefact (public URL, never a secret); production `CORS_ORIGINS` must include `app://idcp`                                  |

This table is a selection, not an exhaustive list. The Compose file forwards only the variables
listed in its `environment` mapping; setting another key in `.env.compose` does not automatically
pass it to the container. Inspect the mapping and configure any additional settings explicitly.

Rotation: Before rotating `JWT_SECRET`, follow [the offline encryption-key migration runbook](docs/encryption-key-migration.md) and verify no connector credentials or MFA secrets still depend on the old JWT key. Rotating it too early can make those records unreadable. Rotation invalidates access tokens; users re-authenticate or refresh. Provider keys also require a managed rotation process.

## 5. Database deployment

1. Verify a backup and restore procedure; rehearse the release on staging.
2. Stop or fence old API and worker processes. Migrations run automatically at startup; use one
   controlled current-version migrator before starting the new application. The current runner uses
   a transaction and a same-schema PostgreSQL advisory lock (or SQLite write lock), but old
   binaries do not participate and lock contention can time out.
3. Deploy the new application image and verify health, logs and key metrics.
4. Keep the previous image, but do not assume it is safe to run against a migrated schema. Review
   release-specific data and protocol compatibility before rollback.

If migration or commit outcome is uncertain, stop and have the database owner inspect the schema and
migration ledger against a recovery plan before retrying or changing markers. Historical partial
migrations are not automatically repaired; the current locking protocol does not fence manual or
older writers. See R01 ARC-043.

**Backups.** For single-host SQLite and filesystem storage, use the [offline backup and restore
runbook](docs/backup-restore.md). Stop all writers for the entire snapshot, and restore the database
and files together. The tool includes committed WAL data, checks hashes and SQLite integrity, and
refuses to overwrite a destination. It does not encrypt, schedule or transfer backups, save secrets,
or establish that every referenced file exists. The operator must provide those controls and test
recovery with matching encryption keys.

For PostgreSQL (including Compose), the SQLite tool does not apply: use tested PostgreSQL snapshots
or `pg_dump` and a coordinated document-volume backup; use provider PITR where available. Backup
and restore automation for that deployment remains an operator responsibility.

Rehearse restores at least quarterly and before the first paying customer. A restore is not
"done" until `GET /api/v1/health` returns `ok`, a login succeeds and a document downloads from
`STORAGE_PATH`: the database and the files must be restored together or records point at files that
no longer exist.

## 6. Domain, DNS and TLS

1. Register the domain (pending Q-003) and point nameservers at the DNS provider.
2. Records: `api.<domain>` → API load balancer, `app.<domain>` → web/download pages, `*.cdn.<domain>` if used.
3. TLS certificates issued and auto-renewed by the platform; force HTTPS redirects; HSTS after verification.
4. Email authentication (SPF, DKIM, DMARC) configured for transactional mail.
5. App-store builds use the same public API host — never a staging host.

## 7. Desktop and mobile distribution

**Desktop (Electron)**

1. Set `API_BASE_URL` to the deployment's public API base (for example `https://api.example.com/api/v1`) before packaging. The build validates and embeds this public URL in `dist-electron/api-config.json`; it is not a credential. `npm run package --workspace @idcp/desktop` fails rather than producing an installer without a valid URL. Loopback HTTP is accepted only for local development packages; non-loopback hosts must use HTTPS.
2. Set the backend's production `CORS_ORIGINS` to include `app://idcp` (plus any browser origins that are actually used). The desktop renderer's custom `app://idcp` origin is sent by Chromium on API requests.
3. Build per platform (Windows `.exe`/`.msi`, macOS `.dmg`, Linux `.AppImage`/`.deb`).
4. Sign (Authenticode on Windows; Developer ID + notarisation on macOS).
5. A signed release/update channel and manifest verification still need to be implemented and
   tested before distribution. The current desktop update check is a placeholder; `IDCP_AUTO_UPDATE=off`
   disables it, but does not provide a complete updater.

**Mobile**

- Android: signed AAB uploaded to Google Play (internal → closed → production tracks).
- iOS: signed archive uploaded to App Store Connect via TestFlight, then review.
- Each release: bump version/build number, update privacy disclosures, run the `TESTING.md` release checklist.
- Over-the-air JS updates (if adopted) require a decision and must never bypass store review for feature changes.

## 8. Post-deployment verification

- [ ] `GET /api/v1/health` returns `ok` with `dependencies.db: "ok"` (there is no bare `/health`).
- [ ] Login, pairing and upload work against the deployed environment.
- [ ] A document processes end-to-end and appears in review.
- [ ] An export is generated and downloadable.
- [ ] Logs show no errors or secret leakage; `X-Request-Id` is propagated.
- [ ] Metrics: queue depth flat, error rate < 1%, p95 job latency within target.
- [ ] Audit log receives entries for the smoke-test actions.

## 9. Rollback

1. Roll back the application to the previous image tag.
2. Migrations are forward-only; there is no documented down-migration. For incompatible data changes,
   use a tested, coordinated database and document-storage restore from the pre-deploy backup, with
   the appropriate keys. Assess data loss and stop writers before restoring.
3. If a release channel is established, follow its tested rollback procedure; no signed
   auto-update release channel is implemented or verified here.
4. Communicate to affected users; record the incident in `CHANGELOG.md` and, if architectural, `DECISIONS.md`.

## 10. Operations

**What the application gives an operator today**

- `GET /api/v1/health` — `200` with `dependencies.db: "ok"`, or `503` with `"error"`. Suitable for an
  uptime check and for a supervisor's readiness probe.
- Structured JSON logs on stdout (`time`, `level`, `message`, plus context). Redaction is based on
  context key names and is not comprehensive: arrays, error messages and arbitrary strings may
  contain sensitive data. Do not assume logs are secret- or document-free; control inputs and access
  and review output (`apps/backend/src/logger.ts`).
- `X-Request-Id` on every response, echoed from the request when supplied — correlate a user's report
  with the log line by sending one yourself.
- Application audit trail (`audit_logs`) for privileged actions, queryable through the API.
- Graceful shutdown waits for active worker and maintenance work on `SIGTERM`/`SIGINT`; see the
  recovery and forced-kill limitations in §4.

**What the operator must supply** (none of it exists in this repository yet)

- Uptime check against `/api/v1/health`, alerting on `503`.
- Queue depth and job failures: there is no metrics endpoint, so read them from the database
  (`SELECT status, COUNT(*) FROM jobs GROUP BY status`) or from `job failed` log lines.
- Log shipping and retention (30 days hot, 12 months archived) — logs are stdout only.
- Storage monitoring on `STORAGE_PATH` and `SQLITE_PATH` disk usage; neither is reported by the app.
- Certificate expiry monitoring, MFA on the host and the provider console, and access review.
- Cloud cost controls: `AI_MAX_COST_MICROS_PER_DOC` is required to enable cloud OCR, but only
  triggers a warning on an estimated cost after a request has completed. It is not a spending cap;
  missing usage is treated as zero, pricing is approximate, and there is no cumulative monetary
  per-document or per-organisation budget enforcement. Set provider-side limits and monitor billing.
- `AI_MAX_REMOTE_CALLS_PER_DOC` defaults to 5 (0–1000; 0 stops new current-version remote OCR
  reservations). The worker commits a reservation against the document before calling a nonlocal
  provider. The count persists across retries and reprocesses, and a crash, provider failure or lost
  acknowledgement consumes a reservation even if no request arrived. Exhausted jobs fail through the
  normal finite retry path; a local provider does not consume this count. Inspect the document's
  `remote_ocr_invocations` and configuration under approved access controls before retry decisions.
  This is a call-count bound, **not a monetary cap**: one call can cost an unknown amount, new uploads
  receive new counters, and retries or effects inside a provider are not controlled. Historical calls
  before migration 013 start at an unknown baseline represented by zero; old binaries, direct adapter
  calls, restored older backups, inconsistent worker configuration and out-of-band writers can bypass
  or roll back the count. A zero setting cannot cancel in-flight calls. Avoid mixed versions and use
  consistent configuration; apply migration 013 and validate backups, rollout and rollback before use.
  Cloud requests no longer follow HTTP redirects: configure the final endpoint explicitly.
- `AI_MAX_REMOTE_CALLS_PER_ORG` adds a **lifetime**, per-organisation remote-call reservation cap
  since migration 014. It defaults to 10,000, accepts 0–10,000,000, and never automatically resets;
  zero blocks new current-version remote reservations. Before deployment, set a reviewed value and
  capacity/alerting plan: reaching the cap makes remote jobs retry finitely and eventually fail.
  The job's fixed organisation-limit reason appears in the job failure log and final failure event;
  there is no dedicated alert, and UI display has not been verified. Local OCR is unaffected. Each nonlocal call reserves the
  organisation and document counters together before invoking the provider; failed reservation
  transactions roll both back, while crashes, provider failures and lost acknowledgements consume
  both. Deleting a document does not release the organisation counter. The organisation's deletion
  cascades the counter; a new organisation starts again. No automatic refunds or resets are provided.
  Under approved access controls, inspect `remote_ocr_organisation_counts.invocations` for the
  organisation ID; a missing row means no reservations recorded since migration, not no past calls.
  Raising the environment limit affects every organisation using that worker and requires coordinated
  deployment; lowering it does not cancel already-reserved or running calls. All workers must use the
  same configuration and current code, and migration 014 must be applied before rollout. Direct
  provider calls, old binaries, separate databases, new organisations, out-of-band changes and backup
  restores can bypass or reset accounting. This is **not** a monetary budget, organisation-specific
  price control, time-window quota or provider-side enforcement. Set and verify provider-side spending
  controls and billing alerts; review historical usage and operate backups/rollbacks accordingly.

## 11. Known gaps between this plan and the repository

This is a non-exhaustive operational gap list, not an assertion that all gaps are deliberate or
fully assessed. `AGENT_STATE.md` contains historical claims; consult the dated R01 evidence and the
individual reviewer tasks for current findings.

| Gap                                | Consequence today                                                                                                                                                                                                                                                       | Fix                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No image publish/deploy job or IaC | CI now builds and smoke-tests the Docker Compose stack, but no immutable image is published or deployed (§3)                                                                                                                                                            | Add tagged-image publishing and deployment automation after the hosting-provider decision                                                                |
| Backup operations not automated    | SQLite backup/restore tooling requires stopped writers and manual execution; PostgreSQL and volume backups remain operator-managed (§5).                                                                                                                                | Schedule protected off-host backups and rehearse restores for each deployed driver.                                                                      |
| No metrics endpoint or alerting    | Only logs and the health check; "queue depth" and "p95 latency" are not measured                                                                                                                                                                                        | `/metrics` for queue depth, job outcomes, extraction latency                                                                                             |
| Rate limiting is in-process memory | Resets on restart and does not cover a second instance; `TRUST_PROXY` is right behind the documented proxy, and must be `false` if you expose the API directly (DEC-033)                                                                                                | Shared limiter when a queue/cache exists                                                                                                                 |
| Development dependency advisories  | As of 2026-11-17, `npm audit` reports 6 moderate findings in the Electron packaging dependency chain via `minimatch` (GHSA-g3hv-75wg-m249). `npm audit --omit=dev` reports none and is gated in CI at moderate or above. Counts can change as advisories are published. | Monitor the full audit and upgrade or replace the packaging chain when a compatible fix is available; avoid untrusted glob patterns in packaging inputs. |
| Signed installers not built        | Desktop/mobile distribution is manual (§7)                                                                                                                                                                                                                              | Release workflow per platform (DEC-022)                                                                                                                  |

Additional gaps:

- MFA enrollment, TOTP and one-use recovery codes exist. Loss of all factors lacks a verified
  administrative recovery path; MFA is not a substitute for account recovery controls.
- Maintenance runs in-process. Manual and scheduled purge requests now coalesce under an
  organisation lock, and new claims for existing same-organisation purge jobs serialize, but this
  does not make multiple schedulers generally safe or fence old binaries; use one supported instance
  (DEC-031). Retention is not a complete erasure mechanism:
  it currently skips already soft-deleted documents and separate page files, retains metadata and
  derived records, and cannot atomically coordinate database and storage. A failed or shared primary
  file leaves the job retryable until attempts are exhausted; monitor dead jobs and investigate.
  After a primary file is removed, the conditional metadata soft-delete and a per-document
  `retention.purged` audit commit together. A database/audit failure can leave the file missing while
  the metadata remains active; retries depend on idempotent storage deletion. Audit consumers must
  sum the per-document `count=1` records rather than expect one aggregate record per sweep.
  Known references in documents, pages, exports and template samples across tenants block retention,
  erasure-file and expired-export deletion. Non-canonical deletion targets are refused, and these
  checks also inspect slash/dot path aliases; they fail closed when a source reaches 1,024 potential
  aliases, even without a matching reference. Investigate rather than removing references blindly.
  The checks cannot detect filesystem links or case-insensitive aliases and are not atomic with
  new references or file writes; keys are not protected against reuse. Export row updates are locked
  during expiry, but a failed DB commit or an unguarded later writer can still leave invalid metadata.
  Per-file cross-table and alias lookups can scan entire tables repeatedly while retention/export
  locks are held; measure query plans, lock duration and sweep time on representative data before
  rollout. Historical leaked files need authorized reconciliation, not an assumption that a
  successful job proves deletion. See R01 ARC-024.
- Filesystem and memory writes now create new keys exclusively rather than overwrite existing
  objects. Existing filesystem entries, including final symlinks, cause a safe failure. This relies
  on the backing filesystem's exclusive-create semantics; it does not make storage immutable or
  protect against parent symlinks, untrusted mounts, older binaries, later key reuse, other writers
  or file/database races. Upload failures can leave partial, untracked files.
- New exports reserve their storage key before writing. An uncertain reservation, collision or
  unsuccessful write is left for offline investigation rather than being scheduled for expiry: the
  bytes could be pre-existing or only partially written. This can leave queued rows indefinitely,
  including rows without a key if reservation failed before committing. Failures after a confirmed
  exclusive write can still be marked failed and scheduled for expiry; a committed ready expiry is
  preserved. Monitor and investigate stuck rows; never delete solely because they are old, since a
  writer may still be running. Old orphaned export files, backup copies and the storage/DB race remain.
  Follow authorized incident procedures and stop or fence all writers before reconciliation; see
  ARC-026. `docs/export-inventory.md` provides read-only export-row investigation, and
  `docs/storage-inventory.md` can enumerate entries in selected current-layout filesystem directories,
  including files without rows. Both require offline operational controls and neither is automated
  cleanup or proof that a candidate is safe to remove; filesystem inventory output contains raw keys.
- Playwright exercises browser journeys in CI; native mobile and packaged desktop end-to-end
  tests are not established.
- Worker crash recovery lacks ownership fencing; connector subprocesses are not security-isolated.

Struck off this list in the October 2026 hardening pass: the access log (structured `onResponse`
line), the security headers (`nosniff`, `DENY`, `no-referrer`, CSP, permissions policy, COOP/CORP,
HSTS in production), scheduled retention, and an always-on `trustProxy`. `AUDIT-2026-10.md` records
the reasoning and what is still open.

## 12. Go-live checklist (first production release)

- [ ] Hosting and persistent storage provisioned in the approved region (one instance with a volume
      by default; PostgreSQL, a shared queue and object storage before any horizontal scaling, in
      that order — DEC-029).
- [ ] Domain, DNS, TLS and email authentication configured.
- [ ] All secrets in the secret manager; none in the repository.
- [ ] Migrations applied; seed data excluded from production.
- [ ] Backups configured and a restore tested.
- [ ] CI green; staging smoke test passed.
- [ ] `SECURITY.md` §13 checklist complete.
- [ ] Monitoring and alerts verified by triggering a test alert.
- [ ] Privacy policy, terms and app-store disclosures published. Every `[PLACEHOLDER]` in `legal/`
      replaced (`git grep -n "\[" legal/`), counsel's review recorded, and `npm run test:legal` green.
- [ ] `LEGAL_DIR` points at a directory that actually ships with the deployment — `/legal` returns 404
      for everything otherwise.
- [ ] The controller registration required by Uganda's Data Protection and Privacy Act 2019 filed, and
      the registration number put into `legal/PRIVACY.md`.
- [ ] A named person owns the `[PRIVACY EMAIL]` mailbox and the 72-hour breach-notification duty.
- [ ] Configure SMTP (`MAIL_TRANSPORT=smtp`, `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, and optional
      `SMTP_USER`/`SMTP_PASSWORD`) and verify reset and invitation delivery to a test mailbox.
      Use `SMTP_SECURE=true` for implicit TLS; otherwise STARTTLS is required. `APP_ORIGIN` must be
      the public HTTPS origin for links. When SMTP is disabled, production password resets cannot
      be delivered. API acceptance does not prove final inbox delivery; monitor mail-provider logs.
      Delivery is synchronous and has no durable retry queue. Invite links remain available to the
      administrator for manual sharing if delivery fails.
- [ ] Retention defaults checked against the customers' sector rules; `MAINTENANCE_ENABLED` left on.
- [ ] Support contact and incident process agreed.
- [ ] `PRD.json`, `CHANGELOG.md` and `AGENT_STATE.md` updated with the release.
