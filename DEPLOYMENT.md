# Deployment

How the platform goes from a laptop to production.

> **Status:** nothing is deployed yet. This is the plan to execute once `BACK-001`, `DB-001` and the CI pipeline (`FOUND-005`) exist. Hosting provider, region and domain are pending owner decisions (`PRD.json` Q-003).

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
              │ PostgreSQL 16  │   │ Redis 7            │
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

Rules:

- The **same built artefact** is promoted; never rebuild for production.
- Migrations run as a pre-deploy step and must be backwards compatible with the previous release (two-step release for destructive changes).
- Deployments are reversible: the previous image tag stays available.
- Production deploys require a passing CI run and a green staging smoke test.

## 4. Configuration and secrets

Every key is documented in `.env.example`. Production values are injected from a secret manager, never committed.

| Group          | Keys (see `.env.example`)                                                          |
| -------------- | ---------------------------------------------------------------------------------- |
| Runtime        | `NODE_ENV`, `PORT`, `API_BASE_URL`, `LOG_LEVEL`                                    |
| Database       | `DATABASE_URL`, `DATABASE_POOL_SIZE`                                               |
| Cache/queue    | `REDIS_URL`                                                                        |
| Auth           | `JWT_SECRET`, `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL`, `ARGON2_*`                  |
| Storage        | `STORAGE_DRIVER`, `S3_*`                                                           |
| AI             | `AI_PROVIDER`, `AI_LOCAL_ENGINE`, `AI_CLOUD_API_KEY`, `AI_MAX_COST_MICROS_PER_DOC` |
| Google         | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`                  |
| Limits         | `MAX_UPLOAD_MB`, `RATE_LIMIT_*`                                                    |
| Observability  | `SENTRY_DSN`, `METRICS_ENABLED`                                                    |
| Mobile/desktop | `API_BASE_URL` baked per build environment, never a secret in the bundle           |

Rotation: JWT signing keys and provider keys rotate on a schedule and immediately on suspected exposure. Rotating the JWT key invalidates access tokens; users re-authenticate or refresh.

## 5. Database deployment

1. Backup / confirm a recent restore point.
2. Run migrations in a transaction where possible; verify with a dry run on staging first.
3. Deploy the new application image.
4. Verify health, logs and key metrics.
5. Keep the previous image for rollback.

Backups: automated daily full + continuous point-in-time recovery (≥ 7 days). Restores are tested quarterly. Restore procedure is documented and rehearsed before the first paying customer.

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

- [ ] `GET /health` returns `ok` for API and dependencies.
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

- **Monitoring:** uptime checks on `/health`, queue depth, job failure rate, extraction latency, connector error rate, auth failure spikes.
- **Alerting:** pager for API down, database saturation, queue backlog over threshold, storage failures, certificate expiry within 14 days.
- **Log retention:** 30 days hot, 12 months archived; never log document content, tokens or personal data.
- **Cost controls:** per-organisation AI spend cap (`AI_MAX_COST_MICROS_PER_DOC`), storage lifecycle rules, alerts on unusual growth.
- **Access:** production access limited to named administrators with MFA; all access audited.

## 11. Go-live checklist (first production release)

- [ ] Hosting, database, storage and Redis provisioned in the approved region.
- [ ] Domain, DNS, TLS and email authentication configured.
- [ ] All secrets in the secret manager; none in the repository.
- [ ] Migrations applied; seed data excluded from production.
- [ ] Backups configured and a restore tested.
- [ ] CI green; staging smoke test passed.
- [ ] `SECURITY.md` §13 checklist complete.
- [ ] Monitoring and alerts verified by triggering a test alert.
- [ ] Privacy policy, terms and app-store disclosures published.
- [ ] Support contact and incident process agreed.
- [ ] `PRD.json`, `CHANGELOG.md` and `AGENT_STATE.md` updated with the release.
