# Deployment

How the platform goes from a laptop to production.

> **Status:** the application and CI pipeline exist and run; nothing is deployed to a shared environment
> yet. Local and single-host deployment is documented and works (§4). Hosting provider, region and
> domain are still pending owner decisions (`PRD.json` Q-003).

---

## 1. Environments

| Environment | Purpose                                           | Data                    | Access                  |
| ----------- | ------------------------------------------------- | ----------------------- | ----------------------- |
| Local       | Development                                       | Synthetic fixtures only | Developer machine       |
| Staging     | Pre-release verification, app-store review builds | Synthetic or anonymised | Team, protected by auth |
| Production  | Live customers                                    | Real customer data      | Restricted, audited     |

Environments never share credentials, databases, storage buckets or API keys. Staging must never contain un-anonymised production documents.

## 2. Target infrastructure

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
push / PR → CI: install → typecheck → lint → test → build → security scan
        → merge to main
        → build immutable image (tagged with commit SHA)
        → deploy to staging → smoke tests → manual verification
        → promote same image to production → health check → monitor
```

Today the pipeline stops after `CI`: there is no `Dockerfile`, no image publish and no deploy job in
`.github/workflows/`, so steps 7–10 above are a plan, not automation. A release is currently a manual
`git pull && npm ci && npm run build && npm run db:migrate && systemd restart` on one host (§4).

Rules:

- The **same built artefact** is promoted; never rebuild for production.
- Migrations run as a pre-deploy step and must be backwards compatible with the previous release (two-step release for destructive changes).
- Deployments are reversible: the previous image tag stays available.
- Production deploys require a passing CI run and a green staging smoke test.

## 4. Configuration and secrets

Every key is documented in `.env.example`, and a test keeps that file equal to what the server reads
(`apps/backend/test/config.test.ts`). Production values are injected from a secret manager, never
committed. There is no Redis or object-store key because the shipped runtime has neither — see
DEC-029 for the order in which they arrive.

**Running one instance today (DEC-029).** One process, one host, two directories it owns:
`SQLITE_PATH` (the database) and `STORAGE_PATH` (documents and exports). Run it under a supervisor
that restarts on failure and forwards `SIGTERM` — `systemd`, Docker with `--restart`, or a platform
process manager. Do not run more than one replica against a SQLite file: the worker claims jobs
transactionally, but two SQLite writers are not a supported topology.

`SIGTERM` stops the worker, closes the HTTP server and closes the database. A job interrupted
mid-extraction is re-queued the next time the worker starts (anything claimed more than 30 seconds
before boot), so a restart is safe — the document returns to the queue instead of sitting in
`processing` forever.

| Group          | Keys (see `.env.example`)                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime        | `NODE_ENV`, `PORT`, `API_BASE_URL`, `LOG_LEVEL`, `APP_ORIGIN`, `CORS_ORIGINS`                                                              |
| Database       | `DB_DRIVER`, `SQLITE_PATH`, `DATABASE_URL`, `DATABASE_POOL_SIZE`                                                                           |
| Auth           | `JWT_SECRET`, `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_SECONDS`, `PAIRING_TOKEN_TTL_SECONDS`, `INVITATION_TTL_SECONDS`               |
| Storage        | `STORAGE_DRIVER` (`filesystem` today), `STORAGE_PATH`                                                                                      |
| AI             | `AI_PROVIDER`, `AI_LOCAL_ENGINE`, `TESSERACT_BIN`, `AI_CLOUD_MODEL`, `AI_CLOUD_ENDPOINT`, `AI_CLOUD_API_KEY`, `AI_MAX_COST_MICROS_PER_DOC` |
| Google         | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`                                                                          |
| Limits         | `MAX_UPLOAD_MB`, `MAX_REQUEST_MB`, `RATE_LIMIT_ENABLED`, `RATE_LIMIT_*`                                                                    |
| Exports, jobs  | `EXPORTS_TTL_SECONDS`, `WORKER_ENABLED`, `WORKER_POLL_INTERVAL_MS`                                                                         |
| Mobile/desktop | `API_BASE_URL` baked per build environment, never a secret in the bundle                                                                   |

Rotation: JWT signing keys and provider keys rotate on a schedule and immediately on suspected exposure. Rotating the JWT key invalidates access tokens; users re-authenticate or refresh.

## 5. Database deployment

1. Backup / confirm a recent restore point.
2. Run migrations in a transaction where possible; verify with a dry run on staging first.
3. Deploy the new application image.
4. Verify health, logs and key metrics.
5. Keep the previous image for rollback.

**Backups.** There is no backup script in this repository yet; the operator owns this step, and it
differs by driver:

| Driver                            | Correct backup                                                                                                                                                             | Notes                                                                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite (today)                    | `sqlite3 local-storage/idcp.db "VACUUM INTO '/backups/idcp-$(date +%F).db'"` while the server runs, or copy the `.db` **and** `-wal`/`-shm` files with the process stopped | Copying only `idcp.db` while WAL is active loses recent writes. Point-in-time recovery is not available on SQLite — take a snapshot at least daily and keep ≥ 7. |
| PostgreSQL (after DEC-029 step 1) | Provider snapshots plus WAL archiving (PITR)                                                                                                                               | Then the original "daily full + PITR" applies.                                                                                                                   |

Restores are tested quarterly and rehearsed before the first paying customer. A restore is not
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

1. Build per platform (Windows `.exe`/`.msi`, macOS `.dmg`, Linux `.AppImage`/`.deb`).
2. Sign (Authenticode on Windows; Developer ID + notarisation on macOS).
3. Publish to the release channel; auto-update manifest served over HTTPS with signature verification.
4. Support a `--no-auto-update` flag or config for controlled deployments.

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
2. Roll back the database only with the documented down-migration — or restore from the pre-deploy backup if data changed incompatibly.
3. Roll back the auto-update channel by unpublishing the release and keeping the previous manifest.
4. Communicate to affected users; record the incident in `CHANGELOG.md` and, if architectural, `DECISIONS.md`.

## 10. Operations

**What the application gives an operator today**

- `GET /api/v1/health` — `200` with `dependencies.db: "ok"`, or `503` with `"error"`. Suitable for an
  uptime check and for a supervisor's readiness probe.
- Structured JSON logs on stdout (`time`, `level`, `message`, plus redacted context). Secrets, tokens,
  document text and field values are redacted by key (`apps/backend/src/logger.ts`).
- `X-Request-Id` on every response, echoed from the request when supplied — correlate a user's report
  with the log line by sending one yourself.
- Application audit trail (`audit_logs`) for privileged actions, queryable through the API.
- Graceful shutdown on `SIGTERM`/`SIGINT`, and interrupted jobs are re-queued on the next start.

**What the operator must supply** (none of it exists in this repository yet)

- Uptime check against `/api/v1/health`, alerting on `503`.
- Queue depth and job failures: there is no metrics endpoint, so read them from the database
  (`SELECT status, COUNT(*) FROM jobs GROUP BY status`) or from `job failed` log lines.
- Log shipping and retention (30 days hot, 12 months archived) — logs are stdout only.
- Storage monitoring on `STORAGE_PATH` and `SQLITE_PATH` disk usage; neither is reported by the app.
- Certificate expiry monitoring, MFA on the host and the provider console, and access review.
- Cost controls: `AI_MAX_COST_MICROS_PER_DOC` caps a single document; there is no per-organisation
  spend total, alert or dashboard.

## 11. Known gaps between this plan and the repository

Ordered by what would hurt first. Everything here is deliberate and listed in `AGENT_STATE.md`;
none of it is a bug the code hides.

| Gap                                             | Consequence today                                                                                                                                                        | Fix                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| No `Dockerfile`, image build, deploy job or IaC | Releases are manual on one host (§3)                                                                                                                                     | Add an image build + publish step, then the pipeline above        |
| No backup or restore script                     | Losing the host loses the database **and** the documents; the operator must schedule `VACUUM INTO` themselves (§5)                                                       | Ship `npm run db:backup` + a restore test                         |
| No metrics endpoint or alerting                 | Only logs and the health check; "queue depth" and "p95 latency" are not measured                                                                                         | `/metrics` for queue depth, job outcomes, extraction latency      |
| Rate limiting is in-process memory              | Resets on restart and does not cover a second instance; `TRUST_PROXY` is right behind the documented proxy, and must be `false` if you expose the API directly (DEC-033) | Shared limiter when a queue/cache exists                          |
| No MFA                                          | A stolen password is a full session                                                                                                                                      | TOTP plus recovery codes, and an admin reset path                 |
| Automation is in-process                        | `MaintenanceService` (DEC-031) sweeps retention, exports, sessions, reset tokens and pairing codes. With several replicas every replica sweeps — idempotent, redundant   | Move behind a single elector before horizontal scaling (DEC-029)  |
| No dependency vulnerability scan in CI          | `npm audit` reports 9 advisories (1 critical via `shell-quote`; `zod` and `image-size` high) but CI does not fail on them                                                | Audit job once the upgrades land; `zod` needs a v3 → v4 migration |
| Signed installers not built                     | Desktop/mobile distribution is manual (§7)                                                                                                                               | Release workflow per platform (DEC-022)                           |
| No browser or device e2e                        | Integration tests cover the API, nothing covers a real click path                                                                                                        | Playwright (desktop), Detox or Maestro (mobile)                   |

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
- [ ] Because this build sends no email, an operator procedure exists for delivering password-reset
      links (`POST /auth/password/forgot` returns `resetUrl` outside production only — DEC-030).
- [ ] Retention defaults checked against the customers' sector rules; `MAINTENANCE_ENABLED` left on.
- [ ] Support contact and incident process agreed.
- [ ] `PRD.json`, `CHANGELOG.md` and `AGENT_STATE.md` updated with the release.
